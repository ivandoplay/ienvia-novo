'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  avaliarArquivoDeAudio,
  nomeSeguroParaDeposito,
  normalizarWaveform,
  validarAudioEstrategicoParaSalvar,
  type AudioEstrategico,
} from '@ienvia/shared/recursos';
import { ehOggOpus } from '@/lib/audio/validar-voz';
import { DEPOSITO } from '@/lib/inbox/arquivos';
import { transcreverDaEmpresa } from '@/lib/ia/transcricao';
import { ErroDeIa } from '@/lib/ia/provedores';
import { ehIdentificador } from '@/lib/instancias/regras';
import { mapearAudioEstrategico } from '@/lib/recursos/mapeamento';
import { obterSessao } from '@/lib/sessao';
import { enderecoDoDepositoParaONavegador } from '@/lib/supabase/deposito';
import { criarClienteDeServico } from '@/lib/supabase/servico';
import { criarClienteServidor } from '@/lib/supabase/servidor';

const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';
const SOMENTE_DONO = 'Só o dono da conta cadastra, edita ou exclui áudios estratégicos.';

function atualizarTelas() {
  revalidatePath('/audios');
  revalidatePath('/simulador');
  revalidatePath('/inbox');
}

function traduzirErroAudio(msg: string | undefined): string {
  if (!msg) return 'Não foi possível salvar o áudio agora. Tente de novo.';
  if (msg.includes('Workspace owner required')) return SOMENTE_DONO;
  if (msg.includes('Voice library limit reached')) return 'Você atingiu o limite de 200 áudios estratégicos.';
  if (msg.includes('Voice transcription required')) return 'Informe a transcrição exata do áudio para a IA saber o que ele diz.';
  if (msg.includes('Voice media file not uploaded')) return 'O arquivo de áudio não terminou o envio. Tente gravar ou subir novamente.';
  if (msg.includes('Invalid voice media type')) return 'Formato de áudio não suportado. Use OGG, MP3, M4A, WAV, WebM ou AAC.';
  if (msg.includes('Invalid voice media size')) return 'O áudio precisa ter no máximo 16 MB.';
  return 'Não foi possível concluir a operação. Confira os campos e tente de novo.';
}

async function limparChaveAudioRemovida(workspaceId: string, chave: unknown) {
  if (typeof chave !== 'string' || !chave.startsWith(`${workspaceId}/audios/`)) return;
  const servico = criarClienteDeServico();
  const cliente = servico ?? (await criarClienteServidor());
  await cliente.storage.from(DEPOSITO).remove([chave]).catch(() => undefined);
}

export async function prepararUploadAudioEstrategico(dados: {
  voiceId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}): Promise<{ ok: true; fileId: string; objectKey: string; signedUrl: string; safeName: string } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };
  if (!ehIdentificador(dados.voiceId)) return { ok: false, erro: 'Identificador do áudio inválido.' };

  const validacao = avaliarArquivoDeAudio({
    nome: dados.fileName,
    tipoInformado: dados.contentType,
    tamanho: dados.byteSize,
  });
  if (!validacao.ok) return validacao;

  const fileId = randomUUID();
  const safeName = nomeSeguroParaDeposito(dados.fileName || 'audio.ogg', 'ogg');
  const objectKey = `${sessao.workspaceAtivo.id}/audios/${dados.voiceId}/${fileId}/${safeName}`;

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.storage.from(DEPOSITO).createSignedUploadUrl(objectKey);
  if (error || !data?.signedUrl) {
    return { ok: false, erro: 'Não foi possível preparar o envio do áudio.' };
  }

  return {
    ok: true,
    fileId,
    objectKey,
    signedUrl: enderecoDoDepositoParaONavegador(data.signedUrl),
    safeName,
  };
}

export async function salvarAudioEstrategico(entrada: {
  id: string;
  name: string;
  transcription: string;
  whenToUse: string;
  linkedMessageCode: string;
  aiEnabled: boolean;
  objectKey: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  durationSec: number | null;
  waveform: number[];
}): Promise<{ ok: true; voice: AudioEstrategico } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };
  if (!ehIdentificador(entrada.id)) return { ok: false, erro: 'Identificador do áudio inválido.' };

  const validado = validarAudioEstrategicoParaSalvar({
    name: entrada.name,
    transcription: entrada.transcription,
    whenToUse: entrada.whenToUse,
    linkedMessageCode: entrada.linkedMessageCode,
    objectKey: entrada.objectKey,
  });
  if (!validado.ok) return validado;

  const waveform = normalizarWaveform(entrada.waveform);
  const workspaceId = sessao.workspaceAtivo.id;
  const supabase = await criarClienteServidor();

  if (!entrada.objectKey.startsWith(`${workspaceId}/audios/`)) {
    return { ok: false, erro: 'Arquivo de áudio inválido para esta conta.' };
  }
  // A validação do navegador não é uma barreira de confiança: confere os bytes no servidor.
  const arquivo = await supabase.storage.from(DEPOSITO).download(entrada.objectKey);
  if (arquivo.error || !arquivo.data || arquivo.data.size > 16 * 1024 * 1024 ||
      !ehOggOpus(new Uint8Array(await arquivo.data.arrayBuffer()))) {
    return { ok: false, erro: 'O áudio precisa estar em Ogg/Opus válido para envio como mensagem de voz. Grave ou envie novamente; o cadastro anterior foi preservado.' };
  }

  const { data, error } = await supabase.rpc('save_my_voice_item', {
    p_workspace_id: workspaceId,
    p_voice: {
      id: entrada.id,
      name: entrada.name.trim(),
      transcription: entrada.transcription.trim(),
      when_to_use: entrada.whenToUse.trim(),
      linked_message_code: entrada.linkedMessageCode.trim(),
      ai_enabled: entrada.aiEnabled !== false,
      object_key: entrada.objectKey,
      file_name: entrada.fileName || 'audio.ogg',
      content_type: 'audio/ogg; codecs=opus',
      byte_size: arquivo.data.size,
      duration_sec:
        typeof entrada.durationSec === 'number' && Number.isFinite(entrada.durationSec) && entrada.durationSec >= 0
          ? Math.min(3600, Math.round(entrada.durationSec))
          : null,
      waveform,
    },
  });

  if (error || !data || typeof data !== 'object') {
    return { ok: false, erro: traduzirErroAudio(error?.message) };
  }

  const resp = data as { voice?: unknown; removed_object_key?: unknown };
  await limparChaveAudioRemovida(workspaceId, resp.removed_object_key);

  const voice = mapearAudioEstrategico(resp.voice);
  if (!voice) return { ok: false, erro: 'Áudio salvo, mas não foi possível lê-lo de volta.' };

  atualizarTelas();
  return { ok: true, voice };
}

