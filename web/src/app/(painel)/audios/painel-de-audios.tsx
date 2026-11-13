'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  formatarDuracaoAudio,
  normalizarWaveform,
  type AudioEstrategico,
} from '@ienvia/shared/recursos';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import type { DadosDosAudios } from '@/lib/dados/recursos';
import { enderecoDoRecurso } from '@/lib/inbox/arquivos';
import {
  excluirAudioEstrategico,
  prepararUploadAudioEstrategico,
  salvarAudioEstrategico,
} from './acoes';

interface AudioRascunho {
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
}

interface Props {
  dados: DadosDosAudios;
  ehDono: boolean;
}

function novoIdUuid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : '00000000-0000-4000-8000-000000000000';
}

function rascunhoVazio(): AudioRascunho {
  return {
    id: novoIdUuid(),
    name: '',
    transcription: '',
    whenToUse: '',
    linkedMessageCode: '',
    aiEnabled: true,
    objectKey: '',
    fileName: '',
    contentType: 'audio/ogg; codecs=opus',
    byteSize: 0,
    durationSec: null,
    waveform: [],
  };
}

function deAudioParaRascunho(audio: AudioEstrategico): AudioRascunho {
  return {
    id: audio.id,
    name: audio.name,
    transcription: audio.transcription,
    whenToUse: audio.whenToUse,
    linkedMessageCode: audio.linkedMessageCode,
    aiEnabled: audio.aiEnabled,
    objectKey: audio.objectKey,
    fileName: audio.fileName,
    contentType: audio.contentType,
    byteSize: audio.byteSize,
    durationSec: audio.durationSec,
    waveform: audio.waveform,
  };
}

function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function analisarArquivoDeAudio(arquivo: Blob): Promise<{ durationSec: number | null; waveform: number[] }> {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return { durationSec: null, waveform: [] };
    const ctx = new Ctx();
    try {
      const buffer = await ctx.decodeAudioData(await arquivo.arrayBuffer());
      const canal = buffer.getChannelData(0);
      const blocos = 64;
      const passo = Math.max(1, Math.floor(canal.length / blocos));
      const picos: number[] = [];
      let maximo = 0;
      for (let i = 0; i < blocos; i += 1) {
        const inicio = i * passo;
        const fim = Math.min(canal.length, inicio + passo);
        let pico = 0;
        for (let j = inicio; j < fim; j += 1) {
          const v = Math.abs(canal[j] ?? 0);
          if (v > pico) pico = v;
        }
        if (pico > maximo) maximo = pico;
        picos.push(pico);
      }
      const divisor = maximo > 0.01 ? maximo : 1;
      const waveform = normalizarWaveform(picos.map((p) => Math.round((p / divisor) * 90 + 10)));
      return { durationSec: Math.round(buffer.duration), waveform };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  } catch {
    return { durationSec: null, waveform: [] };
  }
}

