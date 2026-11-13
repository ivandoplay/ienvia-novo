'use server';

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import QRCode from 'qrcode';
import {
  detectarRecusaDeAudioDoCliente,
  type AudioEstrategico,
  type ItemDoCatalogo,
} from '@ienvia/shared/recursos';
import { formatarMensagemPix } from '@ienvia/shared/recursos-pix';
import {
  avaliarMidiaSimulador,
  extrairAudiosJaEnviadosNoSimulador,
  normalizarSessaoSimulador,
  truncarHistoricoSimulador,
  type MensagemSimulador,
} from '@ienvia/shared/simulador';
import { lerMotorDeIa } from '@/lib/dados/ia';
import { carregarRecursosDaInbox } from '@/lib/dados/recursos';
import { lerBaseDeTreinamento, lerBasesDeTreinamento } from '@/lib/dados/treinamento';
import { contextoDaChaveDeIa, decifrar, lerChaveDoCofre } from '@/lib/ia/cofre';
import { lerResposta, montarInstrucoes } from '@/lib/ia/instrucoes';
import { ErroDeIa, gerarResposta, type AnexoParaIa, type Fala, type RespostaDeIa } from '@/lib/ia/provedores';
import {
  explicarErroDeIa,
  modeloDoProvedor,
  NOME_DO_PROVEDOR,
  ordemDeUso,
  provedorRecebe,
  type Provedor,
} from '@/lib/ia/regras';
import { ehIdentificador } from '@/lib/instancias/regras';
import { obterSessao } from '@/lib/sessao';
import { criarClienteDeServico } from '@/lib/supabase/servico';
import { criarClienteServidor } from '@/lib/supabase/servidor';

const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';

function encontrarItemCatalogo(catalogo: readonly ItemDoCatalogo[], id: string): ItemDoCatalogo | null {
  const limpo = id.trim();
  if (!limpo) return null;
  return (
    catalogo.find((i) => i.id === limpo) ??
    catalogo.find((i) => i.name.trim().toLowerCase() === limpo.toLowerCase()) ??
    null
  );
}

function encontrarAudio(audios: readonly AudioEstrategico[], id: string): AudioEstrategico | null {
  const limpo = id.trim();
  if (!limpo) return null;
  return (
    audios.find((a) => a.id === limpo) ??
    audios.find((a) => a.name.trim().toLowerCase() === limpo.toLowerCase()) ??
    null
  );
}

async function lerChavesDoWorkspace(
  workspaceId: string,
  ehDono: boolean,
  supabase: Awaited<ReturnType<typeof criarClienteServidor>>,
  provedores: readonly Provedor[],
): Promise<Partial<Record<Provedor, string>>> {
  const cofre = lerChaveDoCofre();
  if (!cofre) return {};

  const saida: Partial<Record<Provedor, string>> = {};
  const servico = criarClienteDeServico();
  if (servico) {
    const { data } = await servico.rpc('read_workspace_ai_keys_for_simulator', { p_workspace_id: workspaceId });
    const bruto = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    for (const p of provedores) {
      const cifrada = bruto[p];
      if (typeof cifrada === 'string' && cifrada) {
        const aberta = decifrar(cifrada, contextoDaChaveDeIa(workspaceId, p), cofre);
        if (aberta) saida[p] = aberta;
      }
    }
    return saida;
  }

  if (ehDono) {
    for (const p of provedores) {
      const { data } = await supabase.rpc('read_my_ai_key_ciphertext', {
        p_workspace_id: workspaceId,
        p_provider: p,
      });
      if (typeof data === 'string' && data) {
        const aberta = decifrar(data, contextoDaChaveDeIa(workspaceId, p), cofre);
        if (aberta) saida[p] = aberta;
      }
    }
  }
  return saida;
}

export interface ResultadoSimulacao {
  ok: true;
  historico: MensagemSimulador[];
  provedorUsado: string;
  modeloUsado: string;
  duracaoMs: number;
  instrucoesUsadas: string;
  respostaBruta: string;
}

