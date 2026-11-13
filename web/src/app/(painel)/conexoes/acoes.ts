'use server';

import { revalidatePath } from 'next/cache';
import { ehIdentificador } from '@/lib/instancias/regras';
import { gerarCodigoPareamento, sha256Hex } from '@/lib/motor/autenticacao';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export type ResultadoPareamento =
  | {
      ok: true;
      executorId: string;
      displayName: string;
      codigo: string;
      expiraEm: string;
    }
  | { ok: false; erro: string };

export type ResultadoAcaoExecutor = { ok: true } | { ok: false; erro: string };

const SEM_PERMISSAO = 'Só o dono da conta pode parear ou revogar aparelhos do motor local.';
const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';

function validarNomeAparelho(valor: string): string | null {
  const limpo = valor.replace(/\s+/g, ' ').trim();
  if (!limpo || limpo.length > 80) return null;
  return limpo;
}

export async function criarCodigoPareamentoLocal(apelidoBruto: string): Promise<ResultadoPareamento> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SEM_PERMISSAO };

  const apelido = validarNomeAparelho(apelidoBruto);
  if (!apelido) {
    return { ok: false, erro: 'Dê um nome ao aparelho (até 80 letras), como "PC do Escritório" ou "Celular Loja".' };
  }

  const codigo = gerarCodigoPareamento();
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('create_my_local_executor_pairing', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_display_name: apelido,
    p_code_sha256: sha256Hex(codigo),
  });

  if (error || !data) {
    console.error('[conexoes] falha ao gerar código de pareamento:', error);
    return { ok: false, erro: 'Não foi possível gerar o código agora. Tente de novo em instantes.' };
  }

  const criado = data as { id: string; display_name: string; expires_at: string };
  revalidatePath('/conexoes');
  revalidatePath('/instancias');
  return {
    ok: true,
    executorId: criado.id,
    displayName: criado.display_name,
    codigo,
    expiraEm: criado.expires_at,
  };
}

export async function renomearExecutorLocal(executorId: string, apelidoBruto: string): Promise<ResultadoAcaoExecutor> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SEM_PERMISSAO };
  if (!ehIdentificador(executorId)) return { ok: false, erro: 'Aparelho não encontrado.' };

  const apelido = validarNomeAparelho(apelidoBruto);
  if (!apelido) return { ok: false, erro: 'Informe um nome válido (até 80 letras).' };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('rename_my_local_executor', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_executor_id: executorId,
    p_display_name: apelido,
  });

  if (error) {
    console.error('[conexoes] falha ao renomear aparelho:', error);
    return { ok: false, erro: 'Não foi possível renomear este aparelho agora.' };
  }

  revalidatePath('/conexoes');
  revalidatePath('/instancias');
  return { ok: true };
}

export async function revogarExecutorLocal(executorId: string): Promise<ResultadoAcaoExecutor> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SEM_PERMISSAO };
  if (!ehIdentificador(executorId)) return { ok: false, erro: 'Aparelho não encontrado.' };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('revoke_my_local_executor', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_executor_id: executorId,
  });

  if (error) {
    console.error('[conexoes] falha ao revogar aparelho:', error);
    return { ok: false, erro: 'Não foi possível revogar este aparelho agora.' };
  }

  revalidatePath('/conexoes');
  revalidatePath('/instancias');
  revalidatePath('/visao-geral');
  return { ok: true };
}
