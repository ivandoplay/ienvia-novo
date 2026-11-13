'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  conferirCadencia,
  renderizarBlocoDeTexto,
  type BlocoDeCampanha,
  type CadenciaDeCampanha,
} from '@ienvia/shared/campanhas';
import { DEPOSITO } from '@/lib/inbox/arquivos';
import { ehIdentificador } from '@/lib/instancias/regras';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';
import type { ArquivoDeMidia, DetalheDaCampanha, PastaDeMidia, ResumoDeCampanha } from '@/lib/dados/campanhas';

const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';

function atualizarCaminhos() {
  revalidatePath('/campanhas');
  revalidatePath('/visao-geral');
}

function sanitizarNomeArquivo(nome: string): string {
  const limpo = nome
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 110);
  return limpo || 'arquivo.bin';
}

function traduzirErro(msg: string | undefined): string {
  if (!msg) return 'Não foi possível concluir agora. Tente de novo.';
  if (msg.includes('campaign_chip_required')) return 'Escolha pelo menos um chip habilitado para campanhas.';
  if (msg.includes('chip_not_connected')) return 'O chip escolhido precisa estar conectado para confirmar ou retomar a campanha.';
  if (msg.includes('no_eligible_recipients')) return 'Nenhum destinatário elegível restou após remover ignorados, bloqueados e chips próprios.';
  if (msg.includes('media_folder_empty')) return 'Uma das pastas de mídia escolhidas está vazia. Suba os arquivos antes de gerar a prévia.';
  if (msg.includes('empty_text_block')) return 'Preencha o texto de todos os blocos antes de gerar a prévia.';
  if (msg.includes('preview_required_before_confirm')) return 'Gere a prévia e confira os contatos elegíveis antes de confirmar o disparo.';
  if (msg.includes('uncertain_send_pending')) return 'Confirme o envio pendente sem confirmação na campanha antes de retomar.';
  if (msg.includes('campaign_locked')) return 'Esta campanha já foi confirmada e não pode mais ser editada como rascunho.';
  return 'Não foi possível concluir a operação. Confira os dados e tente de novo.';
}

async function recarregarLista(supabase: Awaited<ReturnType<typeof criarClienteServidor>>, workspaceId: string) {
  const { data } = await supabase.rpc('list_my_campaigns', { p_workspace_id: workspaceId });
  return Array.isArray(data) ? (data as ResumoDeCampanha[]) : [];
}

export async function criarPastaDeMidia(dados: {
  name: string;
  kind: 'image' | 'audio';
}): Promise<{ ok: true; pasta: PastaDeMidia } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  const nome = (dados.name ?? '').replace(/\s+/g, ' ').trim();
  if (!nome || nome.length > 120) return { ok: false, erro: 'Informe um nome válido para a pasta.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('create_my_campaign_media_folder', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_name: nome,
    p_kind: dados.kind === 'audio' ? 'audio' : 'image',
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  atualizarCaminhos();
  return { ok: true, pasta: data as PastaDeMidia };
}

export async function prepararUploadMidiaCampanha(dados: {
  folderId: string;
  fileName: string;
}): Promise<{ ok: true; fileId: string; objectKey: string; signedUrl: string; safeName: string } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(dados.folderId)) return { ok: false, erro: 'Pasta inválida.' };

  const fileId = randomUUID();
  const safeName = sanitizarNomeArquivo(dados.fileName || 'midia');
  const objectKey = `${sessao.workspaceAtivo.id}/campanhas/${dados.folderId}/${fileId}/${safeName}`;

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.storage.from(DEPOSITO).createSignedUploadUrl(objectKey);
  if (error || !data?.signedUrl) {
    return { ok: false, erro: 'Não foi possível preparar o envio do arquivo.' };
  }

  return { ok: true, fileId, objectKey, signedUrl: data.signedUrl, safeName };
}

export async function registrarArquivoMidiaCampanha(dados: {
  folderId: string;
  fileId: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}): Promise<{ ok: true; arquivo: ArquivoDeMidia } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(dados.folderId) || !ehIdentificador(dados.fileId)) return { ok: false, erro: 'Identificador inválido.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('register_my_campaign_media_file', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_folder_id: dados.folderId,
    p_file_id: dados.fileId,
    p_object_key: dados.objectKey,
    p_file_name: dados.fileName,
    p_content_type: dados.contentType || 'application/octet-stream',
    p_byte_size: dados.byteSize,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  atualizarCaminhos();
  return { ok: true, arquivo: data as ArquivoDeMidia };
}

