import 'server-only';

import { cookies } from 'next/headers';
import { cache } from 'react';
import { MARCA_PADRAO, emailParaUsuario } from '@ienvia/shared';
import { COOKIE_WORKSPACE } from '@/lib/cookies';
import { dominioDeUsuario } from '@/lib/env';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export type Papel = 'owner' | 'operator';

export interface WorkspaceDaSessao {
  id: string;
  nome: string;
  papel: Papel;
  /** Quantos chips esta conta pode ter (definido pelo administrador da plataforma). */
  limiteDeChips: number;
  brandName: string;
  brandSubtitle: string;
  status: string;
  emModoSuporte?: boolean;
}

export interface ModoSuporteAtivo {
  sessionId: string;
  workspaceId: string;
  workspaceNome: string;
  status: string;
  motivo: string;
  expiraEm: string;
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
   * Workspace aberto agora: em Modo Suporte, é a conta do cliente; fora dele,
   * respeita o cookie `ienvia_ws` ou cai no workspace mais antigo.
   */
  workspaceAtivo: WorkspaceDaSessao | null;
  /** Administrador da plataforma (enxerga a área "Clientes SaaS"). */
  ehMaster: boolean;
  /** Quando o master entrou em Modo Suporte auditado dentro de uma conta de cliente. */
  modoSuporte: ModoSuporteAtivo | null;
  /** `true` quando a pessoa só participa de contas atualmente desativadas. */
  temContaDesativada: boolean;
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
  brand_name?: string | null;
  brand_subtitle?: string | null;
}

interface LinhaDeParticipacao {
  role: Papel;
  /** O Supabase devolve um objeto aqui; por garantia aceitamos também uma lista de um item. */
  workspaces: WorkspaceBruto | WorkspaceBruto[] | null;
}

interface LinhaDeSuporte {
  id: string;
  workspace_id: string;
  reason: string | null;
  expires_at: string;
  workspaces: WorkspaceBruto | WorkspaceBruto[] | null;
}

function normalizarWorkspace(ws: WorkspaceBruto, papel: Papel, emModoSuporte = false): WorkspaceDaSessao {
  return {
    id: ws.id,
    nome: ws.name,
    papel,
    limiteDeChips: ws.max_instances ?? 1,
    brandName: ws.brand_name?.trim() || MARCA_PADRAO.nomeDaMarca,
    brandSubtitle: (ws.brand_subtitle ?? MARCA_PADRAO.subtituloDaMarca).trim(),
    status: ws.status,
    emModoSuporte,
  };
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

  const [participacoes, perfil, master, cookieStore] = await Promise.all([
    supabase
      .from('workspace_memberships')
      .select('role, workspaces(id, name, status, max_instances, brand_name, brand_subtitle)')
      .eq('user_id', usuario.id)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .returns<LinhaDeParticipacao[]>(),
    supabase.from('profiles').select('display_name').eq('id', usuario.id).maybeSingle<{ display_name: string }>(),
    supabase.rpc('is_my_platform_master'),
    cookies(),
  ]);

  // Uma falha aqui não pode passar por "conta sem workspace" sem deixar rastro.
  if (participacoes.error) console.error('[sessão] não foi possível ler as participações:', participacoes.error);
  if (perfil.error) console.error('[sessão] não foi possível ler o perfil:', perfil.error);
  if (master.error) console.error('[sessão] não foi possível conferir o administrador:', master.error);

  const ehMaster = master.data === true;
  const workspaces: WorkspaceDaSessao[] = [];
  let encontrouDesativado = false;
  for (const linha of participacoes.data ?? []) {
    const workspace = Array.isArray(linha.workspaces) ? linha.workspaces[0] : linha.workspaces;
    if (!workspace) continue;
    if (workspace.status === 'active') {
      workspaces.push(normalizarWorkspace(workspace, linha.role));
    } else if (workspace.status === 'closed') {
      encontrouDesativado = true;
    }
  }

  let modoSuporte: ModoSuporteAtivo | null = null;
  let workspaceSuporte: WorkspaceDaSessao | null = null;

  if (ehMaster) {
    const { data: suporte, error: erroSuporte } = await supabase
      .from('support_sessions')
      .select('id, workspace_id, reason, expires_at, workspaces(id, name, status, max_instances, brand_name, brand_subtitle)')
      .is('ended_at', null)
      .gte('expires_at', new Date().toISOString())
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle<LinhaDeSuporte>();

    if (erroSuporte) {
      console.error('[sessão] não foi possível conferir o modo suporte:', erroSuporte);
    } else if (suporte) {
      const wsBruto = Array.isArray(suporte.workspaces) ? suporte.workspaces[0] : suporte.workspaces;
      if (wsBruto && (wsBruto.status === 'active' || wsBruto.status === 'closed')) {
        modoSuporte = {
          sessionId: suporte.id,
          workspaceId: wsBruto.id,
          workspaceNome: wsBruto.name,
          status: wsBruto.status,
          motivo: suporte.reason ?? '',
          expiraEm: suporte.expires_at,
        };
        workspaceSuporte = normalizarWorkspace(wsBruto, 'owner', true);
      }
    }
  }

  const escolhido = cookieStore.get(COOKIE_WORKSPACE)?.value;
  const workspaceAtivo =
    workspaceSuporte ??
    workspaces.find((w) => w.id === escolhido) ??
    workspaces[0] ??
    null;

  const login = emailParaUsuario(usuario.email, dominioDeUsuario());
  const nome = perfil.data?.display_name?.trim() || login;

  return {
    usuario: { id: usuario.id, login, nome },
    workspaces,
    workspaceAtivo,
    ehMaster,
    modoSuporte,
    temContaDesativada: workspaces.length === 0 && encontrouDesativado,
    falhouAoCarregar: Boolean(participacoes.error),
  };
});

/** Texto do papel para mostrar na tela. */
export function rotuloDoPapel(sessao: Pick<Sessao, 'ehMaster' | 'workspaceAtivo' | 'modoSuporte'>): string {
  if (sessao.modoSuporte) return 'Modo suporte (master)';
  if (sessao.ehMaster) return 'Administrador da plataforma';
  if (sessao.workspaceAtivo?.papel === 'owner') return 'Proprietário';
  if (sessao.workspaceAtivo?.papel === 'operator') return 'Atendente';
  return 'Sem workspace';
}
