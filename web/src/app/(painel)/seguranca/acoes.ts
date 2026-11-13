'use server';

import { revalidatePath } from 'next/cache';
import {
  conferirSeguranca,
  segurancaParaOBanco,
  type ConfiguracaoDeSeguranca,
} from '@ienvia/shared/seguranca';
import { enviarAlertaViaRpc } from '@/lib/atendente/alertas';
import { montarDossieParaAdmin } from '@/lib/atendente/dossie';
import { ehIdentificador } from '@/lib/instancias/regras';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';
import { criarClienteDeServico } from '@/lib/supabase/servico';
import type { DadosDaFilaSegura, ListaIgnorados } from '@/lib/dados/seguranca';

export type ResultadoSeguranca =
  | { ok: true; configuracao?: ConfiguracaoDeSeguranca }
  | { ok: false; erro: string };

export type ResultadoIgnorados =
  | { ok: true; lista: ListaIgnorados }
  | { ok: false; erro: string };

export type ResultadoFila =
  | { ok: true; fila: DadosDaFilaSegura; elegiveis?: number; suprimidos?: number }
  | { ok: false; erro: string };

const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';

function atualizarCaminhos() {
  revalidatePath('/seguranca');
  revalidatePath('/visao-geral');
  revalidatePath('/inteligencia-artificial');
}

function traduzirErro(msg: string | undefined): string {
  if (!msg) return 'Não foi possível concluir agora. Tente de novo.';
  if (msg.includes('Workspace owner required')) return 'Só o dono da conta pode alterar as regras de segurança.';
  if (msg.includes('admin_alert_whatsapp_required')) return 'Informe o WhatsApp para alertas antes de ativar os avisos.';
  if (msg.includes('uncertain_send_pending')) return 'Confira o envio sem confirmação pendente na fila antes de retomar ou iniciar outro lote.';
  if (msg.includes('chip_not_connected')) return 'Conecte pelo menos um chip habilitado para campanhas antes de iniciar a fila.';
  if (msg.includes('Invalid phone number')) return 'Número de WhatsApp inválido. Use DDD + número (ex.: 86999990000).';
  return 'Não foi possível concluir a operação. Confira os dados e tente de novo.';
}

export async function salvarRegrasDeSeguranca(entrada: ConfiguracaoDeSeguranca): Promise<ResultadoSeguranca> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') {
    return { ok: false, erro: 'Só o dono da conta pode alterar as regras de segurança.' };
  }

  const erroValidacao = conferirSeguranca(entrada);
  if (erroValidacao) return { ok: false, erro: erroValidacao };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('save_my_security_settings', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_settings: segurancaParaOBanco(entrada),
  });

  if (error || !data) {
    return { ok: false, erro: traduzirErro(error?.message) };
  }

  atualizarCaminhos();
  return { ok: true, configuracao: entrada };
}

export async function testarAlertaDeSeguranca(): Promise<{ ok: true } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') {
    return { ok: false, erro: 'Só o dono da conta pode disparar o teste de alerta.' };
  }

  const supabaseServico = criarClienteDeServico();
  if (!supabaseServico) {
    return { ok: false, erro: 'Configuração do servidor incompleta para testar o alerta.' };
  }

  const textoTeste = montarDossieParaAdmin({
    tipo: 'test',
    agora: new Date(),
    nomeDoContato: 'Lead de Teste',
    telefoneDoContato: '+5586999990000',
    recado: 'Cenário: Teste de alerta administrativo na aba Segurança | Gatilho: Botão de teste | Próxima jogada: Confirmar recebimento no WhatsApp.',
    incluirMensagens: false,
  });

  await enviarAlertaViaRpc({
    supabase: supabaseServico,
    workspaceId: sessao.workspaceAtivo.id,
    kind: 'test',
    bodyText: textoTeste,
  });

  return { ok: true };
}