export async function excluirArquivoMidiaCampanha(fileId: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(fileId)) return { ok: false, erro: 'Arquivo inválido.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('delete_my_campaign_media_file', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_file_id: fileId,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  const key = (data as { object_key?: string }).object_key;
  if (key) await supabase.storage.from(DEPOSITO).remove([key]).catch(() => undefined);
  atualizarCaminhos();
  return { ok: true };
}

export async function excluirPastaDeMidia(folderId: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(folderId)) return { ok: false, erro: 'Pasta inválida.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('delete_my_campaign_media_folder', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_folder_id: folderId,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  const keys = (data as { object_keys?: string[] }).object_keys;
  if (Array.isArray(keys) && keys.length > 0) await supabase.storage.from(DEPOSITO).remove(keys).catch(() => undefined);
  atualizarCaminhos();
  return { ok: true };
}

function conferirBlocos(blocos: BlocoDeCampanha[]): string | null {
  if (!Array.isArray(blocos) || blocos.length === 0 || blocos.length > 15) {
    return 'A campanha precisa ter entre 1 e 15 blocos de mensagem.';
  }
  for (let i = 0; i < blocos.length; i += 1) {
    const b = blocos[i]!;
    if (b.type === 'text') {
      if (!Array.isArray(b.texts) || !b.texts.some((t) => t.trim().length > 0)) {
        return `Preencha o texto do bloco ${i + 1}.`;
      }
    } else if (!ehIdentificador(b.folder_id)) {
      return `Escolha uma pasta de mídia no bloco ${i + 1}.`;
    }
  }
  return null;
}

export async function salvarRascunhoCampanha(dados: {
  campaignId: string | null;
  name: string;
  distribution: 'fixed' | 'round_robin';
  instanceIds: string[];
  blocks: BlocoDeCampanha[];
  cadence: CadenciaDeCampanha;
  recipients: Array<{ name: string; phone: string; fields: Record<string, string> }>;
  scheduledFor: string | null;
}): Promise<{ ok: true; detalhe: DetalheDaCampanha; lista: ResumoDeCampanha[] } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };

  const nome = (dados.name ?? '').replace(/\s+/g, ' ').trim();
  if (!nome || nome.length > 160) return { ok: false, erro: 'Dê um nome para a campanha.' };
  const validIds = (dados.instanceIds ?? []).filter(ehIdentificador);
  if (validIds.length === 0) return { ok: false, erro: 'Escolha pelo menos um chip habilitado para campanhas.' };

  const erroBlocos = conferirBlocos(dados.blocks);
  if (erroBlocos) return { ok: false, erro: erroBlocos };
  const erroCadencia = conferirCadencia(dados.cadence);
  if (erroCadencia) return { ok: false, erro: erroCadencia };
  if (!Array.isArray(dados.recipients) || dados.recipients.length === 0) {
    return { ok: false, erro: 'Importe ou cole pelo menos um destinatário válido.' };
  }

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('save_my_campaign_draft', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_campaign_id: dados.campaignId,
    p_name: nome,
    p_distribution: dados.distribution === 'round_robin' ? 'round_robin' : 'fixed',
    p_instance_ids: validIds,
    p_blocks: dados.blocks,
    p_cadence: dados.cadence,
    p_recipients: dados.recipients.slice(0, 5000),
    p_scheduled_for: dados.scheduledFor || null,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };

  const lista = await recarregarLista(supabase, sessao.workspaceAtivo.id);
  atualizarCaminhos();
  return { ok: true, detalhe: data as DetalheDaCampanha, lista };
}

export interface AmostraDePrevia {
  recipientId: string;
  name: string;
  phone: string;
  steps: Array<{ type: 'text' | 'image' | 'audio'; preview: string }>;
}

export async function gerarPreviaCampanha(campaignId: string): Promise<
  | {
      ok: true;
      eligible: number;
      suppressed: number;
      amostras: AmostraDePrevia[];
      detalhe: DetalheDaCampanha;
      lista: ResumoDeCampanha[];
    }
  | { ok: false; erro: string }
> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(campaignId)) return { ok: false, erro: 'Campanha inválida.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('prepare_my_campaign_preview', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_campaign_id: campaignId,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };

  const res = data as {
    eligible: number;
    suppressed: number;
    samples: Array<{
      recipient_id: string;
      name: string | null;
      phone: string | null;
      custom_fields: Record<string, string> | null;
    }>;
    detail: DetalheDaCampanha;
  };

  const blocks = res.detail.campaign.blocks ?? [];
  const amostras: AmostraDePrevia[] = (res.samples ?? []).map((s, idx) => {
    const vars: Record<string, string> = { ...(s.custom_fields ?? {}) };
    const nome = (s.name ?? '').trim();
    vars.nome = nome || 'olá';
    vars.primeiro_nome = (nome.split(/\s+/)[0] ?? '').trim() || 'olá';
    vars.telefone = (s.phone ?? '').replace(/\D/g, '');
    const steps = blocks.map((b) => {
      if (b.type === 'text') {
        const rendered = renderizarBlocoDeTexto(
          b,
          { nome, telefone: s.phone ?? '', campos: vars },
          idx,
        );
        return {
          type: 'text' as const,
          preview: b.mode === 'ai' ? `${rendered}\n(Cada destinatário receberá uma reescrita natural via IA)` : rendered,
        };
      }
      if (b.type === 'image') {
        return {
          type: 'image' as const,
          preview: `[Imagem da pasta · modo ${b.selection === 'random' ? 'aleatório' : 'rodízio'}]`,
        };
      }
      return {
        type: 'audio' as const,
        preview: `[Áudio da pasta · ${b.is_voice ? 'como mensagem de voz (PTT)' : 'como arquivo de áudio'} · ${b.selection === 'random' ? 'aleatório' : 'rodízio'}]`,
      };
    });
    return {
      recipientId: s.recipient_id,
      name: nome || 'Sem nome',
      phone: s.phone ?? '',
      steps,
    };
  });

  const lista = await recarregarLista(supabase, sessao.workspaceAtivo.id);
  atualizarCaminhos();
  return {
    ok: true,
    eligible: res.eligible,
    suppressed: res.suppressed,
    amostras,
    detalhe: res.detail,
    lista,
  };
}

export async function confirmarCampanha(
  campaignId: string,
  scheduledFor: string | null,
): Promise<{ ok: true; detalhe: DetalheDaCampanha; lista: ResumoDeCampanha[] } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(campaignId)) return { ok: false, erro: 'Campanha inválida.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('confirm_my_campaign', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_campaign_id: campaignId,
    p_scheduled_for: scheduledFor || null,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };

  const lista = await recarregarLista(supabase, sessao.workspaceAtivo.id);
  atualizarCaminhos();
  return { ok: true, detalhe: data as DetalheDaCampanha, lista };
}

export async function pausarCampanha(campaignId: string) {
  return executarAcaoSimples('pause_my_campaign', campaignId);
}

export async function retomarCampanha(campaignId: string) {
  return executarAcaoSimples('resume_my_campaign', campaignId);
}

export async function cancelarCampanha(campaignId: string) {
  return executarAcaoSimples('cancel_my_campaign', campaignId);
}

async function executarAcaoSimples(
  rpc: 'pause_my_campaign' | 'resume_my_campaign' | 'cancel_my_campaign',
  campaignId: string,
): Promise<{ ok: true; detalhe: DetalheDaCampanha; lista: ResumoDeCampanha[] } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(campaignId)) return { ok: false, erro: 'Campanha inválida.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc(rpc, {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_campaign_id: campaignId,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };

  const lista = await recarregarLista(supabase, sessao.workspaceAtivo.id);
  atualizarCaminhos();
  return { ok: true, detalhe: data as DetalheDaCampanha, lista };
}

export async function excluirRascunhoCampanha(
  campaignId: string,
): Promise<{ ok: true; lista: ResumoDeCampanha[] } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(campaignId)) return { ok: false, erro: 'Campanha inválida.' };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('delete_my_campaign_draft', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_campaign_id: campaignId,
  });
  if (error) return { ok: false, erro: traduzirErro(error.message) };

  const lista = await recarregarLista(supabase, sessao.workspaceAtivo.id);
  atualizarCaminhos();
  return { ok: true, lista };
}

export async function carregarDetalheCampanha(
  campaignId: string,
): Promise<{ ok: true; detalhe: DetalheDaCampanha } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(campaignId)) return { ok: false, erro: 'Campanha inválida.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_campaign', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_campaign_id: campaignId,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };
  return { ok: true, detalhe: data as DetalheDaCampanha };
}

export async function resolverEnvioIncertoCampanha(
  campaignId: string,
  deliveryId: string,
  foiEnviada: boolean,
): Promise<{ ok: true; detalhe: DetalheDaCampanha; lista: ResumoDeCampanha[] } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (!ehIdentificador(campaignId) || !ehIdentificador(deliveryId)) return { ok: false, erro: 'Identificador inválido.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('resolve_my_campaign_uncertain', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_campaign_id: campaignId,
    p_delivery_id: deliveryId,
    p_confirmed_sent: foiEnviada,
  });
  if (error || !data) return { ok: false, erro: traduzirErro(error?.message) };

  const lista = await recarregarLista(supabase, sessao.workspaceAtivo.id);
  atualizarCaminhos();
  return { ok: true, detalhe: data as DetalheDaCampanha, lista };
}
