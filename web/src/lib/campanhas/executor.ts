import 'server-only';

import { Buffer } from 'node:buffer';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  renderizarBlocoDeTexto,
  variacaoIaPreservaPlaceholders,
  type BlocoDeTexto,
  type ModoDoTexto,
  type OrdemDeSelecao,
} from '@ienvia/shared/campanhas';
import { enviarAlertaViaRpc, textoAlertaCampanhaIncerta } from '@/lib/atendente/alertas';
import { enviarArquivo, enviarTexto, type ResultadoDoEnvio } from '@/lib/evolution/cliente';
import { contextoDaChaveDeIa, decifrar, lerChaveDoCofre } from '@/lib/ia/cofre';
import { gerarResposta } from '@/lib/ia/provedores';
import { lerMotor, modeloDoProvedor, ordemDeUso, type Provedor } from '@/lib/ia/regras';
import { DEPOSITO } from '@/lib/inbox/arquivos';
import { numeroParaEnvio } from '@/lib/inbox/regras';

export interface ResumoDeCampanhasEFila {
  filaProcessados: number;
  filaEnviados: number;
  filaFalhos: number;
  filaIncertos: number;
  campanhasTravadasLimpas: number;
  campanhasProcessados: number;
  campanhasEnviados: number;
  campanhasFalhos: number;
  campanhasIncertos: number;
}

interface ItemFilaProativa {
  item_id: string;
  workspace_id: string;
  engine: 'evolution' | 'baileys';
  provider_instance_name?: string | null;
  recipient?: string | null;
  body_text?: string | null;
}

interface PassoCampanhaReivindicado {
  delivery_id: string;
  workspace_id: string;
  campaign_id: string;
  campaign_name?: string | null;
  recipient_id: string;
  step_index: number;
  block: {
    id?: string;
    type?: 'text' | 'image' | 'audio';
    mode?: string;
    selection?: OrdemDeSelecao;
    texts?: string[];
    folder_id?: string;
    is_voice?: boolean;
  };
  media_files?: Array<{
    id: string;
    object_key: string;
    file_name: string;
    content_type: string;
    byte_size: number;
  }>;
  recipient: {
    name?: string | null;
    phone?: string | null;
    jid?: string | null;
    custom_fields?: Record<string, unknown> | null;
  };
  ai?: {
    settings?: unknown;
    keys?: Record<string, string>;
  } | null;
}

function montarVariaveis(recipient: PassoCampanhaReivindicado['recipient']): Record<string, string> {
  const vars: Record<string, string> = {};
  const custom = recipient.custom_fields && typeof recipient.custom_fields === 'object' ? recipient.custom_fields : {};
  for (const [k, v] of Object.entries(custom)) {
    if (typeof v === 'string' || typeof v === 'number') vars[k] = String(v);
  }
  const nome = (recipient.name ?? '').trim();
  vars.nome = nome || 'olá';
  vars.primeiro_nome = (nome.split(/\s+/)[0] ?? '').trim() || 'olá';
  vars.telefone = (recipient.phone ?? '').replace(/\D/g, '');
  return vars;
}

