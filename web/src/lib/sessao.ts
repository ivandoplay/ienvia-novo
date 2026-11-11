import 'server-only';

import { cache } from 'react';
import { emailParaUsuario } from '@ienvia/shared';
import { dominioDeUsuario } from '@/lib/env';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export type Papel = 'owner' | 'operator';

export interface WorkspaceDaSessao {
  id: string;
  nome: string;
  papel: Papel;
  /** Quantos chips esta conta pode ter (definido pelo administrador da plataforma). */
  limiteDeChips: number;
}

export interface Sessao {
  usuario: {
    id: string;
    /** O que a pessoa digita para entrar: "joao" ou "maria@empresa.com". */
    login: string;
    /** Nome para exibir; cai no login quando o perfil ainda não tem nome. */
    nome: string;
  };
  /** Workspaces (contas de cliente) em que a pessoa participa. */
  workspaces: WorkspaceDaSessao[];
  /**
   * Workspace aberto agora: o mais antigo de que a pessoa participa.
   * `null` quando ela ainda não participa de nenhum.
   * (Trocar de workspace entra na Fase 7, junto com o modo suporte.)
   */
  workspaceAtivo: WorkspaceDaSessao | null;
  /** Administrador da plataforma (enxerga a área "Clientes SaaS"). */
  ehMaster: boolean;
  /**
   * `true` quando o login valeu, mas a leitura das empresas falhou (banco fora do ar, por exemplo).
   * Serve para a tela não dizer "você não tem workspace" quando o problema é outro.
   */
  falhouAoCarregar: boolean;
}

interface WorkspaceBruto {
  id: string;
  name: string;
  status: string;
  max_instances: number | null;
}

interface LinhaDeParticipacao {
  role: Papel;
  /** O Supabase devolve um objeto aqui; por garantia aceitamos também uma lista de um item. */
  workspaces: WorkspaceBruto | WorkspaceBruto[] | null;
}

/**
 * Quem está logado e em qual workspace.
 * `cache` garante uma única ida ao banco por requisição, mesmo que várias partes
 * da página chamem esta função.
 */
export const obterSessao = cache(async (): Promise<Sessao | null> => {
  const supabase = await criarClienteServidor();

  const { data: autenticacao, error: erroDeAutenticacao } = await supabase.auth.getUser();
  const usuario = autenticacao.user;
  if (erroDeAutenticacao || !usuario) return null;

  const [participacoes, perfil, master] = await Promise.all([
    supabase
      .from('workspace_memberships')
      .select('role, workspaces(id, name, status, max_instances)')
      .eq('user_id', usuario.id)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .returns<LinhaDeParticipacao[]>(),
    supabase.from('profiles').select('display_name').eq('id', usuario.id).maybeSingle<{ display_name: string }>(),
    supabase.rpc('is_my_platform_master'),
  ]);

  // Uma falha aqui não pode passar por "conta sem workspace" sem deixar rastro.
  if (participacoes.error) console.error('[sessão] não foi possível ler as participações:', participacoes.error);
  if (perfil.error) console.error('[sessão] não foi possível ler o perfil:', perfil.error);
  if (master.error) console.error('[sessão] não foi possível conferir o administrador:', master.error);

  const workspaces: WorkspaceDaSessao[] = [];
  for (const linha of participacoes.data ?? []) {
    const workspace = Array.isArray(linha.workspaces) ? linha.workspaces[0] : linha.workspaces;
    if (workspace && workspace.status === 'active') {
      workspaces.push({
        id: workspace.id,
        nome: workspace.name,
        papel: linha.role,
        limiteDeChips: workspace.max_instances ?? 1,
      });
    }
  }

  const workspaceAtivo = workspaces[0] ?? null;

  const login = emailParaUsuario(usuario.email, dominioDeUsuario());
  const nome = perfil.data?.display_name?.trim() || login;

  return {
    usuario: { id: usuario.id, login, nome },
    workspaces,
    workspaceAtivo,
    ehMaster: master.data === true,
    falhouAoCarregar: Boolean(participacoes.error),
  };
});

/** Texto do papel para mostrar na tela. */
export function rotuloDoPapel(sessao: Pick<Sessao, 'ehMaster' | 'workspaceAtivo'>): string {
  if (sessao.ehMaster) return 'Administrador da plataforma';
  if (sessao.workspaceAtivo?.papel === 'owner') return 'Proprietário';
  if (sessao.workspaceAtivo?.papel === 'operator') return 'Atendente';
  return 'Sem workspace';
}
