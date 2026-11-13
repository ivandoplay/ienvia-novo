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
import { DEPOSITO } from '@/lib/inbox/arquivos';
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
      content_type: entrada.contentType || 'audio/ogg; codecs=opus',
      byte_size: Math.max(1, Math.round(entrada.byteSize)),
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
