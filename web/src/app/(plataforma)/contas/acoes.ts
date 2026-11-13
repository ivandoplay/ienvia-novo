'use server';

import { revalidatePath } from 'next/cache';
import {
  validarAtualizacaoDeCliente,
  validarCriacaoDeCliente,
  validarMotivoSuporte,
  type ContaSaasResumo,
  type EventoDeAuditoriaSuporte,
} from '@ienvia/shared/contas';
import { carregarContasSaas } from '@/lib/dados/contas';
import { dominioDeUsuario } from '@/lib/env';
import { obterSessao } from '@/lib/sessao';
import { criarClienteDeServico } from '@/lib/supabase/servico';
import { criarClienteServidor } from '@/lib/supabase/servidor';

const SOMENTE_MASTER = 'Esta ação é exclusiva do administrador da plataforma.';

type RetornoComLista =
  | {
      ok: true;
      mensagem: string;
      contas: ContaSaasResumo[];
      auditoria: EventoDeAuditoriaSuporte[];
    }
  | { ok: false; erro: string };

export async function criarClienteSaas(entrada: {
  workspaceNome: string;
  loginOuEmail: string;
  nomeUsuario: string;
  senha: string;
  limiteDeChips: number;
  plano: string;
  notasAdmin: string;
  nomeDaMarca?: string;
  subtituloDaMarca?: string;
}): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };

  const validado = validarCriacaoDeCliente(entrada, dominioDeUsuario());
  if (!validado.ok) return { ok: false, erro: validado.erro };

  const supabaseAdmin = criarClienteDeServico();
  if (!supabaseAdmin) {
    return {
      ok: false,
      erro: 'O painel está sem a chave administrativa (SUPABASE_SERVICE_ROLE_KEY) para criar novos usuários.',
    };
  }

  const dados = validado.dados;
  const { data: criado, error: erroUsuario } = await supabaseAdmin.auth.admin.createUser({
    email: dados.email,
    password: dados.senha,
    email_confirm: true,
    user_metadata: { display_name: dados.nomeUsuario },
  });

  if (erroUsuario || !criado.user) {
    const msg = erroUsuario?.message ?? '';
    if (/already|registered|exists/i.test(msg)) {
      return { ok: false, erro: 'Já existe uma conta cadastrada com esse login ou e-mail.' };
    }
    console.error('[contas] falha ao criar usuário do cliente SaaS:', erroUsuario);
    return { ok: false, erro: 'Não foi possível criar o acesso do cliente agora.' };
  }

  const { error: erroProvisionar } = await supabaseAdmin.rpc('provision_platform_workspace', {
    p_actor_user_id: sessao.usuario.id,
    p_owner_user_id: criado.user.id,
    p_workspace_name: dados.workspaceNome,
    p_max_instances: dados.limiteDeChips,
    p_plan_label: dados.plano,
    p_admin_notes: dados.notasAdmin,
    p_brand_name: dados.nomeDaMarca,
    p_brand_subtitle: dados.subtituloDaMarca,
    p_owner_display_name: dados.nomeUsuario,
  });

  if (erroProvisionar) {
    // Evita usuário órfão no Auth caso a criação do workspace falhe.
    await supabaseAdmin.auth.admin.deleteUser(criado.user.id).catch(() => undefined);
    console.error('[contas] falha ao provisionar workspace do cliente SaaS:', erroProvisionar);
    return { ok: false, erro: 'Não foi possível criar a empresa para esse cliente.' };
  }

  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  return {
    ok: true,
    mensagem: `Cliente "${dados.workspaceNome}" criado com sucesso.`,
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

export async function atualizarClienteSaas(entrada: {
  workspaceId: string;
  workspaceNome: string;
  status: 'active' | 'closed';
  limiteDeChips: number;
  plano: string;
  notasAdmin: string;
}): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };

  const validado = validarAtualizacaoDeCliente(entrada);
  if (!validado.ok) return { ok: false, erro: validado.erro };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('update_platform_workspace', {
    p_workspace_id: entrada.workspaceId,
    p_name: validado.dados.workspaceNome,
    p_status: validado.dados.status,
    p_max_instances: validado.dados.limiteDeChips,
    p_plan_label: validado.dados.plano,
    p_admin_notes: validado.dados.notasAdmin,
  });

  if (error) {
    console.error('[contas] falha ao atualizar cliente SaaS:', error);
    return { ok: false, erro: 'Não foi possível salvar as alterações da conta.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  return {
    ok: true,
    mensagem:
      validado.dados.status === 'closed'
        ? `Conta "${validado.dados.workspaceNome}" salva e desativada.`
        : `Conta "${validado.dados.workspaceNome}" atualizada.`,
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

export async function entrarEmModoSuporte(entrada: {
  workspaceId: string;
  motivo: string;
}): Promise<{ ok: true } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };

  const validado = validarMotivoSuporte(entrada.motivo);
  if (!validado.ok) return { ok: false, erro: validado.erro };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('start_support_session', {
    p_workspace_id: entrada.workspaceId,
    p_reason: validado.dados,
  });

  if (error) {
    console.error('[contas] falha ao iniciar Modo Suporte:', error);
    return { ok: false, erro: 'Não foi possível entrar em Modo Suporte nesta conta.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  return { ok: true };
}

export async function encerrarModoSuporte(): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('end_support_session');
  if (error) {
    console.error('[contas] falha ao encerrar Modo Suporte:', error);
    return { ok: false, erro: 'Não foi possível encerrar o Modo Suporte agora.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  return {
    ok: true,
    mensagem: 'Modo Suporte encerrado.',
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}