export function PainelDeAudios({ dados, ehDono }: Props) {
  const [audios, setAudios] = useState<AudioEstrategico[]>(dados.audios);
  const [busca, setBusca] = useState('');
  const [filtroIa, setFiltroIa] = useState<'todos' | 'ia' | 'manual'>('todos');
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(
    dados.erroLeitura ? { tipo: 'erro', texto: dados.erroLeitura } : null,
  );

  const [editando, setEditando] = useState<AudioRascunho | null>(null);
  const [erroModal, setErroModal] = useState<string | null>(null);
  const [enviandoArquivo, setEnviandoArquivo] = useState(false);
  const [confirmarExclusao, setConfirmarExclusao] = useState<AudioEstrategico | null>(null);

  // Gravador no navegador
  const [gravando, setGravando] = useState(false);
  const [segundosGravados, setSegundosGravados] = useState(0);
  const gravadorRef = useRef<MediaRecorder | null>(null);
  const pedacosRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [pendente, iniciarTransacao] = useTransition();

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const audiosFiltrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return audios.filter((audio) => {
      if (filtroIa === 'ia' && !audio.aiEnabled) return false;
      if (filtroIa === 'manual' && audio.aiEnabled) return false;
      if (!termo) return true;
      return (
        audio.name.toLowerCase().includes(termo) ||
        audio.transcription.toLowerCase().includes(termo) ||
        audio.whenToUse.toLowerCase().includes(termo) ||
        audio.linkedMessageCode.toLowerCase().includes(termo)
      );
    });
  }, [audios, busca, filtroIa]);

  async function enviarAudioParaDeposito(blob: Blob, nomeOriginal: string, tipoMime: string) {
    if (!editando) return;
    setErroModal(null);
    setEnviandoArquivo(true);
    try {
      const mimeLimpo = (tipoMime || 'audio/ogg; codecs=opus').split(';')[0]!.trim() || 'audio/ogg';
      const prep = await prepararUploadAudioEstrategico({
        voiceId: editando.id,
        fileName: nomeOriginal,
        contentType: tipoMime || mimeLimpo,
        byteSize: blob.size,
      });
      if (!prep.ok) {
        setErroModal(prep.erro);
        return;
      }

      const [analise, resPut] = await Promise.all([
        analisarArquivoDeAudio(blob),
        fetch(prep.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': mimeLimpo },
          body: blob,
        }),
      ]);

      if (!resPut.ok) {
        setErroModal('Não foi possível subir o áudio para o depósito. Tente novamente.');
        return;
      }

      setEditando((atual) =>
        atual
          ? {
              ...atual,
              objectKey: prep.objectKey,
              fileName: prep.safeName,
              contentType: tipoMime || mimeLimpo,
              byteSize: blob.size,
              durationSec: analise.durationSec ?? (segundosGravados > 0 ? segundosGravados : atual.durationSec),
              waveform: analise.waveform,
            }
          : atual,
      );
    } finally {
      setEnviandoArquivo(false);
    }
  }

  async function iniciarGravacao() {
    setErroModal(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setErroModal('Seu navegador não permite gravação pelo microfone. Envie um arquivo pronto (.ogg, .mp3 ou .m4a).');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const candidatos = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
      const escolhido = candidatos.find((c) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c));
      const gravador = escolhido ? new MediaRecorder(stream, { mimeType: escolhido }) : new MediaRecorder(stream);
      pedacosRef.current = [];
      gravadorRef.current = gravador;

      gravador.ondataavailable = (ev) => {
        if (ev.data.size > 0) pedacosRef.current.push(ev.data);
      };
      gravador.onstop = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setGravando(false);

        const tipo = gravador.mimeType || 'audio/ogg';
        const extensao = tipo.includes('ogg') ? 'ogg' : tipo.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(pedacosRef.current, { type: tipo });
        if (blob.size > 0) {
          void enviarAudioParaDeposito(blob, `gravacao.${extensao}`, tipo);
        }
      };

      setSegundosGravados(0);
      setGravando(true);
      gravador.start();
      timerRef.current = setInterval(() => {
        setSegundosGravados((s) => s + 1);
      }, 1000);
    } catch {
      setErroModal('Não conseguimos acessar o microfone. Libere a permissão no navegador ou suba um arquivo.');
      setGravando(false);
    }
  }

  function pararGravacao() {
    gravadorRef.current?.stop();
  }

  function salvarEdicao() {
    if (!editando) return;
    setErroModal(null);
    iniciarTransacao(async () => {
      const res = await salvarAudioEstrategico(editando);
      if (!res.ok) {
        setErroModal(res.erro);
        return;
      }
      setAudios((prev) => {
        const existe = prev.some((a) => a.id === res.voice.id);
        return existe ? prev.map((a) => (a.id === res.voice.id ? res.voice : a)) : [res.voice, ...prev];
      });
      setEditando(null);
      setAviso({ tipo: 'ok', texto: `Áudio "${res.voice.name}" salvo na biblioteca.` });
    });
  }

  function alternarIa(audio: AudioEstrategico) {
    if (!ehDono) return;
    setAviso(null);
    iniciarTransacao(async () => {
      const res = await salvarAudioEstrategico({ ...deAudioParaRascunho(audio), aiEnabled: !audio.aiEnabled });
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        return;
      }
      setAudios((prev) => prev.map((a) => (a.id === res.voice.id ? res.voice : a)));
      setAviso({
        tipo: 'ok',
        texto: res.voice.aiEnabled ? `"${res.voice.name}" liberado para a IA.` : `"${res.voice.name}" mantido apenas para envio manual.`,
      });
    });
  }

  function confirmarRemoverAudio() {
    if (!confirmarExclusao) return;
    const alvo = confirmarExclusao;
    iniciarTransacao(async () => {
      const res = await excluirAudioEstrategico(alvo.id);
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        setConfirmarExclusao(null);
        return;
      }
      setAudios((prev) => prev.filter((a) => a.id !== alvo.id));
      setConfirmarExclusao(null);
      setAviso({ tipo: 'ok', texto: `Áudio "${alvo.name}" excluído.` });
    });
  }

  return (
    <div className="f6-pagina">
      <div className="page-header">
        <div>
          <h1>Biblioteca de Áudios</h1>
          <p>
            Grave ou suba mensagens de voz com transcrição real. A IA envia cada áudio como voz nativa (PTT) sem repetir na conversa e cai para texto automaticamente se o cliente pedir (Skill S06).
          </p>
        </div>
        {ehDono ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setErroModal(null);
              setEditando(rascunhoVazio());
            }}
          >
            <Icone nome="adicionar" className="icon-15" />
            Novo áudio estratégico
          </button>
        ) : null}
      </div>

      {!ehDono ? (
        <div className="f5-aviso-topo">
          <span>Você pode ouvir os áudios e enviá-los diretamente nas conversas da Inbox. Somente o dono da conta grava, edita ou exclui áudios.</span>
        </div>
      ) : null}

      {aviso ? (
        <div className={`aviso ${aviso.tipo === 'ok' ? 'aviso--ok' : 'aviso--erro'}`} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>
          {aviso.texto}
        </div>
      ) : null}

      <div className="f6-barra-topo">
        <div className="f6-filtros">
          <label htmlFor="f6-busca-audios" className="so-leitor-de-tela">
            Buscar áudio estratégico
          </label>
          <input
            id="f6-busca-audios"
            type="search"
            className="campo"
            placeholder="Buscar por nome, transcrição ou código M01..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            style={{ minWidth: 260 }}
          />
          <label htmlFor="f6-filtro-ia" className="so-leitor-de-tela">
            Filtrar uso pela IA
          </label>
          <select
            id="f6-filtro-ia"
            className="campo"
            value={filtroIa}
            onChange={(e) => setFiltroIa(e.target.value as 'todos' | 'ia' | 'manual')}
          >
            <option value="todos">Todos os áudios ({audios.length})</option>
            <option value="ia">Liberados para a IA ({audios.filter((a) => a.aiEnabled).length})</option>
            <option value="manual">Somente envio manual ({audios.filter((a) => !a.aiEnabled).length})</option>
          </select>
        </div>
      </div>

      {audiosFiltrados.length === 0 ? (
        <div className="panel" style={{ textAlign: 'center', padding: '32px 20px' }}>
          <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)' }}>
            {audios.length === 0
              ? 'Nenhum áudio estratégico cadastrado ainda. Grave sua primeira mensagem de voz ou suba um arquivo .ogg / .mp3.'
              : 'Nenhum áudio encontrado com os filtros atuais.'}
          </p>
          {audios.length === 0 && ehDono ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setErroModal(null);
                setEditando(rascunhoVazio());
              }}
            >
              <Icone nome="audios" className="icon-15" />
              Gravar ou subir primeiro áudio
            </button>
          ) : null}
        </div>
      ) : (
        <div className="f6-grade-cards">
          {audiosFiltrados.map((audio) => {
            const urlAudio = enderecoDoRecurso(audio.objectKey);
            const barras = audio.waveform.length === 64 ? audio.waveform : Array.from({ length: 32 }, (_, idx) => 28 + ((idx * 17) % 58));
            return (
              <article key={audio.id} className={`f6-card${audio.aiEnabled ? '' : ' f6-card--inativo'}`}>
                <div className="f6-card-topo">
                  <div>
                    <h2 className="f6-card-titulo">{audio.name}</h2>
                    <p className="f6-card-sub">
                      {formatarDuracaoAudio(audio.durationSec)} · {formatarTamanho(audio.byteSize)}
                      {audio.linkedMessageCode ? ` · Código ${audio.linkedMessageCode}` : ''}
                    </p>
                  </div>
                  <span className={`estado ${audio.aiEnabled ? 'estado--ok' : ''}`}>
                    {audio.aiEnabled ? 'IA ativa' : 'Manual'}
                  </span>
                </div>

                <div className="f6-wave" aria-hidden="true">
                  {barras.map((alt, i) => (
                    <span key={i} className="f6-wave-bar" style={{ height: `${Math.max(18, Math.min(100, alt))}%` }} />
                  ))}
                </div>

                {urlAudio ? (
                  <audio controls preload="none" src={urlAudio} style={{ width: '100%', height: 36 }} />
                ) : null}

                {audio.whenToUse ? (
                  <p className="f6-card-sub" style={{ color: 'var(--text-main)' }}>
                    <strong>Quando usar:</strong> {audio.whenToUse}
                  </p>
                ) : null}

                <blockquote className="f6-transcricao">{audio.transcription}</blockquote>

                {ehDono ? (
                  <div className="f6-card-acoes">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={pendente}
                      onClick={() => alternarIa(audio)}
                    >
                      {audio.aiEnabled ? 'Pausar na IA' : 'Liberar para IA'}
                    </button>
                    <div className="f6-card-botoes">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setErroModal(null);
                          setEditando(deAudioParaRascunho(audio));
                        }}
                      >
                        <Icone nome="lapis" className="icon-15" />
                        Editar
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setConfirmarExclusao(audio)}
                      >
                        <Icone nome="lixeira" className="icon-15" />
                        Excluir
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {editando ? (
        <Dialogo
          titulo={audios.some((a) => a.id === editando.id) ? `Editar áudio: ${editando.name || 'Áudio'}` : 'Novo áudio estratégico'}
          aoFechar={() => {
            if (!pendente && !enviandoArquivo && !gravando) setEditando(null);
          }}
          largo
        >
          <div style={{ display: 'grid', gap: 12 }}>
            {erroModal ? (
              <div className="aviso aviso--erro" role="alert">
                {erroModal}
              </div>
            ) : null}

            <div className="f6-gravador">
              {gravando ? (
                <>
                  <span className="f6-gravando-ponto" aria-hidden="true" />
                  <strong>Gravando… {formatarDuracaoAudio(segundosGravados)}</strong>
                  <button type="button" className="btn btn-primary btn-sm" onClick={pararGravacao}>
                    <Icone nome="parar" className="icon-15" />
                    Parar e salvar áudio
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={enviandoArquivo}
                    onClick={() => void iniciarGravacao()}
                  >
                    <Icone nome="audios" className="icon-15" />
                    Gravar pelo microfone
                  </button>
                  <label className="btn btn-secondary btn-sm" style={{ cursor: enviandoArquivo ? 'wait' : 'pointer' }}>
                    <Icone nome="nuvem" className="icon-15" />
                    {enviandoArquivo ? 'Subindo áudio…' : 'Subir arquivo (.ogg, .mp3, .m4a, .wav)'}
                    <input
                      type="file"
                      hidden
                      accept="audio/ogg,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/aac,.ogg,.mp3,.m4a,.wav,.webm,.aac"
                      disabled={enviandoArquivo}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void enviarAudioParaDeposito(f, f.name, f.type || 'audio/ogg');
                        e.target.value = '';
                      }}
                    />
                  </label>
                </>
              )}
            </div>

            {editando.objectKey ? (
              <div style={{ display: 'grid', gap: 6 }}>
                <p className="f6-card-sub">
                  Arquivo pronto: <strong>{editando.fileName}</strong> ({formatarDuracaoAudio(editando.durationSec)} · {formatarTamanho(editando.byteSize)})
                </p>
                {enderecoDoRecurso(editando.objectKey) ? (
                  <audio controls preload="none" src={enderecoDoRecurso(editando.objectKey) ?? undefined} style={{ width: '100%', height: 36 }} />
                ) : null}
              </div>
            ) : null}

            <div className="f5-grade-2">
              <div className="campo-bloco">
                <label htmlFor="aud-nome">Nome identificador do áudio</label>
                <input
                  id="aud-nome"
                  type="text"
                  className="campo"
                  placeholder="Ex.: Boas-vindas com história da loja"
                  value={editando.name}
                  onChange={(e) => setEditando({ ...editando, name: e.target.value })}
                />
              </div>

              <div className="campo-bloco">
                <label htmlFor="aud-codigo">Código da mensagem ligada (opcional)</label>
                <input
                  id="aud-codigo"
                  type="text"
                  className="campo"
                  placeholder="Ex.: M01, M06"
                  value={editando.linkedMessageCode}
                  onChange={(e) => setEditando({ ...editando, linkedMessageCode: e.target.value })}
                />
              </div>
            </div>

            <div className="campo-bloco">
              <label htmlFor="aud-quando">Quando a IA deve acionar este áudio?</label>
              <input
                id="aud-quando"
                type="text"
                className="campo"
                placeholder="Ex.: Quando o cliente perguntar sobre confiança, garantia ou entrega"
                value={editando.whenToUse}
                onChange={(e) => setEditando({ ...editando, whenToUse: e.target.value })}
              />
            </div>

            <div className="campo-bloco">
              <label htmlFor="aud-transcricao">Transcrição exata do que é falado (obrigatória)</label>
              <textarea
                id="aud-transcricao"
                rows={4}
                className="campo"
                placeholder="Escreva exatamente o que você fala neste áudio. A IA usa esse texto para decidir quando enviá-lo e responder em texto na Skill S06."
                value={editando.transcription}
                onChange={(e) => setEditando({ ...editando, transcription: e.target.value })}
              />
            </div>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
              <input
                type="checkbox"
                checked={editando.aiEnabled}
                onChange={(e) => setEditando({ ...editando, aiEnabled: e.target.checked })}
              />
              Permitir que a IA envie este áudio automaticamente (no máx. 1 vez por conversa)
            </label>

            <div className="dialogo-acoes">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={pendente || enviandoArquivo || gravando}
                onClick={() => setEditando(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendente || enviandoArquivo || gravando}
                onClick={salvarEdicao}
              >
                {pendente ? 'Salvando…' : 'Salvar áudio'}
              </button>
            </div>
          </div>
        </Dialogo>
      ) : null}

      {confirmarExclusao ? (
        <Dialogo titulo="Excluir áudio estratégico?" aoFechar={() => setConfirmarExclusao(null)}>
          <p style={{ margin: '0 0 14px' }}>
            Tem certeza que deseja excluir o áudio <strong>{confirmarExclusao.name}</strong>? O arquivo também será apagado do depósito.
          </p>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" disabled={pendente} onClick={() => setConfirmarExclusao(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" disabled={pendente} onClick={confirmarRemoverAudio}>
              {pendente ? 'Excluindo…' : 'Excluir áudio'}
            </button>
          </div>
        </Dialogo>
      ) : null}
    </div>
  );
}
