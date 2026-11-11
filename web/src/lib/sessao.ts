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
}

interface LinhaDeParticipacao {
  role: Papel;
  workspaces: { id: string; name: string; status: string } | null;
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
      .select('role, workspaces(id, name, status)')
      .eq('user_id', usuario.id)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .returns<LinhaDeParticipacao[]>(),
    supabase.from('profiles').select('display_name').eq('id', usuario.id).maybeSingle<{ display_name: string }>(),
    supabase.rpc('is_my_platform_master'),
  ]);

  const workspaces: WorkspaceDaSessao[] = (participacoes.data ?? [])
    .filter((linha) => linha.workspaces !== null && linha.workspaces.status === 'active')
    .map((linha) => ({
      id: linha.workspaces!.id,
      nome: linha.workspaces!.name,
      papel: linha.role,
    }));

  const workspaceAtivo = workspaces[0] ?? null;

  const login = emailParaUsuario(usuario.email, dominioDeUsuario());
  const nome = perfil.data?.display_name?.trim() || login;

  return {
    usuario: { id: usuario.id, login, nome },
    workspaces,
    workspaceAtivo,
    ehMaster: master.data === true,
  };
});

/** Texto do papel para mostrar na tela. */
export function rotuloDoPapel(sessao: Pick<Sessao, 'ehMaster' | 'workspaceAtivo'>): string {
  if (sessao.ehMaster) return 'Administrador da plataforma';
  if (sessao.workspaceAtivo?.papel === 'owner') return 'Proprietário';
  if (sessao.workspaceAtivo?.papel === 'operator') return 'Atendente';
  return 'Sem workspace';
}