export async function adicionarNumeroIgnorado(dados: {
  name: string;
  phone: string;
  note: string;
}): Promise<ResultadoIgnorados> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('add_my_ignored_number', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_name: dados.name ?? '',
    p_phone: dados.phone ?? '',
    p_note: dados.note ?? '',
  });

  if (error || !data) {
    return { ok: false, erro: traduzirErro(error?.message) };
  }

  atualizarCaminhos();
  return { ok: true, lista: data as ListaIgnorados };
}

export async function removerNumeroIgnorado(dados: {
  id?: string | null;
  contactId?: string | null;
}): Promise<ResultadoIgnorados> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (dados.id && !ehIdentificador(dados.id)) return { ok: false, erro: 'Registro inválido.' };
  if (dados.contactId && !ehIdentificador(dados.contactId)) return { ok: false, erro: 'Contato inválido.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('remove_my_ignored_number', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_id: dados.id ?? null,
    p_contact_id: dados.contactId ?? null,
  });

  if (error || !data) {
    return { ok: false, erro: traduzirErro(error?.message) };
  }

  atualizarCaminhos();
  return { ok: true, lista: data as ListaIgnorados };
}

export async function iniciarFilaSegura(dados: {
  mode: 'auto_rotate' | 'single';
  instanceId: string | null;
  template: string;
  recipients: Array<{ name: string; phone: string }>;
}): Promise<ResultadoFila> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (dados.mode === 'single' && (!dados.instanceId || !ehIdentificador(dados.instanceId))) {
    return { ok: false, erro: 'Escolha o chip conectado que vai fazer os envios.' };
  }
  if (!dados.template.trim()) {
    return { ok: false, erro: 'Escreva a mensagem modelo para a fila.' };
  }
  if (!Array.isArray(dados.recipients) || dados.recipients.length === 0) {
    return { ok: false, erro: 'Inclua pelo menos um telefone válido para iniciar a fila.' };
  }

  const supabase = await criarClienteServidor();
  const { data: inicio, error: erroInicio } = await supabase.rpc('start_my_proactive_queue', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_mode: dados.mode,
    p_instance_id: dados.mode === 'single' ? dados.instanceId : null,
    p_message_template: dados.template.trim(),
    p_recipients: dados.recipients.slice(0, 500),
  });

  if (erroInicio || !inicio) {
    return { ok: false, erro: traduzirErro(erroInicio?.message) };
  }

  const { data: fila, error: erroFila } = await supabase.rpc('read_my_proactive_queue', {
    p_workspace_id: sessao.workspaceAtivo.id,
  });

  atualizarCaminhos();
  if (erroFila || !fila) {
    return { ok: false, erro: 'Fila iniciada, mas não foi possível atualizar a visualização.' };
  }
  const res = inicio as { eligible?: number; suppressed?: number };
  return {
    ok: true,
    fila: fila as DadosDaFilaSegura,
    elegiveis: res.eligible ?? 0,
    suprimidos: res.suppressed ?? 0,
  };
}

export async function pausarFilaSegura(): Promise<ResultadoFila> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('pause_my_proactive_queue', {
    p_workspace_id: sessao.workspaceAtivo.id,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  atualizarCaminhos();
  return { ok: true, fila: data as DadosDaFilaSegura };
}

export async function retomarFilaSegura(): Promise<ResultadoFila> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('resume_my_proactive_queue', {
    p_workspace_id: sessao.workspaceAtivo.id,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  atualizarCaminhos();
  return { ok: true, fila: data as DadosDaFilaSegura };
}

export async function limparFilaSegura(): Promise<ResultadoFila> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('clear_my_proactive_queue', {
    p_workspace_id: sessao.workspaceAtivo.id,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  atualizarCaminhos();
  return { ok: true, fila: data as DadosDaFilaSegura };
}

export async function resolverIncertoDaFila(itemId: string, foiEnviada: boolean): Promise<ResultadoFila> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(itemId)) return { ok: false, erro: 'Item da fila inválido.' };
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('resolve_my_proactive_uncertain', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_item_id: itemId,
    p_confirmed_sent: foiEnviada,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  atualizarCaminhos();
  return { ok: true, fila: data as DadosDaFilaSegura };
}
