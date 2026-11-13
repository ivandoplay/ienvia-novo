'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { formatarDuracaoAudio } from '@ienvia/shared/recursos';
import { avaliarMidiaSimulador, type MensagemSimulador } from '@ienvia/shared/simulador';
import { Icone } from '@/components/ui/icone';
import type { DadosDoSimulador } from '@/lib/dados/recursos';
import { enderecoDoRecurso } from '@/lib/inbox/arquivos';
import { enviarMensagemSimulador, reiniciarSessaoSimulador } from './acoes';

interface Props {
  dados: DadosDoSimulador;
}

const ROTULO_COMANDO: Record<string, string> = {
  CHAMAR_HUMANO: 'Passou para humano',
  PAUSA_SILENCIOSA: 'Pausa silenciosa',
  ENCERRAR_CONTATO: 'Encerrou sem insistir',
  PARAR_CONTATO: 'Opt-out registrado',
  SILENCIO_CORTESIA: 'Silêncio de cortesia',
};

function formatarHora(iso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function PainelDoSimulador({ dados }: Props) {
  const [historico, setHistorico] = useState<MensagemSimulador[]>(dados.sessao.history);
  const [agentId, setAgentId] = useState<string>(
    dados.sessao.agentId ?? dados.bases.find((b) => b.padrao)?.id ?? dados.bases[0]?.id ?? '',
  );
  const [nomeContato, setNomeContato] = useState('Cliente Teste');
  const [texto, setTexto] = useState('');
  const [anexo, setAnexo] = useState<{ fileName: string; contentType: string; base64: string; previaUrl: string | null } | null>(null);
  const [erro, setErro] = useState<string | null>(dados.erroLeitura ?? null);
  const [telemetria, setTelemetria] = useState<{
    provedor: string;
    modelo: string;
    duracaoMs: number;
    instrucoes: string;
    bruta: string;
  } | null>(null);
  const [verPrompt, setVerPrompt] = useState(false);

  const [pendente, iniciarTransacao] = useTransition();
  const fimChatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fimChatRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [historico.length]);

  async function escolherAnexo(arquivo: File | null | undefined) {
    if (!arquivo) return;
    const av = avaliarMidiaSimulador({ nome: arquivo.name, tipoInformado: arquivo.type, tamanho: arquivo.size });
    if (!av.ok) {
      setErro(av.erro);
      return;
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result ?? '');
        resolve(res.includes(',') ? res.split(',')[1]! : res);
      };
      reader.onerror = () => reject(new Error('Falha ao ler arquivo'));
      reader.readAsDataURL(arquivo);
    });
    setErro(null);
    setAnexo({
      fileName: arquivo.name,
      contentType: arquivo.type || 'application/octet-stream',
      base64,
      previaUrl: arquivo.type.startsWith('image/') ? URL.createObjectURL(arquivo) : null,
    });
  }

  function enviar(textoDireto?: string) {
    const conteudo = (textoDireto ?? texto).trim();
    if ((!conteudo && !anexo) || pendente) return;
    setErro(null);
    const anexoAtual = anexo;
    if (!textoDireto) setTexto('');
    setAnexo(null);

    iniciarTransacao(async () => {
      const res = await enviarMensagemSimulador({
        agentId: agentId || null,
        nomeContato,
        texto: conteudo,
        anexo: anexoAtual
          ? { fileName: anexoAtual.fileName, contentType: anexoAtual.contentType, base64: anexoAtual.base64 }
          : null,
      });
      if (!res.ok) {
        setErro(res.erro);
        return;
      }
      setHistorico(res.historico);
      setTelemetria({
        provedor: res.provedorUsado,
        modelo: res.modeloUsado,
        duracaoMs: res.duracaoMs,
        instrucoes: res.instrucoesUsadas,
        bruta: res.respostaBruta,
      });
    });
  }

  function limparConversa() {
    setErro(null);
    iniciarTransacao(async () => {
      const res = await reiniciarSessaoSimulador(agentId || null);
      if (!res.ok) {
        setErro(res.erro);
        return;
      }
      setHistorico([]);
      setTelemetria(null);
    });
  }

  return (
    <div className="f6-pagina">
      <div className="page-header">
        <div>
          <h1>Simulador de Atendimento</h1>
          <p>
            Converse com a sua IA usando o treinamento, catálogo, PIX e áudios reais do workspace sem enviar nada para clientes no WhatsApp.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" disabled={pendente || historico.length === 0} onClick={limparConversa}>
          <Icone nome="atualizar" className="icon-15" />
          Nova conversa simulada
        </button>
      </div>

      {!dados.motorConfigurado ? (
        <div className="f5-aviso-topo f5-aviso-topo--alerta">
          <div>
            <strong>Configuração necessária:</strong> cadastre uma base em <Link href="/treinamento">Treinamento</Link> e uma chave ativa no{' '}
            <Link href="/inteligencia-artificial">Motor de IA</Link> para conversar no simulador.
          </div>
        </div>
      ) : null}

      {erro ? (
        <div className="aviso aviso--erro" role="alert">
          {erro}
        </div>
      ) : null}

      <div className="f6-sim-layout">
        <section className="f6-sim-chat" aria-label="Chat simulado">
          <div className="f6-sim-topo">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <label htmlFor="sim-base" className="so-leitor-de-tela">
                Base de treinamento
              </label>
              <select
                id="sim-base"
                className="campo"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={dados.bases.length === 0}
              >
                {dados.bases.length === 0 ? <option value="">Nenhuma base criada</option> : null}
                {dados.bases.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.rotulo}
                    {b.padrao ? ' (Padrão)' : ''}
                  </option>
                ))}
              </select>

              <label htmlFor="sim-contato" className="so-leitor-de-tela">
                Nome simulado do cliente
              </label>
              <input
                id="sim-contato"
                type="text"
                className="campo"
                value={nomeContato}
                onChange={(e) => setNomeContato(e.target.value)}
                placeholder="Nome do cliente"
                style={{ width: 150 }}
              />
            </div>

            {dados.motorConfigurado ? (
              <span className="estado estado--ia">
                {dados.nomeProvedorPrincipal} · {dados.modeloPrincipal}
              </span>
            ) : null}
          </div>

          <div className="f6-sim-mensagens">
            {historico.length === 0 ? (
              <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 380, color: 'var(--text-secondary)', fontSize: 13.5 }}>
                <p style={{ margin: '0 0 8px', fontWeight: 600, color: 'var(--text-main)' }}>
                  Sessão isolada e segura
                </p>
                <p style={{ margin: 0 }}>
                  Mande uma pergunta abaixo ou use os testes rápidos para validar o catálogo, áudios estratégicos, Skill S06 e geração de PIX com QR Code.
                </p>
              </div>
            ) : (
              historico.map((m) => (
                <div key={m.id} className={`f6-sim-bolha f6-sim-bolha--${m.papel}`}>
                  {m.anexoSimulado ? (
                    <span className="estado">
                      Anexo enviado ({m.anexoSimulado.tipo === 'audio' ? 'Áudio' : 'Foto'}): {m.anexoSimulado.nome}
                    </span>
                  ) : null}

                  {m.texto ? <div style={{ whiteSpace: 'pre-wrap' }}>{m.texto}</div> : null}

                  {m.itensCatalogo && m.itensCatalogo.length > 0 ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      {m.itensCatalogo.map((item) => (
                        <div key={item.id} className="f6-sim-anexo-card">
                          <div style={{ flex: 1 }}>
                            <strong style={{ fontSize: 12.5 }}>Catálogo enviado: {item.name}</strong>
                            <div className="f6-midias-strip" style={{ marginTop: 6 }}>
                              {item.files.map((arq) => {
                                const url = enderecoDoRecurso(arq.objectKey);
                                return arq.contentType === 'application/pdf' || !url ? (
                                  <a key={arq.objectKey} href={url ?? '#'} target="_blank" rel="noopener noreferrer" className="f6-thumb">
                                    <Icone nome="documento" className="icon-18" />
                                    <span>PDF</span>
                                  </a>
                                ) : (
                                  <a key={arq.objectKey} href={url} target="_blank" rel="noopener noreferrer" className="f6-thumb">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={url} alt={arq.fileName} />
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {m.audios && m.audios.length > 0 ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      {m.audios.map((audio) => {
                        const url = enderecoDoRecurso(audio.objectKey);
                        return (
                          <div key={audio.id} style={{ display: 'grid', gap: 6, padding: 8, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                              <strong>Áudio PTT: {audio.name}</strong>
                              <span>{formatarDuracaoAudio(audio.durationSec)}</span>
                            </div>
                            {url ? <audio controls preload="none" src={url} style={{ width: '100%', height: 34 }} /> : null}
                            <small style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
                              “{audio.transcription}”
                            </small>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {m.pixPreview ? (
                    <div style={{ display: 'grid', gap: 8, padding: 10, borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{m.pixPreview.summaryText}</div>
                      {m.pixPreview.qrDataUrl ? (
                        <div className="f6-pix-qr-box" style={{ padding: 10 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={m.pixPreview.qrDataUrl} alt="QR Code PIX simulado" style={{ width: 150, height: 150 }} />
                        </div>
                      ) : null}
                      {m.pixPreview.brcode ? (
                        <div className="f6-codigo-mono">{m.pixPreview.brcode}</div>
                      ) : null}
                    </div>
                  ) : null}

                  {m.comandos && m.comandos.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {m.comandos.map((cmd, idx) => (
                        <span key={idx} className="f6-sim-comando-badge" title={cmd.detalhe}>
                          {ROTULO_COMANDO[cmd.tipo] ?? cmd.tipo}: {cmd.detalhe.slice(0, 60)}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <span className="f6-sim-bolha-hora">
                    {m.papel === 'user' ? nomeContato : 'IA'} · {formatarHora(m.criadoEm)}
                  </span>
                </div>
              ))
            )}
            <div ref={fimChatRef} />
          </div>

          <form
            className="f6-sim-rodape"
            onSubmit={(e) => {
              e.preventDefault();
              enviar();
            }}
          >
            {anexo ? (
              <div className="f6-sim-anexo-card">
                {anexo.previaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={anexo.previaUrl} alt={anexo.fileName} />
                ) : (
                  <Icone nome="audios" className="icon-18" />
                )}
                <div style={{ flex: 1, fontSize: 12.5 }}>
                  <strong>{anexo.fileName}</strong>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAnexo(null)}>
                  Remover
                </button>
              </div>
            ) : null}

            <div className="f6-sim-acoes-rapidas">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={pendente || !dados.motorConfigurado}
                onClick={() => enviar('Oi! Quais opções vocês têm disponíveis?')}
              >
                Testar saudação / catálogo
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={pendente || !dados.motorConfigurado}
                onClick={() => enviar('Tô sem fone agora, não consigo ouvir áudio. Pode escrever?')}
              >
                Testar Skill S06 (recusa áudio)
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={pendente || !dados.motorConfigurado}
                onClick={() => enviar('Fechado, manda o PIX para pagamento!')}
              >
                Testar envio PIX
              </button>
            </div>

            <div className="f6-sim-entrada">
              <label className="btn btn-secondary btn-icon-only" title="Anexar foto ou áudio de teste">
                <Icone nome="clipe" />
                <span className="so-leitor-de-tela">Anexar foto ou áudio de teste</span>
                <input
                  type="file"
                  hidden
                  accept="image/jpeg,image/png,image/webp,audio/ogg,audio/mpeg,audio/mp4,audio/wav,audio/webm"
                  disabled={pendente || !dados.motorConfigurado}
                  onChange={(e) => {
                    void escolherAnexo(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              <label htmlFor="sim-mensagem" className="so-leitor-de-tela">
                Mensagem de teste
              </label>
              <textarea
                id="sim-mensagem"
                rows={1}
                className="campo"
                style={{ flex: 1 }}
                placeholder="Digite como um cliente no WhatsApp..."
                value={texto}
                disabled={pendente || !dados.motorConfigurado}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    enviar();
                  }
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={pendente || !dados.motorConfigurado || (!texto.trim() && !anexo)}>
                {pendente ? 'Pensando…' : 'Simular'}
              </button>
            </div>
          </form>
        </section>

        <aside className="panel" style={{ display: 'grid', gap: 12 }} aria-label="Contexto carregado na simulação">
          <h2 style={{ margin: 0, fontSize: 15 }}>Contexto carregado nesta IA</h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
            <li>
              <strong>Catálogo ativo:</strong> {dados.catalogo.filter((i) => i.active).length} itens
            </li>
            <li>
              <strong>Áudios liberados para IA:</strong> {dados.audios.filter((a) => a.aiEnabled).length} áudios
            </li>
            <li>
              <strong>PIX automático:</strong> {dados.pix.enabled ? `Ativo (${dados.pix.key})` : 'Desligado'}
            </li>
            <li>
              <strong>Histórico salvo:</strong> {historico.length}/40 mensagens
            </li>
          </ul>

          {telemetria ? (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'grid', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>Último turno</strong>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {telemetria.provedor} ({telemetria.modelo}) · {(telemetria.duracaoMs / 1000).toFixed(2)}s
              </p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setVerPrompt((v) => !v)}>
                {verPrompt ? 'Ocultar prompt e resposta bruta' : 'Inspecionar prompt e resposta bruta'}
              </button>
              {verPrompt ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div className="f6-codigo-mono" style={{ maxHeight: 160, overflowY: 'auto' }}>
                    <strong>Resposta bruta:</strong>
                    {'\n'}
                    {telemetria.bruta}
                  </div>
                  <div className="f6-codigo-mono" style={{ maxHeight: 220, overflowY: 'auto' }}>
                    <strong>Prompt enviado:</strong>
                    {'\n'}
                    {telemetria.instrucoes}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