async function gerarTextoVariadoComIa(params: {
  workspaceId: string;
  textoBase: string;
  nomeCliente: string;
  ai: NonNullable<PassoCampanhaReivindicado['ai']>;
  prazoMs: number;
}): Promise<string> {
  const { workspaceId, textoBase, nomeCliente, ai, prazoMs } = params;
  const sobra = prazoMs - Date.now();
  if (sobra < 6_000 || !ai.keys) return textoBase;

  const { configuracao: motor } = lerMotor(ai.settings);
  const chaveCofre = lerChaveDoCofre();
  if (!chaveCofre) return textoBase;

  const chaves: Partial<Record<Provedor, string>> = {};
  for (const provedor of ordemDeUso(motor)) {
    const cifra = ai.keys[provedor];
    if (!cifra) continue;
    const aberta = decifrar(cifra, contextoDaChaveDeIa(workspaceId, provedor), chaveCofre);
    if (aberta) chaves[provedor] = aberta;
  }

  const prompt = [
    `Reescreva esta mensagem de WhatsApp para o cliente ${nomeCliente || 'em questão'} mantendo exatamente o mesmo sentido, links, datas, valores e eventuais marcadores {{...}}:`,
    '',
    textoBase,
    '',
    'Responda apenas com o texto final reescrito, sem aspas nem explicações.',
  ].join('\n');

  for (const provedor of ordemDeUso(motor)) {
    const chave = chaves[provedor];
    if (!chave) continue;
    try {
      const resp = await gerarResposta({
        provedor,
        chave,
        modelo: modeloDoProvedor(motor, provedor),
        sistema: 'Reescreva apenas a mensagem de WhatsApp respeitando exatamente os dados, valores, links e o tom pedido.',
        conversa: [{ de: 'cliente', texto: prompt }],
        anexo: null,
        temperatura: Math.min(Math.max(motor.criatividade, 0.3), 0.9),
        tempoLimiteMs: Math.min(10_000, prazoMs - Date.now() - 4_000),
      });
      const textoLimpo = resp.texto.trim();
      if (textoLimpo && variacaoIaPreservaPlaceholders(textoBase, textoLimpo)) {
        return textoLimpo;
      }
    } catch {
      // tenta próximo provedor ou cai no texto base
    }
  }

  return textoBase;
}

function hashIndice(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % Math.max(mod, 1);
}

