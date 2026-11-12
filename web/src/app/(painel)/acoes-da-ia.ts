'use server';

import { revalidatePath } from 'next/cache';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Pausar tudo e retomar: o botão de emergência do topo do painel.
 * Roda no servidor, com a sessão de quem está logado; o banco confere de novo quem pode o quê
 * (qualquer pessoa ativa da empresa pausa; só o dono retoma).
 */

export type Resultado = { ok: true } | { ok: false; erro: string };

const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';
const ALGO_DEU_ERRADO = 'Algo deu errado do nosso lado. Tente de novo em instantes.';

async function mudarPausa(funcao: 'pause_my_ai' | 'resume_my_ai'): Promise<Resultado> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (funcao === 'resume_my_ai' && sessao.workspaceAtivo.papel !== 'owner') {
    return { ok: false, erro: 'Só o dono da conta retoma a IA.' };
  }

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc(funcao, { p_workspace_id: sessao.workspaceAtivo.id });
  if (error) {
    if (/Workspace owner required/.test(error.message)) return { ok: false, erro: 'Só o dono da conta retoma a IA.' };
    if (/Workspace membership required/.test(error.message)) return { ok: false, erro: 'Você não participa mais desta empresa.' };
    console.error('[atendente] não foi possível mudar a pausa da IA:', { funcao, codigo: error.code, mensagem: error.message });
    return { ok: false, erro: ALGO_DEU_ERRADO };
  }
  // O topo do painel aparece em todas as abas.
  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Para a IA em todos os chips, agora. As mensagens continuam chegando na Inbox. */
export async function pausarTudo(): Promise<Resultado> {
  return mudarPausa('pause_my_ai');
}

/** A IA volta a responder nos chips em que está ligada (só o dono). */
export async function retomarIa(): Promise<Resultado> {
  return mudarPausa('resume_my_ai');
}