export async function enviarMensagemSimulador(entrada: {
  agentId: string | null;
  nomeContato: string;
  texto: string;
  anexo?: {
    fileName: string;
    contentType: string;
    base64: string;
  } | null;
}): Promise<ResultadoSimulacao | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  const workspaceId = sessao.workspaceAtivo.id;
  const ehDono = sessao.workspaceAtivo.papel === 'owner';

  const textoLimpo = (entrada.texto ?? '').trim().slice(0, 4000);
  const temAnexo = Boolean(entrada.anexo?.base64);
  if (!textoLimpo && !temAnexo) {
    return { ok: false, erro: 'Escreva uma mensagem ou anexe uma foto/áudio para simular.' };
  }

  let anexoParaIa: AnexoParaIa | null = null;
  let tipoAnexoRotulo: 'image' | 'audio' | 'document' | null = null;
  if (entrada.anexo?.base64) {
    const dados = Buffer.from(entrada.anexo.base64, 'base64');
    const av = avaliarMidiaSimulador({
      nome: entrada.anexo.fileName || 'anexo.bin',
      tipoInformado: entrada.anexo.contentType,
      tamanho: dados.length,
    });
    if (!av.ok) {
      return { ok: false, erro: av.erro };
    }
    if (av.tipo.startsWith('image/')) {
      tipoAnexoRotulo = 'image';
      anexoParaIa = { tipo: av.tipo, dados };
    } else if (av.tipo.startsWith('audio/')) {
      tipoAnexoRotulo = 'audio';
      anexoParaIa = { tipo: av.tipo, dados };
    } else {
      return { ok: false, erro: 'No simulador, anexe uma imagem (JPG/PNG/WebP) ou um áudio (OGG/MP3/M4A/WAV).' };
    }
  }

  const supabase = await criarClienteServidor();

  const [resSessao, resBases, resMotor, recursos] = await Promise.all([
    supabase.rpc('read_my_simulator_session', { p_workspace_id: workspaceId }),
    lerBasesDeTreinamento(workspaceId),
    lerMotorDeIa(workspaceId),
    carregarRecursosDaInbox(workspaceId),
  ]);

  if (!resMotor.motor) {
    return { ok: false, erro: 'Não foi possível ler as configurações do Motor de IA.' };
  }
  const motor = resMotor.motor.configuracao;
  const provedoresOrdem = ordemDeUso(motor);
  const chaves = await lerChavesDoWorkspace(workspaceId, ehDono, supabase, provedoresOrdem);
  const comChave = provedoresOrdem.filter((p) => Boolean(chaves[p]));
  if (comChave.length === 0) {
    return { ok: false, erro: 'Configure pelo menos uma chave de IA na aba Motor de IA antes de simular.' };
  }

  const bases = resBases.lista?.bases ?? [];
  const baseEscolhida =
    (entrada.agentId && ehIdentificador(entrada.agentId) ? bases.find((b) => b.id === entrada.agentId) : null) ??
    bases.find((b) => b.padrao) ??
    bases[0] ??
    null;

  if (!baseEscolhida) {
    return { ok: false, erro: 'Crie pelo menos uma base na aba Treinamento para simular o atendimento.' };
  }

  const leituraBase = await lerBaseDeTreinamento(workspaceId, baseEscolhida.id, true);
  if (!leituraBase.base) {
    return { ok: false, erro: 'Não foi possível carregar os dados da base de treinamento escolhida.' };
  }

  const sessaoBruta =
    resSessao.data && typeof resSessao.data === 'object' && !Array.isArray(resSessao.data)
      ? (resSessao.data as Record<string, unknown>)
      : {};
  const sessaoAtual = normalizarSessaoSimulador({
    agentId: typeof sessaoBruta.agent_id === 'string' ? sessaoBruta.agent_id : baseEscolhida.id,
    history: sessaoBruta.history,
  });

  const audiosJaEnviados = extrairAudiosJaEnviadosNoSimulador(sessaoAtual.history);
  const falasClienteRecentes = sessaoAtual.history.filter((m) => m.papel === 'user').map((m) => m.texto).filter(Boolean);
  const mensagemAtualTexto = textoLimpo || (tipoAnexoRotulo === 'audio' ? '[Áudio enviado para teste]' : '[Foto enviada para teste]');
  const clienteRecusouAudio = detectarRecusaDeAudioDoCliente(mensagemAtualTexto, falasClienteRecentes.slice(-5));

  const instrucoes = montarInstrucoes(leituraBase.base, {
    agora: new Date(),
    nomeDoContato: entrada.nomeContato.trim() || 'Cliente Teste',
    mensagemAtual: mensagemAtualTexto,
    historicoRecente: falasClienteRecentes.slice(-5),
    temAudio: tipoAnexoRotulo === 'audio',
    temFoto: tipoAnexoRotulo === 'image',
    recursos: {
      pix: recursos.pix,
      catalogo: recursos.catalogo,
      audios: recursos.audios,
      audiosJaEnviados,
      clienteRecusouAudio,
    },
  });

  const conversaFalas: Fala[] = [];
  for (const m of sessaoAtual.history) {
    if (m.papel === 'user') {
      conversaFalas.push({
        de: 'cliente',
        texto: m.texto || (m.anexoSimulado ? `[Arquivo anexado: ${m.anexoSimulado.nome}]` : '...'),
      });
    } else {
      const resumoIa =
        m.texto ||
        (m.audios?.length ? `[Áudio estratégico enviado: "${m.audios[0]!.transcription}"]` : null) ||
        (m.itensCatalogo?.length ? `[Mídia do catálogo enviada: ${m.itensCatalogo.map((i) => i.name).join(', ')}]` : null) ||
        (m.pixPreview ? '[Dados, QR Code e Copia e Cola PIX enviados]' : null) ||
        '[Silêncio / encaminhamento]';
      conversaFalas.push({ de: 'atendente', texto: resumoIa });
    }
  }
  conversaFalas.push({ de: 'cliente', texto: mensagemAtualTexto });

  const rota = tipoAnexoRotulo
    ? comChave.filter((p) => provedorRecebe(p, tipoAnexoRotulo === 'image' ? 'foto' : tipoAnexoRotulo === 'audio' ? 'audio' : 'documento'))
    : comChave;

  if (rota.length === 0) {
    return {
      ok: false,
      erro:
        tipoAnexoRotulo === 'audio'
          ? 'Para simular recebimento de áudio do cliente, configure uma chave do Google Gemini na ordem de uso.'
          : 'Nenhum dos provedores configurados aceita este anexo.',
    };
  }

  let resposta: RespostaDeIa | null = null;
  let provedorUsado: Provedor | null = null;
  let modeloUsado = '';
  let ultimoErro = '';

  for (const provedor of rota) {
    const modelo = modeloDoProvedor(motor, provedor);
    try {
      resposta = await gerarResposta({
        provedor,
        chave: chaves[provedor]!,
        modelo,
        sistema: instrucoes,
        conversa: conversaFalas,
        anexo: anexoParaIa,
        temperatura: motor.criatividade,
        tempoLimiteMs: 35_000,
      });
      provedorUsado = provedor;
      modeloUsado = modelo;
      break;
    } catch (erro) {
      const motivo = erro instanceof ErroDeIa ? erro.motivo : 'recusada';
      ultimoErro = explicarErroDeIa(motivo, provedor, modelo);
    }
  }

  if (!resposta || !provedorUsado) {
    return { ok: false, erro: ultimoErro || 'Nenhum provedor de IA conseguiu responder agora.' };
  }

  const lida = lerResposta(resposta.texto);

  const itensResolvidos: NonNullable<MensagemSimulador['itensCatalogo']> = [];
  for (const idItem of lida.itensParaEnviar) {
    const item = encontrarItemCatalogo(recursos.catalogo, idItem);
    if (item) {
      itensResolvidos.push({
        id: item.id,
        name: item.name,
        files: item.files.map((f) => ({
          objectKey: f.objectKey,
          fileName: f.fileName,
          contentType: f.contentType,
        })),
      });
    }
  }

  const audiosResolvidos: NonNullable<MensagemSimulador['audios']> = [];
  let fallbackAudioTexto = '';
  const enviadosSet = new Set(audiosJaEnviados);
  for (const idAudio of lida.audiosParaEnviar) {
    const audio = encontrarAudio(recursos.audios, idAudio);
    if (!audio || !audio.aiEnabled) continue;
    if (clienteRecusouAudio || enviadosSet.has(audio.id)) {
      if (!lida.texto.trim() && audio.transcription.trim()) {
        fallbackAudioTexto = audio.transcription.trim();
      }
      continue;
    }
    audiosResolvidos.push({
      id: audio.id,
      name: audio.name,
      objectKey: audio.objectKey,
      transcription: audio.transcription,
      durationSec: audio.durationSec,
      waveform: audio.waveform,
    });
  }

  let pixPreview: MensagemSimulador['pixPreview'] = null;
  if (lida.enviarPix && recursos.pix.enabled && recursos.pix.key.trim()) {
    const formatado = formatarMensagemPix(recursos.pix, lida.valorPix);
    if (formatado) {
      let qrDataUrl: string | null = null;
      if (formatado.sendQrImage) {
        try {
          qrDataUrl = await QRCode.toDataURL(formatado.qrBrcode, {
            width: 260,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: { dark: '#000000', light: '#FFFFFF' },
          });
        } catch {
          qrDataUrl = null;
        }
      }
      pixPreview = {
        summaryText: formatado.summaryText,
        brcode: formatado.brcode,
        qrDataUrl,
        amount: formatado.amount,
      };
    }
  }

  const comandos: NonNullable<MensagemSimulador['comandos']> = [];
  if (lida.chamarHumano) comandos.push({ tipo: 'CHAMAR_HUMANO', detalhe: lida.chamarHumano });
  if (lida.pausaSilenciosa) comandos.push({ tipo: 'PAUSA_SILENCIOSA', detalhe: lida.pausaSilenciosa });
  if (lida.encerrarContato) comandos.push({ tipo: 'ENCERRAR_CONTATO', detalhe: lida.encerrarContato });
  if (lida.pararContato) comandos.push({ tipo: 'PARAR_CONTATO', detalhe: lida.pararContato });
  if (lida.silencioDeCortesia) comandos.push({ tipo: 'SILENCIO_CORTESIA', detalhe: 'Silêncio de cortesia' });

  const agoraIso = new Date().toISOString();
  const msgUser: MensagemSimulador = {
    id: randomUUID(),
    papel: 'user',
    texto: textoLimpo || (tipoAnexoRotulo === 'audio' ? '[Áudio enviado]' : '[Foto enviada]'),
    criadoEm: agoraIso,
    anexoSimulado: entrada.anexo && tipoAnexoRotulo ? { nome: entrada.anexo.fileName, tipo: tipoAnexoRotulo } : null,
  };
  const msgAssistente: MensagemSimulador = {
    id: randomUUID(),
    papel: 'assistant',
    texto: (lida.texto.trim() || fallbackAudioTexto).trim(),
    criadoEm: new Date().toISOString(),
    sentVoiceIds: audiosResolvidos.map((a) => a.id),
    itensCatalogo: itensResolvidos,
    audios: audiosResolvidos,
    pixPreview,
    comandos,
  };

  const novoHistorico = truncarHistoricoSimulador([...sessaoAtual.history, msgUser, msgAssistente]);

  const { error: saveErr } = await supabase.rpc('save_my_simulator_session', {
    p_workspace_id: workspaceId,
    p_agent_id: baseEscolhida.id,
    p_history: novoHistorico,
  });
  if (saveErr) {
    console.error('[simulador] não foi possível salvar a sessão:', saveErr);
  }

  revalidatePath('/simulador');
  return {
    ok: true,
    historico: novoHistorico,
    provedorUsado: NOME_DO_PROVEDOR[provedorUsado],
    modeloUsado,
    duracaoMs: resposta.duracaoMs,
    instrucoesUsadas: instrucoes,
    respostaBruta: resposta.texto,
  };
}

export async function reiniciarSessaoSimulador(agentId: string | null): Promise<{ ok: true } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('reset_my_simulator_session', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_agent_id: agentId && ehIdentificador(agentId) ? agentId : null,
  });
  if (error) {
    return { ok: false, erro: 'Não foi possível limpar a conversa do simulador.' };
  }
  revalidatePath('/simulador');
  return { ok: true };
}