export async function executarCampanhasEFilaSegura(
  supabase: SupabaseClient,
  chegouEm: number = Date.now(),
  orcamentoMs: number = 48_000,
): Promise<ResumoDeCampanhasEFila> {
  const prazo = chegouEm + Math.min(Math.max(orcamentoMs, 12_000), 120_000);
  const resumo: ResumoDeCampanhasEFila = {
    filaProcessados: 0,
    filaEnviados: 0,
    filaFalhos: 0,
    filaIncertos: 0,
    campanhasTravadasLimpas: 0,
    campanhasProcessados: 0,
    campanhasEnviados: 0,
    campanhasFalhos: 0,
    campanhasIncertos: 0,
  };

  // 1. Limpa passos de campanha travados há >3 min (sem nunca reenviar)
  try {
    const { data: limpos } = await supabase.rpc('sweep_stuck_campaign_steps');
    if (typeof limpos === 'number') resumo.campanhasTravadasLimpas = limpos;
  } catch (erro) {
    console.error('[campanhas] erro ao varrer passos travados:', erro);
  }

  // 2. Fila Segura (abordagem ativa anti-bloqueio)
  if (Date.now() < prazo - 6_000) {
    const { data: itensFila, error: erroFila } = await supabase.rpc('claim_due_proactive_items', { p_limit: 5 });
    if (erroFila) {
      console.error('[fila-segura] erro ao buscar itens vencidos:', erroFila);
    } else if (Array.isArray(itensFila)) {
      for (const item of itensFila as ItemFilaProativa[]) {
        resumo.filaProcessados += 1;
        if (item.engine === 'baileys') {
          resumo.filaEnviados += 1;
          continue;
        }
        const numero = numeroParaEnvio(item.recipient);
        const chip = item.provider_instance_name?.trim() || '';
        const corpo = (item.body_text ?? '').trim();
        if (!numero || !chip || !corpo) {
          await supabase.rpc('finish_proactive_item', {
            p_workspace_id: item.workspace_id,
            p_item_id: item.item_id,
            p_outcome: 'failed',
            p_provider_message_id: null,
            p_error_detail: 'destinatario_ou_chip_invalido',
          });
          resumo.filaFalhos += 1;
          continue;
        }

        const envio = await enviarTexto(chip, numero, corpo, {
          digitandoMs: 1_500,
          tempoLimite: Math.max(Math.min(18_000, prazo - Date.now() - 2_000), 5_000),
        });
        const outcome = envio.situacao === 'enviada' ? 'sent' : envio.situacao === 'nao_enviada' ? 'failed' : 'uncertain';
        const { data: fim } = await supabase.rpc('finish_proactive_item', {
          p_workspace_id: item.workspace_id,
          p_item_id: item.item_id,
          p_outcome: outcome,
          p_provider_message_id: envio.situacao === 'enviada' ? envio.idNoWhatsApp : null,
          p_error_detail: envio.situacao === 'nao_enviada' ? envio.motivo : envio.situacao === 'incerta' ? envio.detalhe : null,
        });

        if (outcome === 'sent') resumo.filaEnviados += 1;
        else if (outcome === 'failed') resumo.filaFalhos += 1;
        else {
          resumo.filaIncertos += 1;
          const r = fim as { alert_uncertain?: boolean; recipient_phone?: string; instance_id?: string } | null;
          if (r?.alert_uncertain) {
            await enviarAlertaViaRpc({
              supabase,
              workspaceId: item.workspace_id,
              kind: 'campaign_uncertain',
              bodyText: textoAlertaCampanhaIncerta({
                titulo: 'Fila Segura',
                telefone: r.recipient_phone ?? numero,
              }),
              preferredInstanceId: r.instance_id ?? null,
            });
          }
        }
      }
    }
  }

  // 3. Campanhas em lote (multi-bloco, spintax/IA/mídia, Baileys & Evolution)
  if (Date.now() < prazo - 6_000) {
    const { data: passos, error: erroPassos } = await supabase.rpc('claim_due_campaign_steps', { p_limit: 5 });
    if (erroPassos) {
      console.error('[campanhas] erro ao buscar passos vencidos:', erroPassos);
    } else if (Array.isArray(passos)) {
      for (const passo of passos as PassoCampanhaReivindicado[]) {
        resumo.campanhasProcessados += 1;
        try {
          let renderedBody: string | null = null;
          let mediaFileId: string | null = null;
          let isVoice = false;

          if (passo.block.type === 'text') {
            const vars = montarVariaveis(passo.recipient);
            const modoBruto = passo.block.mode;
            const modo: ModoDoTexto =
              modoBruto === 'rotation' || modoBruto === 'spintax' || modoBruto === 'ai' ? modoBruto : 'fixed';
            const blocoTexto: BlocoDeTexto = {
              id: passo.block.id ?? `s-${passo.step_index}`,
              type: 'text',
              mode: modo,
              texts: Array.isArray(passo.block.texts) && passo.block.texts.length > 0 ? passo.block.texts : ['Olá'],
              selection: passo.block.selection === 'random' ? 'random' : 'sequential',
            };
            const base = renderizarBlocoDeTexto(
              blocoTexto,
              { nome: vars.nome, telefone: vars.telefone, campos: vars },
              hashIndice(passo.recipient_id, blocoTexto.texts.length),
            );
            renderedBody =
              blocoTexto.mode === 'ai' && passo.ai
                ? await gerarTextoVariadoComIa({
                    workspaceId: passo.workspace_id,
                    textoBase: base,
                    nomeCliente: vars.nome ?? '',
                    ai: passo.ai,
                    prazoMs: prazo,
                  })
                : base;
          } else if (passo.block.type === 'image' || passo.block.type === 'audio') {
            const arquivos = passo.media_files ?? [];
            if (arquivos.length === 0) {
              await supabase.rpc('finish_campaign_step_delivery', {
                p_workspace_id: passo.workspace_id,
                p_delivery_id: passo.delivery_id,
                p_outcome: 'failed',
                p_provider_message_id: null,
                p_error_detail: 'pasta_de_midia_vazia',
              });
              resumo.campanhasFalhos += 1;
              continue;
            }
            const escolhaIdx =
              passo.block.selection === 'random' || passo.block.mode === 'random'
                ? Math.floor(Math.random() * arquivos.length)
                : hashIndice(passo.recipient_id, arquivos.length);
            mediaFileId = arquivos[escolhaIdx]!.id;
            isVoice = passo.block.type === 'audio' ? passo.block.is_voice === true : false;
          }

          const { data: despacho, error: erroDespacho } = await supabase.rpc('dispatch_claimed_campaign_step', {
            p_workspace_id: passo.workspace_id,
            p_delivery_id: passo.delivery_id,
            p_rendered_body: renderedBody,
            p_media_file_id: mediaFileId,
            p_is_voice: isVoice,
          });
          if (erroDespacho || !despacho || typeof despacho !== 'object') {
            await supabase.rpc('finish_campaign_step_delivery', {
              p_workspace_id: passo.workspace_id,
              p_delivery_id: passo.delivery_id,
              p_outcome: 'failed',
              p_provider_message_id: null,
              p_error_detail: erroDespacho?.message ?? 'falha_ao_preparar_envio',
            });
            resumo.campanhasFalhos += 1;
            continue;
          }

          const info = despacho as {
            result?: string;
            provider_instance_name?: string | null;
            recipient?: string | null;
            body_text?: string | null;
            attachment?: {
              object_key: string;
              kind: 'image' | 'audio';
              content_type: string;
              file_name: string;
              is_voice: boolean;
            } | null;
          };

          if (info.result === 'queued_local') {
            resumo.campanhasEnviados += 1;
            continue;
          }
          if (info.result !== 'ready_evolution') {
            continue;
          }

          const numero = numeroParaEnvio(info.recipient);
          const chip = info.provider_instance_name?.trim() || '';
          let envio: ResultadoDoEnvio;
          if (!numero || !chip) {
            envio = { situacao: 'nao_enviada', motivo: 'sem_whatsapp' };
          } else if (info.attachment) {
            const { data: blob, error: erroBaixar } = await supabase.storage
              .from(DEPOSITO)
              .download(info.attachment.object_key);
            if (erroBaixar || !blob) {
              await supabase.rpc('finish_campaign_step_delivery', {
                p_workspace_id: passo.workspace_id,
                p_delivery_id: passo.delivery_id,
                p_outcome: 'failed',
                p_provider_message_id: null,
                p_error_detail: 'falha_ao_ler_arquivo_da_campanha',
              });
              resumo.campanhasFalhos += 1;
              continue;
            }
            const dados = Buffer.from(await blob.arrayBuffer());
            envio = await enviarArquivo(
              chip,
              numero,
              {
                tipo: info.attachment.kind,
                dados,
                conteudo: info.attachment.content_type,
                nome: info.attachment.file_name,
                legenda: null,
                voz: info.attachment.is_voice,
              },
              { tempoLimite: Math.max(Math.min(35_000, prazo - Date.now() - 2_000), 8_000) },
            );
          } else {
            envio = await enviarTexto(chip, numero, info.body_text ?? '', {
              digitandoMs: 1_500,
              tempoLimite: Math.max(Math.min(18_000, prazo - Date.now() - 2_000), 5_000),
            });
          }

          const outcome = envio.situacao === 'enviada' ? 'sent' : envio.situacao === 'nao_enviada' ? 'failed' : 'uncertain';
          const { data: fimPasso } = await supabase.rpc('finish_campaign_step_delivery', {
            p_workspace_id: passo.workspace_id,
            p_delivery_id: passo.delivery_id,
            p_outcome: outcome,
            p_provider_message_id: envio.situacao === 'enviada' ? envio.idNoWhatsApp : null,
            p_error_detail:
              envio.situacao === 'nao_enviada' ? envio.motivo : envio.situacao === 'incerta' ? envio.detalhe : null,
          });

          if (outcome === 'sent') resumo.campanhasEnviados += 1;
          else if (outcome === 'failed') resumo.campanhasFalhos += 1;
          else {
            resumo.campanhasIncertos += 1;
            const rf = fimPasso as { alert_uncertain?: boolean; campaign_name?: string; instance_id?: string } | null;
            if (rf?.alert_uncertain) {
              await enviarAlertaViaRpc({
                supabase,
                workspaceId: passo.workspace_id,
                kind: 'campaign_uncertain',
                bodyText: textoAlertaCampanhaIncerta({
                  titulo: 'Campanha em lote',
                  nomeCampanha: rf.campaign_name ?? passo.campaign_name,
                  telefone: passo.recipient.phone ?? numero,
                }),
                preferredInstanceId: rf.instance_id ?? null,
              });
            }
          }
        } catch (erro) {
          console.error('[campanhas] erro inesperado no passo:', { deliveryId: passo.delivery_id, erro: String(erro) });
          await supabase.rpc('finish_campaign_step_delivery', {
            p_workspace_id: passo.workspace_id,
            p_delivery_id: passo.delivery_id,
            p_outcome: 'uncertain',
            p_provider_message_id: null,
            p_error_detail: erro instanceof Error ? erro.message : String(erro),
          });
          resumo.campanhasIncertos += 1;
        }
      }
    }
  }

  return resumo;
}
