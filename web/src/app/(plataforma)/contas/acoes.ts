'use server';

import { revalidatePath } from 'next/cache';
import {
  formatarDataBr,
  validarAtualizacaoDeCliente,
  validarCobrancaDoCliente,
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

/**
 * Exclui um cliente do SaaS. O cliente perde o acesso na hora (campanhas param, chips desligam) e o
 * pedido de exclusão fica registrado; o dono da plataforma pode desfazer por 30 dias.
 */
export async function excluirClienteSaas(entrada: {
  workspaceId: string;
  motivo: string;
}): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };
  if (!entrada.workspaceId) return { ok: false, erro: 'Escolha o cliente que vai ser excluído.' };

  const motivo = String(entrada.motivo ?? '').trim();
  if (motivo.length < 3) return { ok: false, erro: 'Escreva o motivo da exclusão (aparece no histórico).' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('delete_platform_workspace', {
    p_workspace_id: entrada.workspaceId,
    p_motivo: motivo.slice(0, 500),
  });

  if (error) {
    console.error('[contas] falha ao excluir cliente:', error);
    const msg = error.message ?? '';
    if (msg.includes('Workspace not found')) return { ok: false, erro: 'Este cliente não existe mais.' };
    return { ok: false, erro: 'Não foi possível excluir este cliente agora.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  const nome = (data as { name?: string } | null)?.name ?? 'Cliente';
  return {
    ok: true,
    mensagem: `${nome} foi excluído. O acesso já está bloqueado e dá para desfazer por 30 dias.`,
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

/** Desfaz uma exclusão feita por engano, enquanto o prazo de 30 dias não venceu. */
export async function restaurarClienteSaas(workspaceId: string): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };
  if (!workspaceId) return { ok: false, erro: 'Escolha o cliente que vai ser restaurado.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('restore_platform_workspace', { p_workspace_id: workspaceId });

  if (error) {
    console.error('[contas] falha ao restaurar cliente:', error);
    if ((error.message ?? '').includes('Deletion window expired')) {
      return { ok: false, erro: 'O prazo de 30 dias para desfazer esta exclusão já passou.' };
    }
    return { ok: false, erro: 'Não foi possível restaurar este cliente agora.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  const nome = (data as { name?: string } | null)?.name ?? 'Cliente';
  return {
    ok: true,
    mensagem: `${nome} voltou a ficar ativo.`,
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

// =============================================================================================
// Cobrança e ações rápidas (o painel de Clientes SaaS como mesa de administração)
// =============================================================================================

/** Grava vencimento, valor, carência, "pago até" e o texto do aviso de suspensão. */
export async function salvarCobrancaDoCliente(entrada: {
  workspaceId: string;
  dueDay: string;
  monthlyAmountCents: string;
  graceDays: string;
  paidUntil: string;
  suspendNotice: string;
  ownerWhatsapp: string;
  autoSuspend: boolean;
}): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };
  if (!entrada.workspaceId) return { ok: false, erro: 'Escolha o cliente.' };

  const validado = validarCobrancaDoCliente(entrada);
  if (!validado.ok) return { ok: false, erro: validado.erro };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('set_workspace_billing', {
    p_workspace_id: entrada.workspaceId,
    p_due_day: validado.dados.dueDay,
    p_monthly_amount_cents: validado.dados.monthlyAmountCents,
    p_grace_days: validado.dados.graceDays,
    p_paid_until: validado.dados.paidUntil,
    p_suspend_notice: validado.dados.suspendNotice,
    p_auto_suspend: entrada.autoSuspend === true,
  });

  if (error) {
    console.error('[contas] falha ao salvar cobrança:', error);
    return { ok: false, erro: 'Não foi possível salvar a cobrança deste cliente.' };
  }

  // Só os dígitos interessam; vazio volta a usar o próprio número do chip como destino do aviso.
  const { error: erroWhats } = await supabase.rpc('set_workspace_owner_whatsapp', {
    p_workspace_id: entrada.workspaceId,
    p_whatsapp: String(entrada.ownerWhatsapp ?? '').replace(/\D/g, ''),
  });
  if (erroWhats) {
    console.error('[contas] falha ao guardar o WhatsApp do responsável:', erroWhats);
    return {
      ok: false,
      erro: 'A cobrança foi salva, mas o WhatsApp do responsável não. Confira o número (só dígitos, com 55).',
    };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  return {
    ok: true,
    mensagem: 'Cobrança salva. O painel já mostra a nova situação.',
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

/** Marca o mês como pago e devolve até quando o cliente está quitado. */
export async function marcarClienteComoPago(workspaceId: string): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };
  if (!workspaceId) return { ok: false, erro: 'Escolha o cliente.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('mark_workspace_paid', {
    p_workspace_id: workspaceId,
    p_paid_until: null,
  });

  if (error) {
    console.error('[contas] falha ao marcar como pago:', error);
    return { ok: false, erro: 'Não foi possível marcar este mês como pago.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  const ate = (data as { paid_until?: string } | null)?.paid_until ?? '';
  return {
    ok: true,
    mensagem: ate ? `Pagamento registrado. Cliente em dia até ${formatarDataBr(ate)}.` : 'Pagamento registrado.',
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

/**
 * Suspende o cliente: fecha a conta, para as campanhas, desliga os chips e deixa o aviso na fila —
 * o aviso sai no WhatsApp pelo primeiro chip que voltar a conectar.
 */
export async function suspenderClienteSaas(entrada: {
  workspaceId: string;
  motivo: string;
  aviso: string;
}): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };
  if (!entrada.workspaceId) return { ok: false, erro: 'Escolha o cliente.' };

  const motivo = String(entrada.motivo ?? '').trim();
  if (motivo.length < 3) return { ok: false, erro: 'Escreva o motivo da suspensão (fica no histórico).' };
  const aviso = String(entrada.aviso ?? '').trim();
  if (aviso.length > 600) return { ok: false, erro: 'O aviso pode ter até 600 caracteres.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('suspend_platform_workspace', {
    p_workspace_id: entrada.workspaceId,
    p_reason: motivo.slice(0, 300),
    p_notice: aviso,
  });

  if (error) {
    console.error('[contas] falha ao suspender cliente:', error);
    return { ok: false, erro: 'Não foi possível suspender este cliente agora.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  const detalhe = data as { notice_queued?: boolean; chips_disabled?: number } | null;
  const partes = ['Cliente suspenso: o acesso parou e as campanhas foram pausadas.'];
  if (Number(detalhe?.chips_disabled ?? 0) > 0) partes.push(`${detalhe?.chips_disabled} chip(s) desligado(s).`);
  partes.push(
    detalhe?.notice_queued
      ? 'O aviso ficou na fila e sai no WhatsApp assim que um chip reconectar.'
      : 'Nenhum aviso foi enfileirado (conta sem chip com número).',
  );
  return {
    ok: true,
    mensagem: partes.join(' '),
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

/** Devolve o acesso ao cliente e cancela avisos de suspensão que ainda não saíram. */
export async function reativarClienteSaas(workspaceId: string): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };
  if (!workspaceId) return { ok: false, erro: 'Escolha o cliente.' };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('reactivate_platform_workspace', { p_workspace_id: workspaceId });

  if (error) {
    console.error('[contas] falha ao reativar cliente:', error);
    if ((error.message ?? '').includes('being deleted')) {
      return { ok: false, erro: 'Este cliente está no prazo de exclusão. Use "Desfazer exclusão".' };
    }
    return { ok: false, erro: 'Não foi possível reativar este cliente agora.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  return {
    ok: true,
    mensagem: 'Cliente reativado. Ele já pode entrar; os chips ele mesmo religa no painel.',
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

/** Zera os dados do cliente (mantém login e chips). Exige o nome digitado duas vezes. */
export async function zerarClienteSaas(entrada: {
  workspaceId: string;
  confirmacao: string;
}): Promise<RetornoComLista> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };
  if (!entrada.workspaceId) return { ok: false, erro: 'Escolha o cliente.' };
  if (String(entrada.confirmacao ?? '').trim().length === 0) {
    return { ok: false, erro: 'Digite o nome do cliente para confirmar.' };
  }

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('reset_platform_workspace', {
    p_workspace_id: entrada.workspaceId,
    p_confirmation: String(entrada.confirmacao ?? '').trim(),
  });

  if (error) {
    console.error('[contas] falha ao zerar cliente:', error);
    if ((error.message ?? '').includes('Confirmation does not match')) {
      return { ok: false, erro: 'O nome digitado não é igual ao nome do cliente. Nada foi apagado.' };
    }
    return { ok: false, erro: 'Não foi possível zerar esta conta agora.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  const n = (data ?? {}) as { contacts_deleted?: number; conversations_deleted?: number; messages_deleted?: number };
  return {
    ok: true,
    mensagem: `Conta zerada: ${Number(n.messages_deleted ?? 0)} mensagens, ${Number(n.conversations_deleted ?? 0)} conversas e ${Number(n.contacts_deleted ?? 0)} contatos apagados. O login e os chips continuam.`,
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

/**
 * Troca a senha do dono do cliente e devolve a senha nova para o master repassar.
 * Não mexe em mais nada da conta.
 */
export async function trocarSenhaDoCliente(workspaceId: string): Promise<RetornoComLista & { senha?: string }> {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return { ok: false, erro: SOMENTE_MASTER };

  const supabase = await criarClienteServidor();
  const { data: dono, error: erroDono } = await supabase.rpc('owner_of_workspace', {
    p_workspace_id: workspaceId,
  });
  const userId = (dono as { user_id?: string } | null)?.user_id;
  if (erroDono || !userId) {
    console.error('[contas] falha ao localizar o dono do cliente:', erroDono);
    return { ok: false, erro: 'Este cliente não tem um responsável ativo para trocar a senha.' };
  }

  const admin = criarClienteDeServico();
  if (!admin) return { ok: false, erro: 'O painel está sem a chave administrativa para trocar a senha.' };

  const senha = gerarSenhaTemporaria();
  const { error } = await admin.auth.admin.updateUserById(userId, { password: senha });
  if (error) {
    console.error('[contas] falha ao trocar a senha do cliente:', error);
    return { ok: false, erro: 'Não foi possível trocar a senha agora.' };
  }

  await supabase.rpc('log_platform_action', {
    p_workspace_id: workspaceId,
    p_action: 'platform_workspace_password_reset',
    p_details: {},
  });

  revalidatePath('/contas');
  const atualizado = await carregarContasSaas();
  return {
    ok: true,
    mensagem: 'Senha nova gerada. Copie e envie para o responsável; ela não aparece de novo.',
    senha,
    contas: atualizado.contas,
    auditoria: atualizado.auditoria,
  };
}

/** Senha legível por telefone: sem letras que se confundem (O/0, l/1). */
function gerarSenhaTemporaria(): string {
  const letras = 'abcdefghijkmnpqrstuvwxyz';
  const numeros = '23456789';
  const simbolos = '!@#%&*';
  const sorteia = (fonte: string) => fonte[Math.floor(Math.random() * fonte.length)];
  const corpo = Array.from({ length: 8 }, () => sorteia(letras + numeros.toUpperCase())).join('');
  return `${corpo}${sorteia(numeros)}${sorteia(simbolos)}`;
}
