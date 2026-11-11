'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import type { ChipDaInbox, ConversaAberta, FiltrosDaInbox, ListaDaInbox, MensagemDaConversa } from '@/lib/dados/inbox';
import { plural } from '@/lib/formato';
import {
  BUSCA_MAXIMA,
  TEXTO_MAXIMO,
  VISOES,
  descreverEtapa,
  enderecoDaInbox,
  horaDaMensagem,
  lerBusca,
  proximoLimite,
  proximoLimiteDeMensagens,
  type SituacaoDoEnvio,
} from '@/lib/inbox/regras';
import { descreverEstado } from '@/lib/instancias/regras';
import { decidirEnvio, enviarMensagem, mudarConversa, type ResultadoDoEnvio } from './acoes';

interface Props {
  workspaceId: string;
  /** Muda quando qualquer conversa ou chip da empresa muda. `null` quando não deu para ler. */
  versao: string | null;
  filtros: FiltrosDaInbox;
  lista: ListaDaInbox;
  chips: ChipDaInbox[];
  /** Conversa pedida no endereço (?c=...). */
  conversaId: string | null;
  aberta: { conversa: ConversaAberta | null; falhou: boolean } | null;
  limiteDeMensagens: number;
  ehDono: boolean;
  evolutionConfigurada: boolean;
}

/**
 * Mensagem que a pessoa acabou de mandar e que o servidor ainda não devolveu.
 *   enviando     — esperando a resposta do painel;
 *   recusada     — o painel não aceitou (nada foi criado nem enviado);
 *   sem_resposta — a conexão caiu antes de a resposta chegar.
 */
interface Pendente {
  chave: string;
  conversaId: string;
  texto: string;
  hora: string;
  criadaEm: number;
  fase: 'enviando' | 'recusada' | 'sem_resposta';
  erro?: string;
  /** Preenchido quando o painel respondeu; a partir daí a mensagem que vem do banco assume o lugar. */
  mensagemId?: string;
  situacao?: SituacaoDoEnvio;
}

interface Aviso {
  tipo: 'erro' | 'atencao';
  texto: string;
}

/** De quanto em quanto tempo a tela pergunta se chegou algo novo (só com a aba visível). */
const INTERVALO_DE_NOVIDADES = 4_000;

/** O que a pessoa estava escrevendo em cada conversa, para não perder ao trocar de conversa. */
const rascunhos = new Map<string, string>();