export async function excluirAudioEstrategico(voiceId: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };
  if (!ehIdentificador(voiceId)) return { ok: false, erro: 'Áudio inválido.' };

  const workspaceId = sessao.workspaceAtivo.id;
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('delete_my_voice_item', {
    p_workspace_id: workspaceId,
    p_voice_id: voiceId,
  });

  if (error) return { ok: false, erro: traduzirErroAudio(error.message) };
  const resp = (data ?? {}) as { removed_object_key?: unknown };
  await limparChaveAudioRemovida(workspaceId, resp.removed_object_key);

  atualizarTelas();
  return { ok: true };
}

/**
 * Transcreve o áudio que já foi enviado para o depósito, usando a Groq e a reserva configurada pelo cliente
 * em Motor de IA. Serve para o botão "Transcrever automaticamente" da biblioteca de áudios:
 * quem não quiser usar a IA continua digitando a transcrição à mão.
 */
export async function transcreverAudioEstrategico(dados: {
  objectKey: string;
  contentType?: string;
  trechoWavBase64?: string;
}): Promise<{ ok: true; texto: string; modelo: string } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };

  const workspaceId = sessao.workspaceAtivo.id;
  const objectKey = String(dados.objectKey || '');
  if (!objectKey.startsWith(`${workspaceId}/audios/`)) {
    return { ok: false, erro: 'O áudio ainda não terminou de subir. Grave ou envie o arquivo primeiro.' };
  }

  const supabase = await criarClienteServidor();
  let bytes: Uint8Array;
  let tipo: string;
  if (dados.trechoWavBase64 !== undefined) {
    const base64 = dados.trechoWavBase64;
    if (typeof base64 !== 'string' || base64.length > 641000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      return { ok: false, erro: 'Trecho de áudio inválido ou maior que 30 segundos.' };
    }
    const wav = Buffer.from(base64, 'base64');
    if (wav.length < 46 || wav.toString('ascii',0,4) !== 'RIFF' || wav.toString('ascii',8,12) !== 'WAVE' ||
        wav.toString('ascii',12,16) !== 'fmt ' || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 ||
        wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 8000 || wav.readUInt32LE(28) !== 16000 ||
        wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 || wav.toString('ascii',36,40) !== 'data' ||
        wav.readUInt32LE(40) !== wav.length - 44 || wav.length > 480044) {
      return { ok: false, erro: 'O trecho deve ser WAV mono de até 30 segundos.' };
    }
    bytes = wav;
    tipo = 'audio/wav';
  } else {
    const arquivo = await supabase.storage.from(DEPOSITO).download(objectKey);
    if (arquivo.error || !arquivo.data) return { ok: false, erro: 'Não consegui baixar o áudio agora. Tente de novo.' };
    bytes = new Uint8Array(await arquivo.data.arrayBuffer());
    tipo = (dados.contentType || arquivo.data.type || 'audio/ogg').split(';')[0] || 'audio/ogg';
  }

  try {
    const resultado = await transcreverDaEmpresa(workspaceId, bytes, tipo);
    return { ok: true, texto: resultado.texto, modelo: resultado.modelo };
  } catch (erro) {
    if (erro instanceof ErroDeIa) return { ok: false, erro: traduzirErroDaTranscricao(erro) };
    return { ok: false, erro: erro instanceof Error ? erro.message : 'Não foi possível transcrever o áudio agora.' };
  }
}

/** Traduz o erro do provedor para uma frase que o dono da conta entende e consegue resolver. */
function traduzirErroDaTranscricao(erro: ErroDeIa): string {
  switch (erro.motivo) {
    case 'chave_invalida':
      return 'A chave do provedor de reserva cadastrada não foi aceita. Confira em Motor de IA.';
    case 'sem_credito':
      return 'A conta do provedor de reserva está sem crédito para transcrever.';
    case 'limite':
      return 'O provedor de reserva pediu para esperar um pouco (limite de uso). Tente de novo em alguns minutos.';
    case 'modelo_inexistente':
      return 'Nenhum modelo do provedor de reserva disponível para transcrever nesta chave.';
    case 'bloqueada':
      return 'O provedor de reserva recusou o conteúdo deste áudio.';
    case 'tempo':
      return 'A transcrição demorou demais. Tente um áudio mais curto.';
    case 'rede':
    case 'indisponivel':
      return 'O provedor de reserva não respondeu agora. Tente de novo em instantes.';
    default:
      return 'Não foi possível transcrever este áudio. Tente de novo ou digite a transcrição à mão.';
  }
}
