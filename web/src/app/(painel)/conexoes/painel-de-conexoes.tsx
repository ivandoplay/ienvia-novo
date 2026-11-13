'use client';

import { useEffect, useId, useState, useSyncExternalStore, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import type { DadosDasConexoes, ExecutorLocalItem } from '@/lib/dados/motor';
import {
  criarCodigoPareamentoLocal,
  renomearExecutorLocal,
  revogarExecutorLocal,
} from './acoes';

interface Props {
  dados: DadosDasConexoes;
  podeEditar: boolean;
}

interface PareamentoAtivo {
  executorId: string;
  displayName: string;
  codigo: string;
  expiraEm: string;
}

type AbaSistema = 'windows' | 'linux' | 'termux';

function formatarRelativo(iso: string | null): string {
  if (!iso) return 'Ainda não comunicou';
  const diffMin = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(diffMin) || diffMin < 0) return 'Agora mesmo';
  if (diffMin < 1) return 'Agora mesmo';
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHoras = Math.floor(diffMin / 60);
  if (diffHoras < 24) return `há ${diffHoras} h`;
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function statusDoExecutor(exec: ExecutorLocalItem): { texto: string; tom: 'ok' | 'atencao' | 'neutro' } {
  if (exec.status === 'pending_pair') return { texto: 'Aguardando pareamento', tom: 'atencao' };
  if (exec.online) return { texto: 'Online', tom: 'ok' };
  return { texto: 'Offline', tom: 'neutro' };
}

export function PainelDeConexoes({ dados, podeEditar }: Props) {
  const router = useRouter();
  const idApelido = useId();
  const origem = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => 'https://SEU-PAINEL',
  );
  const [abaSo, setAbaSo] = useState<AbaSistema>('windows');
  const [modalParear, setModalParear] = useState(false);
  const [modalRevogar, setModalRevogar] = useState<ExecutorLocalItem | null>(null);
  const [modalRenomear, setModalRenomear] = useState<ExecutorLocalItem | null>(null);
  const [apelidoNovo, setApelidoNovo] = useState('Meu computador');
  const [apelidoEditado, setApelidoEditado] = useState('');
  const [pareamento, setPareamento] = useState<PareamentoAtivo | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  const [recado, setRecado] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, iniciar] = useTransition();

  const executorDoPareamento = pareamento
    ? dados.executores.find((e) => e.id === pareamento.executorId) ?? null
    : null;
  const pareamentoAtivo =
    pareamento && (!executorDoPareamento || executorDoPareamento.status === 'pending_pair') ? pareamento : null;
  const pareamentoConcluidoNome =
    pareamento && executorDoPareamento && executorDoPareamento.status !== 'pending_pair'
      ? executorDoPareamento.displayName
      : null;

  // Enquanto houver código de pareamento pendente, atualiza a lista automaticamente a cada 5s.
  const temPendente = Boolean(pareamentoAtivo) || dados.executores.some((e) => e.status === 'pending_pair');
  useEffect(() => {
    if (!temPendente) return;
    const timer = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [temPendente, router]);

  const executoresOnline = dados.executores.filter((e) => e.online).length;
  const executoresPareados = dados.executores.filter((e) => e.status !== 'pending_pair').length;
  const chipsConectados = dados.chipsLocais.filter((c) => c.status === 'connected').length;

  async function copiarTexto(chave: string, texto: string) {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(chave);
      setTimeout(() => setCopiado((atual) => (atual === chave ? null : atual)), 2200);
    } catch {
      setRecado({ tipo: 'erro', texto: 'Não foi possível copiar automaticamente. Selecione e copie o texto.' });
    }
  }

  function aoGerarPareamento(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setRecado(null);
    iniciar(async () => {
      const res = await criarCodigoPareamentoLocal(apelidoNovo).catch(() => null);
      if (!res) {
        setRecado({ tipo: 'erro', texto: 'Não foi possível falar com o painel agora.' });
        return;
      }
      if (!res.ok) {
        setRecado({ tipo: 'erro', texto: res.erro });
        return;
      }
      setModalParear(false);
      setPareamento({
        executorId: res.executorId,
        displayName: res.displayName,
        codigo: res.codigo,
        expiraEm: res.expiraEm,
      });
      setRecado({ tipo: 'ok', texto: 'Código de pareamento gerado! Use-o no Motor local nos próximos 15 minutos.' });
      router.refresh();
    });
  }

  function aoRenomear(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!modalRenomear) return;
    const alvo = modalRenomear;
    setRecado(null);
    iniciar(async () => {
      const res = await renomearExecutorLocal(alvo.id, apelidoEditado).catch(() => null);
      if (!res || !res.ok) {
        setRecado({ tipo: 'erro', texto: res?.erro ?? 'Erro ao renomear aparelho.' });
        return;
      }
      setModalRenomear(null);
      setRecado({ tipo: 'ok', texto: 'Nome do aparelho atualizado.' });
      router.refresh();
    });
  }

  function aoRevogar(executor: ExecutorLocalItem) {
    setRecado(null);
    iniciar(async () => {
      const res = await revogarExecutorLocal(executor.id).catch(() => null);
      setModalRevogar(null);
      if (!res || !res.ok) {
        setRecado({ tipo: 'erro', texto: res?.erro ?? 'Não foi possível revogar o aparelho.' });
        return;
      }
      if (pareamento?.executorId === executor.id) setPareamento(null);
      setRecado({ tipo: 'ok', texto: `Aparelho "${executor.displayName}" revogado. Os chips ligados a ele foram desconectados.` });
      router.refresh();
    });
  }

  const codigoParaExemplo = pareamentoAtivo?.codigo ?? 'IENV-XXXX-XXXX';
  const comandoUnix = `./scripts/iniciar.sh --url ${origem} --pair ${codigoParaExemplo}`;
  const comandoWindows = `.\\scripts\\iniciar.bat --url ${origem} --pair ${codigoParaExemplo}`;

  return (
    <div className="conexoes-page">
      <div className="page-header">
        <div>
          <h1>Conexões / Motor</h1>
          <p>Rode o motor oficial no seu computador, VPS ou celular (Termux) sem pagar servidor externo.</p>
        </div>
        <Link href="/instancias" className="btn btn-secondary">
          <Icone nome="instancias" className="icon-15" />
          Ver instâncias
        </Link>
      </div>

      {dados.falhou && (
        <p className="aviso aviso--erro" role="alert">
          Não foi possível carregar todas as informações de conexão agora. Atualize em instantes.
        </p>
      )}
      {!podeEditar && (
        <p className="aviso">Só o dono da conta pode gerar códigos de pareamento ou revogar aparelhos.</p>
      )}
      {pareamentoConcluidoNome && (
        <p className="aviso aviso--ok" role="status">
          Aparelho &ldquo;{pareamentoConcluidoNome}&rdquo; pareado e conectado com sucesso!
        </p>
      )}
      {recado && !pareamentoConcluidoNome && (
        <p className={`aviso ${recado.tipo === 'ok' ? 'aviso--ok' : 'aviso--erro'}`} role={recado.tipo === 'ok' ? 'status' : 'alert'}>
          {recado.texto}
        </p>
      )}

      <div className="conexoes-barra" aria-label="Resumo do motor local">
        <div className="seg-status">
          <span className={`seg-dot ${executoresOnline > 0 ? 'seg-dot--ok' : executoresPareados > 0 ? 'seg-dot--aviso' : ''}`} />
          <span>Motor local:</span>
          <strong>
            {executoresOnline > 0
              ? `${executoresOnline} ${executoresOnline === 1 ? 'aparelho online' : 'aparelhos online'}`
              : executoresPareados > 0
                ? 'Offline'
                : 'Nenhum pareado'}
          </strong>
        </div>

        <div className="seg-status">
          <span className={`seg-dot ${chipsConectados > 0 ? 'seg-dot--ok' : ''}`} />
          <span>Chips locais:</span>
          <strong>
            {chipsConectados} de {dados.chipsLocais.length} conectados
          </strong>
        </div>

        <div className="seg-status">
          <span className={`seg-dot ${dados.pacoteDisponivel ? 'seg-dot--ok' : 'seg-dot--aviso'}`} />
          <span>Versão oficial:</span>
          <strong>v{dados.versaoDisponivel}</strong>
        </div>
      </div>

      <div className="conf-grade">
        <section className="panel motor-card" aria-labelledby="titulo-versao-motor">
          <div className="motor-card-topo">
            <div>
              <h2 id="titulo-versao-motor">Versão &amp; Atualização</h2>
              <p className="motor-card-sub">
                Pacote oficial autossuficiente com verificação de integridade e atualização segura sem apagar suas sessões.
              </p>
            </div>
            <span className={`estado ${dados.assinaturaAtiva ? 'estado--ok' : 'estado--atencao'}`}>
              {dados.assinaturaAtiva ? 'Ed25519 verificado' : 'Chave pendente'}
            </span>
          </div>

          <div className="motor-versao-caixa">
            <div>
              <div className="motor-versao-numero">v{dados.versaoDisponivel}</div>
              <p className="motor-card-sub">Versão mais recente publicada neste painel</p>
            </div>
            {dados.pacoteDisponivel ? (
              <a href="/api/motor/pacote" className="btn btn-primary" download>
                <Icone nome="atualizar" className="icon-15" />
                Baixar motor v{dados.versaoDisponivel} (.zip)
              </a>
            ) : (
              <span className="estado estado--erro">Pacote indisponível</span>
            )}
          </div>

          <div className="motor-meta-lista">
            <span>Compatível com Windows, Linux e Android (Termux)</span>
            <span>Auto-update preserva sessões em data/</span>
          </div>
        </section>

        <section className="panel motor-card" aria-labelledby="titulo-dispositivos">
          <div className="motor-card-topo">
            <div>
              <h2 id="titulo-dispositivos">Dispositivos conectados</h2>
              <p className="motor-card-sub">
                Cada computador ou celular pareado recebe um token único e só enxerga os chips ligados a ele.
              </p>
            </div>
            {podeEditar && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={ocupado}
                onClick={() => {
                  setApelidoNovo(`Aparelho ${dados.executores.length + 1}`);
                  setModalParear(true);
                }}
              >
                <Icone nome="adicionar" className="icon-15" />
                Parear dispositivo
              </button>
            )}
          </div>

          {pareamentoAtivo && (
            <div className="pareamento-banner" role="status">
              <div className="pareamento-codigo-linha">
                <div>
                  <div className="campo-dica">Código único para <strong>{pareamentoAtivo.displayName}</strong> (vale por 15 min)</div>
                  <div className="pareamento-codigo">{pareamentoAtivo.codigo}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => copiarTexto('codigo', pareamentoAtivo.codigo)}
                >
                  {copiado === 'codigo' ? 'Copiado!' : 'Copiar código'}
                </button>
              </div>
              <div className="pareamento-comando">
                <code>{abaSo === 'windows' ? comandoWindows : comandoUnix}</code>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => copiarTexto('cmd', abaSo === 'windows' ? comandoWindows : comandoUnix)}
                >
                  {copiado === 'cmd' ? 'Copiado!' : 'Copiar comando'}
                </button>
              </div>
            </div>
          )}

          {dados.executores.length === 0 ? (
            <div className="empty-state">
              Nenhum dispositivo pareado ainda. Clique em <strong>Parear dispositivo</strong> para gerar um código único de uso local.
            </div>
          ) : (
            <div className="executores-lista">
              {dados.executores.map((exec) => {
                const st = statusDoExecutor(exec);
                return (
                  <article key={exec.id} className="executor-item">
                    <div className="executor-info">
                      <div className="executor-nome-linha">
                        <strong>{exec.displayName}</strong>
                        <span className={`estado estado--${st.tom}`}>{st.texto}</span>
                      </div>
                      <div className="executor-detalhes">
                        <span>{exec.platformLabel}</span>
                        <span>{exec.motorVersion ? `v${exec.motorVersion}` : 'Versão não informada'}</span>
                        <span>
                          {exec.chipsCount} {exec.chipsCount === 1 ? 'chip' : 'chips'}
                        </span>
                        <span>Visto: {formatarRelativo(exec.lastSeenAt)}</span>
                      </div>
                    </div>

                    {podeEditar && (
                      <div className="executor-acoes">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={ocupado}
                          onClick={() => {
                            setApelidoEditado(exec.displayName);
                            setModalRenomear(exec);
                          }}
                        >
                          Renomear
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={ocupado}
                          onClick={() => setModalRevogar(exec)}
                        >
                          Revogar
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="panel motor-card" aria-labelledby="titulo-instalacao">
        <div className="motor-card-topo">
          <div>
            <h2 id="titulo-instalacao">Motor WhatsApp Oficial — Instalação Rápida</h2>
            <p className="motor-card-sub">
              Escolha o sistema do dispositivo onde o motor vai ficar rodando 24h. Não precisa saber programação.
            </p>
          </div>
          <div className="motor-abas" role="tablist" aria-label="Sistema operacional">
            <button
              type="button"
              role="tab"
              aria-selected={abaSo === 'windows'}
              className="motor-aba"
              onClick={() => setAbaSo('windows')}
            >
              Windows
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={abaSo === 'linux'}
              className="motor-aba"
              onClick={() => setAbaSo('linux')}
            >
              Linux / VPS
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={abaSo === 'termux'}
              className="motor-aba"
              onClick={() => setAbaSo('termux')}
            >
              Android (Termux)
            </button>
          </div>
        </div>

        <div className="motor-guia">
          {abaSo === 'windows' && (
            <ol>
              <li>
                Baixe e extraia o arquivo <strong>ienvia-motor-v{dados.versaoDisponivel}.zip</strong> em uma pasta fixa (ex.:{' '}
                <code>C:\ienvia-motor</code>).
              </li>
              <li>
                Abra a pasta no PowerShell e execute o instalador (ele baixa o Node 22 portátil só para o motor, sem pedir
                administrador):
                <pre>PowerShell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1</pre>
              </li>
              <li>
                Pareie e inicie o motor com o código gerado acima:
                <pre>{comandoWindows}</pre>
              </li>
              <li>
                Depois do pareamento, nas <strong>Instâncias</strong> clique em <strong>Adicionar chip</strong> → escolha{' '}
                <strong>Motor local (Baileys)</strong> e leia o QR Code ou código de 8 dígitos normalmente!
              </li>
            </ol>
          )}

          {abaSo === 'linux' && (
            <ol>
              <li>
                Baixe o pacote diretamente no servidor ou PC:
                <pre>{`curl -fsSL ${origem}/api/motor/pacote -o ienvia-motor.zip && unzip ienvia-motor.zip && cd ienvia-motor`}</pre>
              </li>
              <li>
                Rode o setup automático (verifica Node 22+ e baixa portátil em <code>.runtime/node</code> se precisar):
                <pre>bash ./scripts/setup-linux.sh</pre>
              </li>
              <li>
                Inicie e pareie com o painel:
                <pre>{comandoUnix}</pre>
              </li>
            </ol>
          )}

          {abaSo === 'termux' && (
            <ol>
              <li>
                Instale o <strong>Termux</strong> (via F-Droid ou GitHub) no celular e habilite o wake-lock para o sistema não
                dormir o processo:
                <pre>termux-wake-lock</pre>
              </li>
              <li>
                Baixe o pacote, extraia e instale o ambiente Termux + Node:
                <pre>{`pkg update -y && pkg install -y curl unzip nodejs-lts\ncurl -fsSL ${origem}/api/motor/pacote -o ienvia-motor.zip && unzip -o ienvia-motor.zip && cd ienvia-motor\nbash ./scripts/setup-termux.sh`}</pre>
              </li>
              <li>
                Pareie e ligue o motor no aparelho:
                <pre>{comandoUnix}</pre>
              </li>
            </ol>
          )}
        </div>
      </section>

      {modalParear && (
        <Dialogo titulo="Parear novo dispositivo" aoFechar={() => setModalParear(false)}>
          <form onSubmit={aoGerarPareamento}>
            <div className="form-group">
              <label className="form-label" htmlFor={idApelido}>
                Nome do dispositivo
              </label>
              <input
                id={idApelido}
                className="campo"
                type="text"
                maxLength={80}
                value={apelidoNovo}
                onChange={(e) => setApelidoNovo(e.target.value)}
                placeholder="Ex.: PC da Loja ou Celular Termux"
                required
              />
              <p className="campo-dica">Você poderá gerar um código único válido por 15 minutos e revogar quando quiser.</p>
            </div>
            <div className="dialogo-acoes" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setModalParear(false)} disabled={ocupado}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={ocupado}>
                {ocupado ? 'Gerando…' : 'Gerar código de pareamento'}
              </button>
            </div>
          </form>
        </Dialogo>
      )}

      {modalRenomear && (
        <Dialogo titulo="Renomear dispositivo" aoFechar={() => setModalRenomear(null)}>
          <form onSubmit={aoRenomear}>
            <div className="form-group">
              <label className="form-label" htmlFor={`${idApelido}-editar`}>
                Novo nome
              </label>
              <input
                id={`${idApelido}-editar`}
                className="campo"
                type="text"
                maxLength={80}
                value={apelidoEditado}
                onChange={(e) => setApelidoEditado(e.target.value)}
                required
              />
            </div>
            <div className="dialogo-acoes" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setModalRenomear(null)} disabled={ocupado}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={ocupado}>
                {ocupado ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </form>
        </Dialogo>
      )}

      {modalRevogar && (
        <Dialogo titulo="Revogar dispositivo" aoFechar={() => setModalRevogar(null)}>
          <p className="dialogo-texto">
            O dispositivo <strong>{modalRevogar.displayName}</strong> perderá imediatamente o acesso ao painel. Os chips ligados a
            ele serão desconectados até você ligá-los a outro aparelho.
          </p>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setModalRevogar(null)} disabled={ocupado}>
              Cancelar
            </button>
            <button type="button" className="btn btn-danger" onClick={() => aoRevogar(modalRevogar)} disabled={ocupado}>
              {ocupado ? 'Revogando…' : 'Revogar aparelho'}
            </button>
          </div>
        </Dialogo>
      )}
    </div>
  );
}