/** Chave única de um envio. Repetir o pedido com a mesma chave nunca manda a mensagem duas vezes. */
function novaChave(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Pergunta ao painel, de tempos em tempos, se algo mudou; quando muda, recarrega os dados da tela
 * (sem perder o que a pessoa está escrevendo).
 */
function useNovidades(workspaceId: string, versao: string | null): void {
  const router = useRouter();
  const versaoNaTela = useRef(versao);

  useEffect(() => {
    versaoNaTela.current = versao;
  }, [versao]);

  useEffect(() => {
    let desmontado = false;
    let perguntando = false;
    let ultimaRecarga = 0;
    let pausadoAte = 0;

    async function conferir() {
      if (desmontado || perguntando || document.visibilityState !== 'visible' || Date.now() < pausadoAte) return;
      perguntando = true;
      try {
        const resposta = await fetch(`/api/inbox/versao?w=${encodeURIComponent(workspaceId)}`, { cache: 'no-store' });
        if (desmontado) return;
        if (resposta.status === 401) {
          // A sessão acabou: recarregar leva para a tela de login.
          pausadoAte = Date.now() + 30_000;
          router.refresh();
          return;
        }
        if (!resposta.ok) return;
        const corpo = (await resposta.json()) as { versao?: unknown };
        if (desmontado || typeof corpo.versao !== 'string') return;

        const conhecida = versaoNaTela.current;
        const desdeAUltima = Date.now() - ultimaRecarga;
        // Sem versão na tela (a leitura falhou ao abrir), tenta de novo de vez em quando.
        const mudou = conhecida === null ? desdeAUltima > 30_000 : corpo.versao !== conhecida;
        if (mudou && desdeAUltima > 2_000) {
          ultimaRecarga = Date.now();
          router.refresh();
        }
      } catch {
        // Sem internet por um instante: a próxima pergunta resolve.
      } finally {
        perguntando = false;
      }
    }

    const relogio = setInterval(() => void conferir(), INTERVALO_DE_NOVIDADES);
    const aoVoltar = () => void conferir();
    document.addEventListener('visibilitychange', aoVoltar);
    window.addEventListener('focus', aoVoltar);
    return () => {
      desmontado = true;
      clearInterval(relogio);
      document.removeEventListener('visibilitychange', aoVoltar);
      window.removeEventListener('focus', aoVoltar);
    };
  }, [workspaceId, router]);
}

export function PainelDaInbox({
  workspaceId,
  versao,
  filtros,
  lista,
  chips,
  conversaId,
  aberta,
  limiteDeMensagens,
  ehDono,
  evolutionConfigurada,
}: Props) {
  const router = useRouter();
  const [pendentes, setPendentes] = useState<Pendente[]>([]);
  const [avisos, setAvisos] = useState<Record<string, Aviso | undefined>>({});

  useNovidades(workspaceId, versao);

  const avisar = useCallback((conversa: string, aviso: Aviso | null) => {
    setAvisos((atuais) => ({ ...atuais, [conversa]: aviso ?? undefined }));
  }, []);

  const enviar = useCallback(
    async (conversa: string, texto: string, chaveExistente?: string) => {
      const chave = chaveExistente ?? novaChave();
      const agora = Date.now();
      setPendentes((atuais) => [
        // Faxina: o que o painel já respondeu há mais de dois minutos não precisa mais ficar guardado.
        ...atuais.filter((item) => item.chave !== chave && !(item.mensagemId && agora - item.criadaEm > 120_000)),
        { chave, conversaId: conversa, texto, hora: horaDaMensagem(new Date(agora).toISOString()), criadaEm: agora, fase: 'enviando' },
      ]);
      avisar(conversa, null);

      const mudar = (mudanca: Partial<Pendente>) =>
        setPendentes((atuais) => atuais.map((item) => (item.chave === chave ? { ...item, ...mudanca } : item)));

      let resultado: ResultadoDoEnvio;
      try {
        resultado = await enviarMensagem({ conversaId: conversa, texto, chave });
      } catch {
        mudar({ fase: 'sem_resposta' });
        router.refresh();
        return;
      }

      if (!resultado.ok) {
        mudar({ fase: 'recusada', erro: resultado.erro });
        return;
      }
      mudar({ fase: 'enviando', mensagemId: resultado.mensagemId, situacao: resultado.situacao });
      if (resultado.aviso) avisar(conversa, { tipo: 'erro', texto: resultado.aviso });
      router.refresh();
    },
    [avisar, router],
  );

  const descartar = useCallback((chave: string) => {
    setPendentes((atuais) => atuais.filter((item) => item.chave !== chave));
  }, []);

  const conversa = aberta?.conversa ?? null;
  const enderecoDaLista = enderecoDaInbox({ ...filtros, conversaId: null });

  return (
    <div className="inbox" data-aberta={conversaId ? 'sim' : 'nao'}>
      <div className="page-header inbox-titulo">
        <div>
          <h1>Inbox</h1>
          <p>As conversas do WhatsApp dos seus chips, num lugar só.</p>
        </div>
      </div>

      <div className={`inbox-grade${conversa ? ' inbox-grade--com-contato' : ''}`}>
        <ListaDeConversas lista={lista} filtros={filtros} chips={chips} conversaId={conversaId} ehDono={ehDono} />

        {conversa ? (
          <Conversa
            key={conversa.id}
            conversa={conversa}
            filtros={filtros}
            limiteDeMensagens={limiteDeMensagens}
            enderecoDaLista={enderecoDaLista}
            pendentes={pendentes}
            aviso={avisos[conversa.id] ?? null}
            aoAvisar={avisar}
            aoEnviar={enviar}
            aoDescartar={descartar}
            ehDono={ehDono}
            evolutionConfigurada={evolutionConfigurada}
          />
        ) : (
          <section className="inbox-conversa inbox-conversa--vazia" aria-label="Conversa">
            {conversaId ? (
              <div className="inbox-vazio">
                <strong>{aberta?.falhou ? 'Não foi possível abrir esta conversa agora' : 'Esta conversa não existe mais'}</strong>
                <p>
                  {aberta?.falhou
                    ? 'Nada foi alterado. Espere um instante e tente de novo.'
                    : 'Ela pode ter sido apagada, ou o endereço está incompleto.'}
                </p>
                <Link href={enderecoDaLista} className="btn btn-secondary btn-sm" prefetch={false}>
                  Voltar para as conversas
                </Link>
              </div>
            ) : (
              <div className="inbox-vazio">
                <Icone nome="inbox" />
                <strong>Selecione uma conversa</strong>
                <p>Escolha uma conversa na lista ao lado para ler e responder.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Coluna 1: lista de conversas                                               */
/* -------------------------------------------------------------------------- */

interface PropsDaLista {
  lista: ListaDaInbox;
  filtros: FiltrosDaInbox;
  chips: ChipDaInbox[];
  conversaId: string | null;
  ehDono: boolean;
}

function ListaDeConversas({ lista, filtros, chips, conversaId, ehDono }: PropsDaLista) {
  const router = useRouter();
  const idBusca = useId();
  const idChip = useId();
  const idTitulo = useId();

  const ir = (mudancas: Partial<FiltrosDaInbox>) =>
    enderecoDaInbox({ ...filtros, limite: null, conversaId, ...mudancas });

  function buscar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const digitado = new FormData(evento.currentTarget).get('busca');
    router.push(ir({ busca: lerBusca(digitado) }));
  }

  const chipsAtivos = chips.filter((chip) => !chip.removido);
  const chipsRemovidos = chips.filter((chip) => chip.removido);
  const chipDoFiltro = chips.find((chip) => chip.id === filtros.chipId);
  const mostrarChipNoItem = chips.length > 1 && !filtros.chipId;
  const contagem = (valor: string): number | null =>
    valor === 'nao-lidas' ? (lista.contagens?.naoLidas ?? null) : valor === 'esperando' ? (lista.contagens?.esperando ?? null) : null;
  const proximo = lista.temMais ? proximoLimite(filtros.limite) : null;

  return (
    <section className="inbox-lista" aria-labelledby={idTitulo}>
      <div className="inbox-lista-topo">
        <form className="inbox-busca" role="search" action="/inbox" method="get" onSubmit={buscar}>
          {filtros.visao !== 'ativas' ? <input type="hidden" name="ver" value={filtros.visao} /> : null}
          {filtros.chipId ? <input type="hidden" name="chip" value={filtros.chipId} /> : null}
          <label htmlFor={idBusca} className="so-leitor-de-tela">
            Buscar conversa
          </label>
          <input
            // Ao limpar a busca pelo endereço, o campo volta a ficar vazio.
            key={filtros.busca ?? ''}
            id={idBusca}
            className="campo"
            type="search"
            name="busca"
            defaultValue={filtros.busca ?? ''}
            maxLength={BUSCA_MAXIMA}
            placeholder="Buscar nome, número ou mensagem"
            autoComplete="off"
            enterKeyHint="search"
          />
          <button type="submit" className="btn btn-secondary btn-icon-only">
            <Icone nome="busca" className="icon-15" />
            <span className="so-leitor-de-tela">Buscar</span>
          </button>
        </form>

        <nav className="inbox-filtros" aria-label="Filtros das conversas">
          {VISOES.map((visao) => {
            const ativo = !filtros.busca && filtros.visao === visao.valor;
            const quantidade = contagem(visao.valor);
            return (
              <Link
                key={visao.valor}
                href={ir({ visao: visao.valor, busca: null })}
                className={`inbox-filtro${ativo ? ' inbox-filtro--ativo' : ''}`}
                aria-current={ativo ? 'true' : undefined}
                prefetch={false}
                scroll={false}
              >
                {visao.rotulo}
                {quantidade ? <span className="inbox-filtro-numero">{quantidade > 99 ? '99+' : quantidade}</span> : null}
              </Link>
            );
          })}
        </nav>

        {chips.length > 1 || filtros.chipId ? (
          <div className="inbox-ver-por-chip">
            <label htmlFor={idChip}>Ver por chip</label>
            <select
              id={idChip}
              className="campo"
              value={filtros.chipId ?? ''}
              onChange={(evento) => router.push(ir({ chipId: evento.target.value || null }))}
            >
              <option value="">Todos os chips</option>
              {chipsAtivos.map((chip) => (
                <option key={chip.id} value={chip.id}>
                  {chip.apelido}
                </option>
              ))}
              {chipsRemovidos.length > 0 ? (
                <optgroup label="Chips removidos (histórico)">
                  {chipsRemovidos.map((chip) => (
                    <option key={chip.id} value={chip.id}>
                      {chip.apelido}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {filtros.chipId && !chipDoFiltro ? <option value={filtros.chipId}>Chip desconhecido</option> : null}
            </select>
          </div>
        ) : null}
      </div>

      <div className="inbox-lista-cabecalho">
        <h2 id={idTitulo}>{filtros.busca ? 'Resultado da busca' : 'Fila de atendimento'}</h2>
        {lista.falhou ? null : (
          <span>
            {lista.temMais ? 'mais de ' : ''}
            {plural(lista.conversas.length, 'conversa', 'conversas')}
          </span>
        )}
      </div>

      {filtros.busca ? (
        <p className="inbox-busca-ativa">
          Procurando <strong>“{filtros.busca}”</strong> em todas as conversas.{' '}
          <Link href={ir({ busca: null })} prefetch={false} scroll={false}>
            Limpar busca
          </Link>
        </p>
      ) : null}

      {lista.falhou ? (
        <div className="inbox-vazio" role="alert">
          <strong>Não foi possível carregar as conversas agora</strong>
          <p>Nada foi alterado. Espere um instante e tente de novo.</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => router.refresh()}>
            Tentar de novo
          </button>
        </div>
      ) : lista.conversas.length === 0 ? (
        <ListaVazia filtros={filtros} temChip={chipsAtivos.length > 0} ehDono={ehDono} />
      ) : (
        <ul className="inbox-itens">
          {lista.conversas.map((item) => {
            const etapa = descreverEtapa(item.etapa);
            return (
              <li key={item.id}>
                <Link
                  href={enderecoDaInbox({ ...filtros, conversaId: item.id })}
                  className={`inbox-item${item.naoLidas > 0 ? ' inbox-item--nao-lida' : ''}`}
                  aria-current={item.id === conversaId ? 'true' : undefined}
                  prefetch={false}
                  scroll={false}
                >
                  <span className="inbox-avatar" aria-hidden="true">
                    {item.iniciais}
                  </span>
                  <span className="inbox-item-corpo">
                    <span className="inbox-item-linha">
                      <span className="inbox-item-nome">{item.nome}</span>
                      <span className="inbox-item-quando">{item.quando}</span>
                    </span>
                    <span className="inbox-item-linha">
                      <span className="inbox-item-previa">{item.previa || 'Sem mensagens ainda'}</span>
                      {item.naoLidas > 0 ? (
                        <span className="inbox-nao-lidas">
                          <span aria-hidden="true">{item.naoLidas > 99 ? '99+' : item.naoLidas}</span>
                          <span className="so-leitor-de-tela">{plural(item.naoLidas, 'mensagem não lida', 'mensagens não lidas')}</span>
                        </span>
                      ) : null}
                    </span>
                    <span className="inbox-item-etiquetas">
                      <span className={`inbox-etiqueta inbox-etiqueta--${etapa.tom}`}>{etapa.texto}</span>
                      {mostrarChipNoItem && item.chipNome ? <span className="inbox-etiqueta">{item.chipNome}</span> : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {proximo ? (
        <div className="inbox-ver-mais">
          <Link
            href={enderecoDaInbox({ ...filtros, limite: proximo, conversaId })}
            className="btn btn-secondary btn-sm"
            prefetch={false}
            scroll={false}
          >
            Ver mais conversas
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function ListaVazia({ filtros, temChip, ehDono }: { filtros: FiltrosDaInbox; temChip: boolean; ehDono: boolean }) {
  if (filtros.busca) {
    return (
      <div className="inbox-vazio">
        <strong>Nada encontrado</strong>
        <p>Nenhuma conversa tem “{filtros.busca}” no nome, no número ou na última mensagem.</p>
      </div>
    );
  }
  if (filtros.visao === 'nao-lidas') {
    return (
      <div className="inbox-vazio">
        <strong>Tudo lido</strong>
        <p>Não há mensagens esperando leitura{filtros.chipId ? ' neste chip' : ''}.</p>
      </div>
    );
  }
  if (filtros.visao === 'esperando') {
    return (
      <div className="inbox-vazio">
        <strong>Ninguém esperando você</strong>
        <p>Quando um cliente escrever e a resposta for sua, a conversa aparece aqui.</p>
      </div>
    );
  }
  if (filtros.visao === 'resolvidas') {
    return (
      <div className="inbox-vazio">
        <strong>Nenhuma conversa resolvida</strong>
        <p>As conversas que você marcar como resolvidas ficam guardadas aqui.</p>
      </div>
    );
  }
  if (filtros.chipId) {
    return (
      <div className="inbox-vazio">
        <strong>Nenhuma conversa em aberto neste chip</strong>
        <p>Quando alguém escrever para este chip, a conversa aparece aqui.</p>
      </div>
    );
  }
  return (
    <div className="inbox-vazio">
      <strong>Nenhuma conversa em aberto</strong>
      {temChip ? (
        <p>Quando alguém escrever para um dos seus chips, a conversa aparece aqui.</p>
      ) : (
        <>
          <p>
            {ehDono
              ? 'Conecte um chip de WhatsApp para as conversas começarem a chegar.'
              : 'Esta conta ainda não tem um chip de WhatsApp conectado. Peça ao dono da conta para conectar.'}
          </p>
          {ehDono ? (
            <Link href="/instancias" className="btn btn-primary btn-sm">
              Conectar um chip
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Colunas 2 e 3: conversa aberta e dados do contato                          */
/* -------------------------------------------------------------------------- */

interface PropsDaConversa {
  conversa: ConversaAberta;
  filtros: FiltrosDaInbox;
  limiteDeMensagens: number;
  enderecoDaLista: string;
  pendentes: Pendente[];
  aviso: Aviso | null;
  aoAvisar: (conversaId: string, aviso: Aviso | null) => void;
  aoEnviar: (conversaId: string, texto: string, chaveExistente?: string) => Promise<void>;
  aoDescartar: (chave: string) => void;
  ehDono: boolean;
  evolutionConfigurada: boolean;
}

function Conversa({
  conversa,
  filtros,
  limiteDeMensagens,
  enderecoDaLista,
  pendentes,
  aviso,
  aoAvisar,
  aoEnviar,
  aoDescartar,
  ehDono,
  evolutionConfigurada,
}: PropsDaConversa) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState<'resolver' | 'reabrir' | null>(null);
  const [decidindo, setDecidindo] = useState<string | null>(null);
  const [contatoAberto, setContatoAberto] = useState(false);
  /** Texto colocado no campo por um "tentar de novo". Cada pedido tem um número, para o campo recomeçar. */
  const [preenchimento, setPreenchimento] = useState<{ texto: string; vez: number } | null>(null);

  const titulo = useRef<HTMLHeadingElement>(null);
  const rolagem = useRef<HTMLDivElement>(null);
  const pertoDoFim = useRef(true);

  const idsDoBanco = new Set(conversa.mensagens.map((mensagem) => mensagem.id));
  const meusPendentes = pendentes.filter(
    (item) => item.conversaId === conversa.id && !(item.mensagemId && idsDoBanco.has(item.mensagemId)),
  );
  const ultimaMensagem = conversa.mensagens.at(-1)?.id ?? '';
  const marcaDeRolagem = `${conversa.mensagens.length}:${ultimaMensagem}:${meusPendentes.length}`;

  // Ao abrir, e sempre que chega algo novo com a pessoa já no fim, a conversa rola até a última mensagem.
  useLayoutEffect(() => {
    const area = rolagem.current;
    if (area && pertoDoFim.current) area.scrollTop = area.scrollHeight;
  }, [marcaDeRolagem]);

  // No celular a lista some quando a conversa abre: o foco vai para o nome do contato.
  useEffect(() => {
    if (window.matchMedia('(max-width: 900px)').matches) titulo.current?.focus({ preventScroll: true });
  }, []);

  // Abrir a conversa (com a aba visível) marca as mensagens como lidas.
  useEffect(() => {
    if (conversa.naoLidas === 0) return;
    let feito = false;
    const marcar = () => {
      if (feito || document.visibilityState !== 'visible') return;
      feito = true;
      mudarConversa({ conversaId: conversa.id, acao: 'marcar_lida' }).catch(() => {
        // Se falhar, as mensagens só continuam marcadas como não lidas.
      });
    };
    marcar();
    document.addEventListener('visibilitychange', marcar);
    return () => {
      feito = true;
      document.removeEventListener('visibilitychange', marcar);
    };
  }, [conversa.id, conversa.naoLidas]);

  const etapa = descreverEtapa(conversa.etapa);
  const estadoDoChip = descreverEstado(conversa.chip.estado);
  const chipRemovido = conversa.chip.estado === 'revoked';

  const impedimento = motivoParaNaoResponder(conversa, ehDono, evolutionConfigurada);

  async function agir(acao: 'resolver' | 'reabrir') {
    if (ocupado) return;
    setOcupado(acao);
    aoAvisar(conversa.id, null);
    try {
      const resultado = await mudarConversa({ conversaId: conversa.id, acao });
      if (!resultado.ok) aoAvisar(conversa.id, { tipo: 'erro', texto: resultado.erro });
    } catch {
      aoAvisar(conversa.id, { tipo: 'erro', texto: 'Não foi possível falar com o painel. Confira a internet e tente de novo.' });
    } finally {
      setOcupado(null);
      router.refresh();
    }
  }

  const decidir = useCallback(
    async (mensagemId: string, foiEnviada: boolean) => {
      setDecidindo(mensagemId);
      aoAvisar(conversa.id, null);
      try {
        const resultado = await decidirEnvio({ mensagemId, foiEnviada });
        if (!resultado.ok) aoAvisar(conversa.id, { tipo: 'erro', texto: resultado.erro });
      } catch {
        aoAvisar(conversa.id, { tipo: 'erro', texto: 'Não foi possível falar com o painel. Confira a internet e tente de novo.' });
      } finally {
        setDecidindo(null);
        router.refresh();
      }
    },
    [aoAvisar, conversa.id, router],
  );

  const escreverDeNovo = useCallback((texto: string) => {
    setPreenchimento((atual) => ({ texto, vez: (atual?.vez ?? 0) + 1 }));
  }, []);

  const tentarDeNovo = useCallback(
    (pendente: Pendente) => {
      pertoDoFim.current = true;
      void aoEnviar(pendente.conversaId, pendente.texto, pendente.chave);
    },
    [aoEnviar],
  );

  function enviarDoCampo(texto: string) {
    pertoDoFim.current = true;
    void aoEnviar(conversa.id, texto);
  }

  const anteriores = conversa.temMensagensAnteriores ? proximoLimiteDeMensagens(limiteDeMensagens) : null;
  const podeResponder = impedimento === null;

  return (
    <>
      <section className="inbox-conversa" aria-label={`Conversa com ${conversa.contato.nome}`}>
        <header className="inbox-conversa-topo">
          <Link href={enderecoDaLista} className="btn btn-secondary btn-icon-only inbox-voltar" prefetch={false} scroll={false}>
            <Icone nome="seta" className="inbox-voltar-seta" />
            <span className="so-leitor-de-tela">Voltar para a lista de conversas</span>
          </Link>
          <span className="inbox-avatar" aria-hidden="true">
            {conversa.contato.iniciais}
          </span>
          <div className="inbox-conversa-quem">
            <h2 ref={titulo} tabIndex={-1}>
              {conversa.contato.nome}
            </h2>
            <p>
              {conversa.contato.temNome && conversa.contato.telefone ? <span>{conversa.contato.telefone}</span> : null}
              <span>
                Chip {conversa.chip.apelido}
                {chipRemovido ? ' (removido)' : ''}
              </span>
            </p>
          </div>
          <div className="inbox-conversa-acoes">
            <span className={`estado${etapa.tom === 'ok' ? ' estado--ok' : etapa.tom === 'atencao' ? ' estado--atencao' : ''}`}>{etapa.texto}</span>
            <button type="button" className="btn btn-secondary btn-sm inbox-abrir-contato" onClick={() => setContatoAberto(true)}>
              Contato
            </button>
            {conversa.etapa === 'resolved' ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void agir('reabrir')} disabled={ocupado !== null}>
                {ocupado === 'reabrir' ? 'Reabrindo…' : 'Reabrir'}
              </button>
            ) : conversa.etapa === 'archived' ? null : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void agir('resolver')} disabled={ocupado !== null}>
                {ocupado === 'resolver' ? 'Resolvendo…' : 'Resolver'}
              </button>
            )}
          </div>
        </header>

        <div
          ref={rolagem}
          className="inbox-mensagens"
          role="log"
          aria-label="Mensagens da conversa"
          tabIndex={0}
          onScroll={(evento) => {
            const area = evento.currentTarget;
            pertoDoFim.current = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
          }}
        >
          {anteriores ? (
            <p className="inbox-anteriores">
              <Link
                href={enderecoDaInbox({ ...filtros, conversaId: conversa.id, mensagens: anteriores })}
                className="btn btn-secondary btn-sm"
                prefetch={false}
                scroll={false}
              >
                Ver mensagens anteriores
              </Link>
            </p>
          ) : conversa.temMensagensAnteriores ? (
            <p className="inbox-anteriores">Mostrando as {conversa.mensagens.length} mensagens mais recentes.</p>
          ) : null}

          <Mensagens
            mensagens={conversa.mensagens}
            nomeDoContato={conversa.contato.nome}
            podeResponder={podeResponder}
            decidindo={decidindo}
            aoDecidir={decidir}
            aoEscreverDeNovo={escreverDeNovo}
          />

          {meusPendentes.length > 0 ? (
            <ol className="inbox-baloes" aria-label="Mensagens que você acabou de escrever">
              {meusPendentes.map((pendente) => (
                <BalaoPendente key={pendente.chave} pendente={pendente} aoTentarDeNovo={tentarDeNovo} aoDescartar={aoDescartar} />
              ))}
            </ol>
          ) : null}

          {conversa.mensagens.length === 0 && meusPendentes.length === 0 ? (
            <p className="inbox-sem-mensagens">Esta conversa ainda não tem mensagens.</p>
          ) : null}
        </div>

        {aviso ? (
          <p className={`aviso ${aviso.tipo === 'erro' ? 'aviso--erro' : 'aviso--atencao'} inbox-aviso`} role="alert">
            <span>{aviso.texto}</span>
            <button type="button" className="inbox-aviso-fechar" onClick={() => aoAvisar(conversa.id, null)}>
              <Icone nome="fechar" className="icon-15" />
              <span className="so-leitor-de-tela">Fechar aviso</span>
            </button>
          </p>
        ) : null}

        {impedimento ? (
          <div className="inbox-impedimento">
            <p>{impedimento.texto}</p>
            {impedimento.acao === 'reabrir' ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void agir('reabrir')} disabled={ocupado !== null}>
                {ocupado === 'reabrir' ? 'Reabrindo…' : 'Reabrir conversa'}
              </button>
            ) : impedimento.acao === 'instancias' ? (
              <Link href="/instancias" className="btn btn-primary btn-sm">
                Abrir Instâncias
              </Link>
            ) : null}
          </div>
        ) : (
          <CampoDeMensagem
            key={preenchimento?.vez ?? 0}
            conversaId={conversa.id}
            textoInicial={preenchimento?.texto ?? null}
            aoEnviar={enviarDoCampo}
          />
        )}
      </section>

      <aside className="inbox-contato" aria-label="Dados do contato">
        <CartaoDoContato conversa={conversa} etapa={etapa.texto} estadoDoChip={chipRemovido ? 'Removido' : estadoDoChip.texto} />
      </aside>

      {contatoAberto ? (
        <Dialogo titulo="Dados do contato" aoFechar={() => setContatoAberto(false)}>
          <CartaoDoContato conversa={conversa} etapa={etapa.texto} estadoDoChip={chipRemovido ? 'Removido' : estadoDoChip.texto} />
        </Dialogo>
      ) : null}
    </>
  );
}

interface Impedimento {
  texto: string;
  /** O que oferecer à pessoa para resolver: reabrir a conversa ou ir à tela de Instâncias. */
  acao?: 'reabrir' | 'instancias';
}

/** Por que não dá para responder nesta conversa agora (ou `null` quando dá). */
function motivoParaNaoResponder(conversa: ConversaAberta, ehDono: boolean, evolutionConfigurada: boolean): Impedimento | null {
  const chip = `O chip “${conversa.chip.apelido}”`;
  if (conversa.etapa === 'archived') return { texto: 'Esta conversa está arquivada.' };
  if (conversa.etapa === 'resolved') return { texto: 'Esta conversa está resolvida. Para responder, reabra a conversa.', acao: 'reabrir' };
  if (conversa.contato.apagado) return { texto: 'Os dados deste contato foram apagados. Dá para ler a conversa, mas não para responder.' };
  if (conversa.chip.estado === 'revoked') return { texto: `${chip} foi removido. Dá para ler a conversa, mas não para responder por ela.` };
  if (conversa.chip.motor !== 'evolution') return { texto: `${chip} usa o motor local, que ainda não envia mensagens pelo painel.` };
  if (!evolutionConfigurada) {
    return { texto: 'A conexão com a Evolution ainda não foi configurada neste ambiente. Por enquanto dá para ler, mas não para responder.' };
  }
  if (conversa.chip.estado !== 'connected') {
    return ehDono
      ? { texto: `${chip} está desconectado. Reconecte para responder.`, acao: 'instancias' }
      : { texto: `${chip} está desconectado. Peça ao dono da conta para reconectar.` };
  }
  return null;
}

/* ----------------------------- Mensagens ---------------------------------- */

const ROTULO_DA_SITUACAO: Record<SituacaoDoEnvio, string> = {
  enviando: 'Enviando…',
  enviada: 'Enviada',
  falhou: 'Não enviada',
  sem_confirmacao: 'Sem confirmação',
};

interface PropsDasMensagens {
  mensagens: MensagemDaConversa[];
  nomeDoContato: string;
  podeResponder: boolean;
  decidindo: string | null;
  aoDecidir: (mensagemId: string, foiEnviada: boolean) => void;
  aoEscreverDeNovo: (texto: string) => void;
}

/** As mensagens que vêm do banco. Fica separado (e memorizado) para digitar no campo não redesenhar tudo. */
const Mensagens = memo(function Mensagens({ mensagens, nomeDoContato, podeResponder, decidindo, aoDecidir, aoEscreverDeNovo }: PropsDasMensagens) {
  if (mensagens.length === 0) return null;
  return (
    <ol className="inbox-baloes">
      {mensagens.map((mensagem, indice) => {
        const novoDia = indice === 0 || mensagens[indice - 1]?.dia !== mensagem.dia;
        const situacao = mensagem.situacao;
        return (
          <li key={mensagem.id} className="inbox-balao-linha">
            {novoDia ? (
              <p className="inbox-dia">
                <span>{mensagem.dia}</span>
              </p>
            ) : null}
            <div
              className={`balao ${mensagem.recebida ? 'balao--recebida' : 'balao--enviada'}${
                situacao === 'falhou' || situacao === 'sem_confirmacao' ? ` balao--${situacao === 'falhou' ? 'falhou' : 'incerta'}` : ''
              }${mensagem.autor === 'IA' ? ' balao--ia' : ''}`}
            >
              <span className="so-leitor-de-tela">{mensagem.recebida ? `${nomeDoContato} escreveu:` : `${mensagem.autor ?? 'Resposta'}:`}</span>
              <p className="balao-texto">{mensagem.texto}</p>
              <p className="balao-rodape">
                {mensagem.autor ? <span aria-hidden="true">{mensagem.autor}</span> : null}
                <span>{mensagem.hora}</span>
                {situacao && situacao !== 'enviada' ? (
                  <span className={`balao-situacao balao-situacao--${situacao}`}>{ROTULO_DA_SITUACAO[situacao]}</span>
                ) : situacao === 'enviada' ? (
                  <span className="balao-situacao balao-situacao--enviada">
                    <span aria-hidden="true">✓</span>
                    <span className="so-leitor-de-tela">Enviada</span>
                  </span>
                ) : null}
              </p>

              {situacao === 'sem_confirmacao' ? (
                <div className="balao-decisao">
                  <p>Não deu para confirmar se esta mensagem chegou. Confira no WhatsApp do chip e marque:</p>
                  <div className="balao-botoes">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={decidindo !== null} onClick={() => aoDecidir(mensagem.id, true)}>
                      Foi enviada
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={decidindo !== null} onClick={() => aoDecidir(mensagem.id, false)}>
                      Não foi enviada
                    </button>
                  </div>
                </div>
              ) : null}

              {situacao === 'falhou' && podeResponder ? (
                <div className="balao-botoes">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => aoEscreverDeNovo(mensagem.texto)}>
                    Escrever de novo
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
});

function BalaoPendente({
  pendente,
  aoTentarDeNovo,
  aoDescartar,
}: {
  pendente: Pendente;
  aoTentarDeNovo: (pendente: Pendente) => void;
  aoDescartar: (chave: string) => void;
}) {
  const situacao: SituacaoDoEnvio = pendente.mensagemId ? (pendente.situacao ?? 'enviando') : 'enviando';
  const comProblema = pendente.fase !== 'enviando';
  return (
    <li className="inbox-balao-linha">
      <div
        className={`balao balao--enviada${
          comProblema || situacao === 'falhou' ? ' balao--falhou' : situacao === 'sem_confirmacao' ? ' balao--incerta' : ''
        }`}
      >
        <span className="so-leitor-de-tela">Você:</span>
        <p className="balao-texto">{pendente.texto}</p>
        <p className="balao-rodape">
          <span aria-hidden="true">Você</span>
          <span>{pendente.hora}</span>
          {pendente.fase === 'recusada' ? (
            <span className="balao-situacao balao-situacao--falhou">Não enviada</span>
          ) : pendente.fase === 'sem_resposta' ? (
            <span className="balao-situacao balao-situacao--sem_confirmacao">Sem resposta do painel</span>
          ) : situacao === 'enviada' ? (
            <span className="balao-situacao balao-situacao--enviada">
              <span aria-hidden="true">✓</span>
              <span className="so-leitor-de-tela">Enviada</span>
            </span>
          ) : (
            <span className={`balao-situacao balao-situacao--${situacao}`}>{ROTULO_DA_SITUACAO[situacao]}</span>
          )}
        </p>

        {pendente.fase === 'recusada' ? (
          <div className="balao-decisao" role="alert">
            <p>{pendente.erro ?? 'A mensagem não foi enviada.'}</p>
            <div className="balao-botoes">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => aoTentarDeNovo(pendente)}>
                Tentar de novo
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => aoDescartar(pendente.chave)}>
                Descartar
              </button>
            </div>
          </div>
        ) : null}

        {pendente.fase === 'sem_resposta' ? (
          <div className="balao-decisao" role="alert">
            <p>
              A conexão com o painel caiu antes da resposta. Toque em “Conferir envio”: se a mensagem ainda não saiu, ela sai agora; se já
              saiu, nada é enviado de novo.
            </p>
            <div className="balao-botoes">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => aoTentarDeNovo(pendente)}>
                Conferir envio
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/* --------------------------- Campo de mensagem ----------------------------- */

function CampoDeMensagem({
  conversaId,
  textoInicial,
  aoEnviar,
}: {
  conversaId: string;
  textoInicial: string | null;
  aoEnviar: (texto: string) => void;
}) {
  const [texto, setTexto] = useState(() => textoInicial ?? rascunhos.get(conversaId) ?? '');
  const campo = useRef<HTMLTextAreaElement>(null);
  const idCampo = useId();
  const idDica = useId();

  // O campo cresce com o texto, até um limite; depois disso rola por dentro.
  useLayoutEffect(() => {
    const area = campo.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 150)}px`;
  }, [texto]);

  // Um "escrever de novo" coloca o texto no campo e já deixa o cursor nele.
  useEffect(() => {
    if (textoInicial === null) return;
    const area = campo.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, [textoInicial]);

  function mudar(valor: string) {
    setTexto(valor);
    if (valor.trim()) rascunhos.set(conversaId, valor);
    else rascunhos.delete(conversaId);
  }

  function enviar() {
    const limpo = texto.trim();
    if (!limpo) return;
    mudar('');
    aoEnviar(limpo);
    campo.current?.focus();
  }

  function aoTeclar(evento: KeyboardEvent<HTMLTextAreaElement>) {
    if (evento.key !== 'Enter' || evento.shiftKey || evento.nativeEvent.isComposing) return;
    // No celular, Enter quebra a linha (como no WhatsApp) e quem envia é o botão.
    if (window.matchMedia('(pointer: coarse)').matches) return;
    evento.preventDefault();
    enviar();
  }

  const sobrando = TEXTO_MAXIMO - texto.length;

  return (
    <form
      className="inbox-escrever"
      onSubmit={(evento) => {
        evento.preventDefault();
        enviar();
      }}
    >
      <div className="inbox-escrever-linha">
        <label htmlFor={idCampo} className="so-leitor-de-tela">
          Mensagem
        </label>
        <textarea
          ref={campo}
          id={idCampo}
          className="campo inbox-escrever-campo"
          name="texto"
          rows={1}
          value={texto}
          maxLength={TEXTO_MAXIMO}
          placeholder="Escreva uma mensagem"
          aria-describedby={idDica}
          enterKeyHint="enter"
          onChange={(evento) => mudar(evento.target.value)}
          onKeyDown={aoTeclar}
        />
        <button type="submit" className="btn btn-primary" disabled={!texto.trim()}>
          Enviar
        </button>
      </div>
      <p id={idDica} className="inbox-escrever-dica">
        <span className="inbox-dica-do-teclado">Enter envia · Shift + Enter pula a linha</span>
        {sobrando <= 300 ? <span>{plural(sobrando, 'letra sobrando', 'letras sobrando')}</span> : null}
      </p>
    </form>
  );
}

/* --------------------------- Dados do contato ------------------------------ */

function CartaoDoContato({ conversa, etapa, estadoDoChip }: { conversa: ConversaAberta; etapa: string; estadoDoChip: string }) {
  const [copiado, setCopiado] = useState<'sim' | 'falhou' | null>(null);

  async function copiarTelefone() {
    try {
      await navigator.clipboard.writeText(conversa.contato.telefone);
      setCopiado('sim');
    } catch {
      setCopiado('falhou');
    }
  }

  return (
    <div className="contato-cartao">
      <div className="contato-topo">
        <span className="inbox-avatar inbox-avatar--grande" aria-hidden="true">
          {conversa.contato.iniciais}
        </span>
        <div>
          <p className="contato-nome">{conversa.contato.nome}</p>
          {conversa.contato.temNome ? null : <p className="contato-sem-nome">Este contato ainda não tem nome.</p>}
        </div>
      </div>

      <dl className="contato-dados">
        <div>
          <dt>Telefone</dt>
          <dd>
            {conversa.contato.telefone ? (
              <>
                <span>{conversa.contato.telefone}</span>
                <button type="button" className="contato-copiar" onClick={() => void copiarTelefone()}>
                  Copiar
                </button>
                <span role="status" className="contato-copiado">
                  {copiado === 'sim' ? 'Copiado' : copiado === 'falhou' ? 'Não deu para copiar' : ''}
                </span>
              </>
            ) : (
              'Não informado'
            )}
          </dd>
        </div>
        <div>
          <dt>Chip</dt>
          <dd>
            {conversa.chip.apelido} <span className="contato-detalhe">({estadoDoChip.toLowerCase()})</span>
          </dd>
        </div>
        <div>
          <dt>Situação da conversa</dt>
          <dd>{etapa}</dd>
        </div>
        <div>
          <dt>Conversa aberta em</dt>
          <dd>{conversa.desde}</dd>
        </div>
        <div>
          <dt>Contato desde</dt>
          <dd>{conversa.contato.desde}</dd>
        </div>
      </dl>

      <p className="contato-rodape">Etiquetas, etapa do funil, valor do negócio e anotações entram aqui na Fase 3 (CRM completo).</p>
    </div>
  );
}
