'use client';

import { createClient } from '@supabase/supabase-js';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import type { FaixaDaIa } from '@/lib/atendente/painel';
import type { ArquivoDaMensagem, ChipDaInbox, ConversaAberta, FiltrosDaInbox, ListaDaInbox, MensagemDaConversa } from '@/lib/dados/inbox';
import { plural } from '@/lib/formato';
import { mensagensQueEnsinam, sugerirEnsino, type SugestaoDeEnsino } from '@/lib/ia/ensino';
import {
  LEGENDA_MAXIMA,
  LIMITE_DE_DOCUMENTO,
  avaliarArquivo,
  depositoDizQueEhGrandeDemais,
  depositoDizQueJaExiste,
  tamanhoLegivel,
  tamanhoNoBalao,
  type TipoDeEnvio,
} from '@/lib/inbox/arquivos';
import {
  BUSCA_MAXIMA,
  TEXTO_MAXIMO,
  VISOES,
  descreverEtapa,
  enderecoDaInbox,
  NOVIDADES_EM_RITMO_LENTO_APOS,
  horaDaMensagem,
  intervaloDeNovidades,
  lerBusca,
  proximoLimite,
  proximoLimiteDeMensagens,
  type SituacaoDoEnvio,
} from '@/lib/inbox/regras';
import { descreverEstado } from '@/lib/instancias/regras';
import {
  buscarArquivo,
  decidirEnvio,
  enviarArquivo,
  enviarMensagem,
  mudarConversa,
  prepararEnvioDeArquivo,
  type ResultadoDoEnvio,
} from './acoes';
import { JanelaDeEnsino } from './janela-de-ensino';

interface Props {
  workspaceId: string;
  /** Muda quando qualquer conversa ou chip da empresa muda. `null` quando não deu para ler. */
  versao: string | null;
  /** Canal privado de Broadcast no Supabase Realtime (opaco, sem o ID da empresa). `null` ativa o modo reserva por consulta. */
  canalRealtime?: string | null;
  /** Chave pública do Supabase para assinar o Realtime sem ler nenhum cookie de sessão. */
  supabasePublico?: { url: string; chavePublica: string } | null;
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
  /** O texto; com arquivo, é a legenda. */
  texto: string;
  hora: string;
  criadaEm: number;
  fase: 'enviando' | 'recusada' | 'sem_resposta';
  erro?: string;
  /** O arquivo que vai junto, quando há. */
  anexo?: Anexo;
  /** Enquanto o arquivo sobe para o painel: quanto já subiu, de 0 a 100. Fora disso, `null`. */
  progresso?: number | null;
  /** Preenchido quando o painel respondeu; a partir daí a mensagem que vem do banco assume o lugar. */
  mensagemId?: string;
  situacao?: SituacaoDoEnvio;
}

interface Aviso {
  tipo: 'erro' | 'atencao' | 'ok';
  texto: string;
}

/** Um arquivo que a pessoa escolheu para enviar (foto, vídeo, áudio ou documento). */
interface Anexo {
  arquivo: File;
  tipo: TipoDeEnvio;
  /** Tipo de conteúdo com que o arquivo sobe ("image/jpeg"). */
  conteudo: string;
  nomeNoDeposito: string;
  /** "Vai como foto", "Vai como documento"... */
  comoVai: string;
  tamanho: string;
  /** Endereço local para mostrar a foto antes de ela subir. */
  previa: string | null;
  largura: number | null;
  altura: number | null;
  duracao: number | null;
}

/** Uma foto aberta em tamanho maior. */
interface FotoAberta {
  endereco: string;
  enderecoParaBaixar: string | null;
  legenda: string;
}

const soltarPrevia = (anexo: Anexo | null | undefined): void => {
  if (anexo?.previa) URL.revokeObjectURL(anexo.previa);
};

/** Tamanho da foto, ou duração do áudio e do vídeo, lidos no próprio navegador antes de enviar. Sem pressa: se não der, vai sem. */
async function medirArquivo(arquivo: File, tipo: TipoDeEnvio): Promise<Pick<Anexo, 'largura' | 'altura' | 'duracao'>> {
  const nada = { largura: null, altura: null, duracao: null };
  try {
    if (tipo === 'image') {
      const imagem = await createImageBitmap(arquivo);
      const medidas = { largura: imagem.width || null, altura: imagem.height || null, duracao: null };
      imagem.close();
      return medidas;
    }
    if (tipo === 'audio' || tipo === 'video') {
      return await new Promise((resolver) => {
        const endereco = URL.createObjectURL(arquivo);
        const elemento = document.createElement(tipo);
        const terminar = (medidas: Pick<Anexo, 'largura' | 'altura' | 'duracao'>) => {
          clearTimeout(relogio);
          URL.revokeObjectURL(endereco);
          resolver(medidas);
        };
        const relogio = setTimeout(() => terminar(nada), 4_000);
        elemento.preload = 'metadata';
        elemento.onloadedmetadata = () => {
          const video = elemento instanceof HTMLVideoElement ? elemento : null;
          terminar({
            largura: video?.videoWidth || null,
            altura: video?.videoHeight || null,
            duracao: Number.isFinite(elemento.duration) && elemento.duration >= 0 ? Math.round(elemento.duration) : null,
          });
        };
        elemento.onerror = () => terminar(nada);
        elemento.src = endereco;
      });
    }
  } catch {
    // Formato que o navegador não abre: o arquivo vai do mesmo jeito, só sem as medidas.
  }
  return nada;
}

/**
 * Sobe o arquivo do navegador direto para o depósito, no endereço de uso único que o painel assinou.
 * O arquivo não passa pelo servidor do painel.
 */
function subirArquivo(
  endereco: string,
  anexo: Anexo,
  aoProgredir: (porcento: number) => void,
): Promise<'ok' | 'grande_demais' | 'falhou'> {
  return new Promise((resolver) => {
    const pedido = new XMLHttpRequest();
    pedido.open('PUT', endereco);
    pedido.setRequestHeader('content-type', anexo.conteudo);
    pedido.setRequestHeader('cache-control', 'max-age=3600');
    pedido.setRequestHeader('x-upsert', 'false');
    pedido.upload.onprogress = (evento) => {
      if (evento.lengthComputable && evento.total > 0) aoProgredir(Math.min(99, Math.round((evento.loaded / evento.total) * 100)));
    };
    pedido.onload = () => {
      if (pedido.status >= 200 && pedido.status < 300) return resolver('ok');
      let corpo: Record<string, unknown> | null = null;
      try {
        corpo = JSON.parse(pedido.responseText) as Record<string, unknown>;
      } catch {
        corpo = null;
      }
      // "Já existe": o mesmo envio subiu este arquivo antes (a pessoa tentou de novo). Está tudo certo.
      if (depositoDizQueJaExiste(corpo)) return resolver('ok');
      resolver(depositoDizQueEhGrandeDemais(corpo) || pedido.status === 413 ? 'grande_demais' : 'falhou');
    };
    pedido.onerror = () => resolver('falhou');
    pedido.onabort = () => resolver('falhou');
    pedido.ontimeout = () => resolver('falhou');
    pedido.send(anexo.arquivo);
  });
}

/** O que a pessoa estava escrevendo em cada conversa, para não perder ao trocar de conversa. */
const rascunhos = new Map<string, string>();

/**
 * Quantos pedidos ao servidor (enviar, resolver, marcar como lida...) estão no meio do caminho.
 * Enquanto houver algum, a tela não pede recarga por conta própria: a resposta de cada pedido já traz
 * os dados novos, e as recargas pedidas no meio ficariam na fila para rodar todas de uma vez no final.
 */
let pedidosEmAndamento = 0;

async function pedir<T>(pedido: () => Promise<T>): Promise<T> {
  pedidosEmAndamento += 1;
  try {
    return await pedido();
  } finally {
    pedidosEmAndamento -= 1;
  }
}

/** Chave única de um envio. Repetir o pedido com a mesma chave nunca manda a mensagem duas vezes. */
function novaChave(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Mantém a Inbox atualizada em tempo real via Supabase Realtime Broadcast (sem gastar chamadas HTTP
 * periódicas no servidor do painel). Se o Realtime estiver indisponível ou cair, volta sozinho
 * para a conferência periódica em `/api/inbox/versao` enquanto a aba estiver visível.
 */
function useNovidades(
  workspaceId: string,
  versao: string | null,
  canalRealtime: string | null = null,
  supabasePublico: { url: string; chavePublica: string } | null = null,
): void {
  const router = useRouter();
  const versaoNaTela = useRef(versao);
  /** Hora em que a tela pediu uma recarga que ainda não chegou (0 = nenhuma pendente). */
  const recargaPedidaEm = useRef(0);
  const supabaseUrl = supabasePublico?.url ?? null;
  const supabaseChave = supabasePublico?.chavePublica ?? null;

  useEffect(() => {
    // Chegaram dados novos: a recarga pedida (se havia) foi atendida.
    versaoNaTela.current = versao;
    recargaPedidaEm.current = 0;
  }, [versao]);

  useEffect(() => {
    let desmontado = false;
    let perguntando = false;
    let pausadoAte = 0;
    let ultimaAtividade = Date.now();
    let relogio: ReturnType<typeof setTimeout> | undefined;
    let atrasoRealtime: ReturnType<typeof setTimeout> | undefined;
    let realtimeAtivo = false;
    let mudouNoSilencio = false;

    function pedirRecargaAgora() {
      if (desmontado || document.visibilityState !== 'visible') return;
      if (pedidosEmAndamento > 0) {
        mudouNoSilencio = true;
        clearTimeout(atrasoRealtime);
        atrasoRealtime = setTimeout(() => {
          if (!desmontado && mudouNoSilencio && pedidosEmAndamento === 0) {
            mudouNoSilencio = false;
            pedirRecargaAgora();
          }
        }, 600);
        return;
      }
      const desdeOPedido = Date.now() - recargaPedidaEm.current;
      if (recargaPedidaEm.current !== 0 && desdeOPedido < 15_000) return;
      recargaPedidaEm.current = Date.now();
      ultimaAtividade = Date.now();
      router.refresh();
    }

    async function conferir() {
      if (desmontado || perguntando || document.visibilityState !== 'visible' || Date.now() < pausadoAte) return;
      // Com um pedido em andamento, quem traz os dados novos é a resposta dele.
      if (pedidosEmAndamento > 0) return;
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

        if (pedidosEmAndamento > 0) return;
        const conhecida = versaoNaTela.current;
        // Uma recarga por vez: só pede outra se a anterior não chegou em 15 segundos.
        const desdeOPedido = Date.now() - recargaPedidaEm.current;
        if (recargaPedidaEm.current !== 0 && desdeOPedido < 15_000) return;
        // Sem versão na tela (a leitura falhou ao abrir), tenta de novo de vez em quando.
        const mudou = conhecida === null ? desdeOPedido > 30_000 : corpo.versao !== conhecida;
        if (mudou) {
          recargaPedidaEm.current = Date.now();
          // Chegou coisa nova: a conversa está viva, o ritmo volta a ser o rápido.
          ultimaAtividade = Date.now();
          router.refresh();
        }
      } catch {
        // Sem internet por um instante: a próxima pergunta resolve.
      } finally {
        perguntando = false;
      }
    }

    function agendar() {
      clearTimeout(relogio);
      if (desmontado || realtimeAtivo) return;
      relogio = setTimeout(() => {
        if (realtimeAtivo) return;
        void conferir().finally(agendar);
      }, intervaloDeNovidades(Date.now() - ultimaAtividade));
    }

    /** A pessoa mexeu na tela (ou voltou para a aba): no modo reserva, confere se estava lento ou voltou à aba. */
    function acordar(conferirJa: boolean) {
      if (realtimeAtivo) {
        ultimaAtividade = Date.now();
        if (conferirJa && mudouNoSilencio) {
          mudouNoSilencio = false;
          pedirRecargaAgora();
        }
        return;
      }
      const estavaLento = Date.now() - ultimaAtividade >= NOVIDADES_EM_RITMO_LENTO_APOS;
      ultimaAtividade = Date.now();
      if (conferirJa || estavaLento) {
        void conferir();
        agendar();
      }
    }
    const aoMexer = () => acordar(false);
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') acordar(true);
    };

    window.addEventListener('pointerdown', aoMexer, { passive: true });
    window.addEventListener('keydown', aoMexer);
    document.addEventListener('visibilitychange', aoVoltar);
    window.addEventListener('focus', aoVoltar);

    let clienteRealtime: ReturnType<typeof createClient> | null = null;
    if (canalRealtime && supabaseUrl && supabaseChave) {
      clienteRealtime = createClient(supabaseUrl, supabaseChave, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      clienteRealtime
        .channel(canalRealtime)
        .on('broadcast', { event: 'changed' }, () => {
          if (desmontado) return;
          if (document.visibilityState !== 'visible') {
            mudouNoSilencio = true;
            return;
          }
          clearTimeout(atrasoRealtime);
          atrasoRealtime = setTimeout(pedirRecargaAgora, 150);
        })
        .subscribe((estado) => {
          if (desmontado) return;
          if (estado === 'SUBSCRIBED') {
            realtimeAtivo = true;
            clearTimeout(relogio);
            if (mudouNoSilencio && document.visibilityState === 'visible') {
              mudouNoSilencio = false;
              pedirRecargaAgora();
            }
          } else if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT' || estado === 'CLOSED') {
            if (realtimeAtivo) {
              realtimeAtivo = false;
              agendar();
            }
          }
        });
    }

    agendar();
    return () => {
      desmontado = true;
      clearTimeout(relogio);
      clearTimeout(atrasoRealtime);
      window.removeEventListener('pointerdown', aoMexer);
      window.removeEventListener('keydown', aoMexer);
      document.removeEventListener('visibilitychange', aoVoltar);
      window.removeEventListener('focus', aoVoltar);
      if (clienteRealtime) void clienteRealtime.removeAllChannels();
    };
  }, [workspaceId, canalRealtime, supabaseUrl, supabaseChave, router]);
}

export function PainelDaInbox({
  workspaceId,
  versao,
  canalRealtime = null,
  supabasePublico = null,
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

  useNovidades(workspaceId, versao, canalRealtime, supabasePublico);

  const avisar = useCallback((conversa: string, aviso: Aviso | null) => {
    setAvisos((atuais) => ({ ...atuais, [conversa]: aviso ?? undefined }));
  }, []);

  const enviar = useCallback(
    async (conversa: string, texto: string, opcoes: { chave?: string; anexo?: Anexo } = {}) => {
      const chave = opcoes.chave ?? novaChave();
      const anexo = opcoes.anexo;
      const agora = Date.now();
      setPendentes((atuais) => {
        // Faxina: o que o painel já respondeu há mais de dois minutos não precisa mais ficar guardado.
        const velhos = atuais.filter((item) => item.chave !== chave && item.mensagemId && agora - item.criadaEm > 120_000);
        for (const velho of velhos) soltarPrevia(velho.anexo);
        return [
          ...atuais.filter((item) => item.chave !== chave && !velhos.includes(item)),
          {
            chave,
            conversaId: conversa,
            texto,
            hora: horaDaMensagem(new Date(agora).toISOString()),
            criadaEm: agora,
            fase: 'enviando',
            anexo,
            progresso: anexo ? 0 : null,
          },
        ];
      });
      avisar(conversa, null);

      const mudar = (mudanca: Partial<Pendente>) =>
        setPendentes((atuais) => atuais.map((item) => (item.chave === chave ? { ...item, ...mudanca } : item)));

      let resultado: ResultadoDoEnvio;
      try {
        if (anexo) {
          // 1) O painel libera um endereço de uso único. 2) O navegador sobe o arquivo direto para o depósito.
          const preparo = await pedir(() => prepararEnvioDeArquivo({ conversaId: conversa, chave, nome: anexo.nomeNoDeposito }));
          if (!preparo.ok) {
            mudar({ fase: 'recusada', erro: preparo.erro, progresso: null });
            return;
          }
          // Sem endereço: o arquivo deste envio já subiu numa tentativa anterior.
          const subida = preparo.endereco ? await subirArquivo(preparo.endereco, anexo, (progresso) => mudar({ progresso })) : 'ok';
          if (subida !== 'ok') {
            mudar({
              fase: 'recusada',
              progresso: null,
              erro:
                subida === 'grande_demais'
                  ? `Este arquivo passa de ${tamanhoLegivel(LIMITE_DE_DOCUMENTO)}, o máximo que o painel envia.`
                  : 'O arquivo não subiu. Confira a internet e tente de novo.',
            });
            return;
          }
          mudar({ progresso: null });
          // 3) Com o arquivo guardado, o painel manda a mensagem.
          resultado = await pedir(() =>
            enviarArquivo({
              conversaId: conversa,
              chave,
              caminho: preparo.caminho,
              tipo: anexo.tipo,
              nome: anexo.arquivo.name,
              legenda: texto || null,
              duracao: anexo.duracao,
              largura: anexo.largura,
              altura: anexo.altura,
            }),
          );
        } else {
          resultado = await pedir(() => enviarMensagem({ conversaId: conversa, texto, chave }));
        }
      } catch {
        // A resposta se perdeu: não dá para saber o que o servidor fez. Recarrega para ver o que está gravado.
        mudar({ fase: 'sem_resposta', progresso: null });
        router.refresh();
        return;
      }

      if (!resultado.ok) {
        mudar({ fase: 'recusada', erro: resultado.erro, progresso: null });
        return;
      }
      // A resposta do servidor já trouxe a conversa atualizada; aqui só se anota como o envio terminou.
      mudar({ fase: 'enviando', mensagemId: resultado.mensagemId, situacao: resultado.situacao, progresso: null });
      if (resultado.aviso) avisar(conversa, { tipo: 'erro', texto: resultado.aviso });
    },
    [avisar, router],
  );

  const descartar = useCallback((chave: string) => {
    setPendentes((atuais) => {
      soltarPrevia(atuais.find((item) => item.chave === chave)?.anexo);
      return atuais.filter((item) => item.chave !== chave);
    });
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
  aoEnviar: (conversaId: string, texto: string, opcoes?: { chave?: string; anexo?: Anexo }) => Promise<void>;
  aoDescartar: (chave: string) => void;
  ehDono: boolean;
  evolutionConfigurada: boolean;
}

/** O que dá para fazer com a conversa pelos botões do alto dela. */
type AcaoNaConversa = 'resolver' | 'reabrir' | 'assumir' | 'devolver';

/**
 * A faixa da IA no alto da conversa: diz se a IA está respondendo ali, por que parou, o recado que ela
 * deixou ao passar a conversa, e traz os botões "Assumir" e "Devolver para a IA".
 */
function FaixaDaIaNaConversa({ faixa, ocupado, aoAgir }: { faixa: FaixaDaIa; ocupado: AcaoNaConversa | null; aoAgir: (acao: AcaoNaConversa) => void }) {
  const { recado } = faixa;
  return (
    <div className={`inbox-ia inbox-ia--${faixa.tom}`} role="group" aria-label="A IA nesta conversa">
      <Icone nome={faixa.tom === 'atencao' ? 'pessoa' : 'kpiIa'} className="inbox-ia-icone" />
      <div className="inbox-ia-texto">
        <p className="inbox-ia-titulo">{faixa.titulo}</p>
        {recado ? (
          recado.cenario || recado.gatilho || recado.proximaJogada ? (
            <dl className="inbox-ia-recado">
              {recado.cenario ? (
                <div>
                  <dt>Quem é</dt>
                  <dd>{recado.cenario}</dd>
                </div>
              ) : null}
              {recado.gatilho ? (
                <div>
                  <dt>O que pediu</dt>
                  <dd>{recado.gatilho}</dd>
                </div>
              ) : null}
              {recado.proximaJogada ? (
                <div>
                  <dt>Sugestão</dt>
                  <dd>{recado.proximaJogada}</dd>
                </div>
              ) : null}
              {recado.livre ? (
                <div>
                  <dt>Recado</dt>
                  <dd>{recado.livre}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="inbox-ia-recado">{recado.livre}</p>
          )
        ) : null}
        {faixa.detalhe ? <p className="inbox-ia-detalhe">{faixa.detalhe}</p> : null}
      </div>
      {faixa.podeAssumir || faixa.podeDevolver ? (
        <div className="inbox-ia-acoes">
          {faixa.podeAssumir ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => aoAgir('assumir')} disabled={ocupado !== null}>
              {ocupado === 'assumir' ? 'Assumindo…' : 'Assumir'}
            </button>
          ) : null}
          {faixa.podeDevolver ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => aoAgir('devolver')} disabled={ocupado !== null}>
              {ocupado === 'devolver' ? 'Devolvendo…' : 'Devolver para a IA'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
  const [ocupado, setOcupado] = useState<AcaoNaConversa | null>(null);
  const [decidindo, setDecidindo] = useState<string | null>(null);
  const [contatoAberto, setContatoAberto] = useState(false);
  const [fotoAberta, setFotoAberta] = useState<FotoAberta | null>(null);
  /** Mensagem cujo arquivo está sendo buscado de novo no WhatsApp. */
  const [buscando, setBuscando] = useState<string | null>(null);
  /** Texto colocado no campo por um "tentar de novo". Cada pedido tem um número, para o campo recomeçar. */
  const [preenchimento, setPreenchimento] = useState<{ texto: string; vez: number } | null>(null);
  /** A resposta que o dono está guardando no Treinamento ("corrigir resposta em 1 clique"). */
  const [ensinando, setEnsinando] = useState<{ mensagemId: string; sugestao: SugestaoDeEnsino } | null>(null);

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

  // A área das mensagens muda de altura (um arquivo foi anexado, o teclado do celular abriu...):
  // quem estava vendo o fim da conversa continua vendo o fim.
  useEffect(() => {
    const area = rolagem.current;
    if (!area || typeof ResizeObserver === 'undefined') return;
    const observador = new ResizeObserver(() => {
      if (pertoDoFim.current) area.scrollTop = area.scrollHeight;
    });
    observador.observe(area);
    return () => observador.disconnect();
  }, []);

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
      pedir(() => mudarConversa({ conversaId: conversa.id, acao: 'marcar_lida' })).catch(() => {
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

  async function agir(acao: AcaoNaConversa) {
    if (ocupado) return;
    setOcupado(acao);
    aoAvisar(conversa.id, null);
    try {
      const resultado = await pedir(() => mudarConversa({ conversaId: conversa.id, acao }));
      if (!resultado.ok) aoAvisar(conversa.id, { tipo: 'erro', texto: resultado.erro });
    } catch {
      aoAvisar(conversa.id, { tipo: 'erro', texto: 'Não foi possível falar com o painel. Confira a internet e tente de novo.' });
      router.refresh();
    } finally {
      setOcupado(null);
    }
  }

  const decidir = useCallback(
    async (mensagemId: string, foiEnviada: boolean) => {
      setDecidindo(mensagemId);
      aoAvisar(conversa.id, null);
      try {
        const resultado = await pedir(() => decidirEnvio({ mensagemId, foiEnviada }));
        if (!resultado.ok) aoAvisar(conversa.id, { tipo: 'erro', texto: resultado.erro });
      } catch {
        aoAvisar(conversa.id, { tipo: 'erro', texto: 'Não foi possível falar com o painel. Confira a internet e tente de novo.' });
        router.refresh();
      } finally {
        setDecidindo(null);
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
      void aoEnviar(pendente.conversaId, pendente.texto, { chave: pendente.chave, anexo: pendente.anexo });
    },
    [aoEnviar],
  );

  function enviarDoCampo(texto: string, anexo?: Anexo) {
    pertoDoFim.current = true;
    void aoEnviar(conversa.id, texto, { anexo });
  }

  /** "Tentar de novo" num arquivo recebido que o painel não conseguiu trazer do WhatsApp. */
  const buscarDeNovo = useCallback(
    async (mensagemId: string) => {
      setBuscando(mensagemId);
      aoAvisar(conversa.id, null);
      try {
        const resultado = await pedir(() => buscarArquivo({ mensagemId }));
        if (!resultado.ok) aoAvisar(conversa.id, { tipo: 'erro', texto: resultado.erro });
      } catch {
        aoAvisar(conversa.id, { tipo: 'erro', texto: 'Não foi possível falar com o painel. Confira a internet e tente de novo.' });
        router.refresh();
      } finally {
        setBuscando(null);
      }
    },
    [aoAvisar, conversa.id, router],
  );

  // Só o dono da conta altera o treinamento: para o resto da equipe o botão nem aparece.
  const ensinaveis = useMemo(() => (ehDono ? mensagensQueEnsinam(conversa.mensagens) : null), [ehDono, conversa.mensagens]);
  const abrirEnsino = useCallback(
    (mensagemId: string) => {
      const sugestao = sugerirEnsino(conversa.mensagens, mensagemId);
      if (sugestao) setEnsinando({ mensagemId, sugestao });
    },
    [conversa.mensagens],
  );

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
            <span className={`estado${etapa.tom === 'ok' ? ' estado--ok' : etapa.tom === 'atencao' ? ' estado--atencao' : etapa.tom === 'ia' ? ' estado--ia' : ''}`}>
              {etapa.texto}
            </span>
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

        {conversa.ia ? <FaixaDaIaNaConversa faixa={conversa.ia} ocupado={ocupado} aoAgir={(acao) => void agir(acao)} /> : null}

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
          // Uma foto que termina de carregar pode mudar a altura da conversa: quem estava no fim continua no fim.
          onLoadCapture={() => {
            const area = rolagem.current;
            if (area && pertoDoFim.current) area.scrollTop = area.scrollHeight;
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
            buscando={buscando}
            aoDecidir={decidir}
            aoEscreverDeNovo={escreverDeNovo}
            aoAbrirFoto={setFotoAberta}
            aoBuscarArquivo={buscarDeNovo}
            ensinaveis={ensinaveis}
            aoEnsinar={abrirEnsino}
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
          <p className={`aviso aviso--${aviso.tipo} inbox-aviso`} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>
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

      {ensinando ? (
        <JanelaDeEnsino
          mensagemId={ensinando.mensagemId}
          sugestao={ensinando.sugestao}
          chip={conversa.chip.apelido}
          aoFechar={() => setEnsinando(null)}
          aoGuardar={(texto) => {
            setEnsinando(null);
            aoAvisar(conversa.id, { tipo: 'ok', texto });
          }}
        />
      ) : null}

      {fotoAberta ? (
        <Dialogo titulo="Foto" aoFechar={() => setFotoAberta(null)} largo>
          <div className="foto-aberta">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fotoAberta.endereco} alt={fotoAberta.legenda ? `Foto: ${fotoAberta.legenda}` : 'Foto da conversa'} />
            {fotoAberta.legenda ? <p className="foto-aberta-legenda">{fotoAberta.legenda}</p> : null}
            {fotoAberta.enderecoParaBaixar ? (
              <div className="dialogo-acoes">
                <a href={fotoAberta.enderecoParaBaixar} className="btn btn-secondary btn-sm" target="_blank" rel="noopener noreferrer">
                  <Icone nome="baixar" className="icon-15" />
                  Baixar a foto
                </a>
              </div>
            ) : null}
          </div>
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
  /** Mensagem cujo arquivo está sendo buscado de novo. */
  buscando: string | null;
  aoDecidir: (mensagemId: string, foiEnviada: boolean) => void;
  aoEscreverDeNovo: (texto: string) => void;
  aoAbrirFoto: (foto: FotoAberta) => void;
  aoBuscarArquivo: (mensagemId: string) => void;
  /** As mensagens que têm o botão de ensinar a IA. `null` = quem está olhando não altera o treinamento. */
  ensinaveis: ReadonlySet<string> | null;
  aoEnsinar: (mensagemId: string) => void;
}

/** As mensagens que vêm do banco. Fica separado (e memorizado) para digitar no campo não redesenhar tudo. */
const Mensagens = memo(function Mensagens({
  mensagens,
  nomeDoContato,
  podeResponder,
  decidindo,
  buscando,
  aoDecidir,
  aoEscreverDeNovo,
  aoAbrirFoto,
  aoBuscarArquivo,
  ensinaveis,
  aoEnsinar,
}: PropsDasMensagens) {
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
              <span className="so-leitor-de-tela">
                {mensagem.recebida ? `${nomeDoContato} ${mensagem.arquivo ? 'enviou' : 'escreveu'}:` : `${mensagem.autor ?? 'Resposta'}:`}
              </span>
              {mensagem.arquivo ? (
                <ArquivoNoBalao
                  arquivo={mensagem.arquivo}
                  legenda={mensagem.texto}
                  buscando={buscando === mensagem.id}
                  aoAbrirFoto={aoAbrirFoto}
                  aoBuscar={() => aoBuscarArquivo(mensagem.id)}
                />
              ) : null}
              {mensagem.texto ? <p className="balao-texto">{mensagem.texto}</p> : null}
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

              {situacao === 'falhou' && mensagem.arquivo ? (
                <p className="balao-decisao">Este arquivo não foi enviado. Para tentar de novo, anexe o arquivo outra vez.</p>
              ) : situacao === 'falhou' && podeResponder ? (
                <div className="balao-botoes">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => aoEscreverDeNovo(mensagem.texto)}>
                    Escrever de novo
                  </button>
                </div>
              ) : null}

              {ensinaveis?.has(mensagem.id) ? (
                <div className="balao-ensinar">
                  <button type="button" className="balao-ensinar-botao" onClick={() => aoEnsinar(mensagem.id)}>
                    {mensagem.autor === 'IA' ? 'Corrigir resposta' : 'Ensinar à IA'}
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

/** Rótulo de um arquivo que não dá para mostrar: por quê, e o que fazer. */
function explicarArquivo(arquivo: ArquivoDaMensagem): string {
  const oArquivo = { image: 'Esta foto', video: 'Este vídeo', audio: 'Este áudio', sticker: 'Esta figurinha', document: 'Este documento' }[arquivo.tipo];
  if (arquivo.situacao === 'buscando') return `Trazendo ${oArquivo.replace(/^Est/, 'est')} do WhatsApp…`;
  if (arquivo.situacao === 'grande_demais') {
    return `${oArquivo} é grande demais para o painel guardar${arquivo.tamanho ? ` (${arquivo.tamanho})` : ''}. Veja no celular do chip.`;
  }
  if (arquivo.situacao === 'apagado') return `${oArquivo} já saiu do painel: passou do prazo de guarda dos arquivos.`;
  return `O painel não conseguiu trazer ${oArquivo.replace(/^Est/, 'est')} do WhatsApp.`;
}

/** O arquivo de uma mensagem dentro do balão: foto, figurinha, áudio, vídeo ou documento. */
function ArquivoNoBalao({
  arquivo,
  legenda,
  buscando,
  aoAbrirFoto,
  aoBuscar,
}: {
  arquivo: ArquivoDaMensagem;
  legenda: string;
  buscando: boolean;
  aoAbrirFoto: (foto: FotoAberta) => void;
  aoBuscar: () => void;
}) {
  const detalhes = [arquivo.descricao, arquivo.duracao, arquivo.tamanho].filter(Boolean).join(' · ');

  if (arquivo.situacao !== 'guardado' || !arquivo.endereco) {
    return (
      <div className={`balao-arquivo balao-arquivo--${arquivo.situacao}`}>
        <span className="balao-arquivo-icone" aria-hidden="true">
          <Icone nome={arquivo.tipo === 'audio' ? 'audios' : 'documento'} />
        </span>
        <div className="balao-arquivo-texto">
          <strong>{arquivo.nome ?? arquivo.descricao}</strong>
          <span>{explicarArquivo(arquivo)}</span>
          {arquivo.situacao === 'falhou' ? (
            <div className="balao-botoes">
              <button type="button" className="btn btn-secondary btn-sm" onClick={aoBuscar} disabled={buscando}>
                {buscando ? 'Buscando…' : 'Buscar de novo'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // Com as medidas conhecidas, a foto já ocupa o espaço certo antes de carregar (a conversa não "pula").
  const medidas = tamanhoNoBalao(arquivo.largura, arquivo.altura);

  if (arquivo.tipo === 'image') {
    const endereco = arquivo.endereco;
    return (
      <button
        type="button"
        className="balao-foto"
        aria-label={legenda ? `Abrir a foto: ${legenda}` : 'Abrir a foto'}
        onClick={() => aoAbrirFoto({ endereco, enderecoParaBaixar: arquivo.enderecoParaBaixar, legenda })}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={endereco} alt="" loading="lazy" decoding="async" {...(medidas ? { ...medidas, style: { width: medidas.width } } : {})} />
      </button>
    );
  }
  if (arquivo.tipo === 'sticker') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="balao-figurinha" src={arquivo.endereco} alt="Figurinha" loading="lazy" decoding="async" />;
  }
  if (arquivo.tipo === 'audio') {
    return (
      <div className="balao-som">
        <audio controls preload="none" src={arquivo.endereco} aria-label={detalhes} />
        <span className="balao-arquivo-detalhe">
          {detalhes}
          <LinkParaBaixar endereco={arquivo.enderecoParaBaixar} oQue="o áudio" />
        </span>
      </div>
    );
  }
  if (arquivo.tipo === 'video') {
    return (
      <div className="balao-video">
        <video
          controls
          preload="none"
          playsInline
          src={arquivo.endereco}
          aria-label={legenda ? `Vídeo: ${legenda}` : detalhes}
          style={medidas ? { width: medidas.width, aspectRatio: `${medidas.width} / ${medidas.height}` } : undefined}
        />
        <span className="balao-arquivo-detalhe">
          {detalhes}
          <LinkParaBaixar endereco={arquivo.enderecoParaBaixar} oQue="o vídeo" />
        </span>
      </div>
    );
  }
  return (
    <a className="balao-arquivo balao-arquivo--guardado" href={arquivo.enderecoParaBaixar ?? arquivo.endereco} target="_blank" rel="noopener noreferrer">
      <span className="balao-arquivo-icone" aria-hidden="true">
        <Icone nome="documento" />
      </span>
      <span className="balao-arquivo-texto">
        <strong>{arquivo.nome ?? 'Documento'}</strong>
        <span>{['Baixar', arquivo.tamanho].filter(Boolean).join(' · ')}</span>
      </span>
    </a>
  );
}

/**
 * Áudio e vídeo tocam no próprio navegador. Quando ele não conhece o formato (acontece com mensagens
 * de voz em aparelhos mais antigos), a pessoa baixa o arquivo e abre no aparelho.
 */
function LinkParaBaixar({ endereco, oQue }: { endereco: string | null; oQue: string }) {
  if (!endereco) return null;
  return (
    <>
      {' · '}
      <a href={endereco} target="_blank" rel="noopener noreferrer" aria-label={`Baixar ${oQue}`}>
        Baixar
      </a>
    </>
  );
}

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
        {pendente.anexo ? <AnexoNoBalao anexo={pendente.anexo} /> : null}
        {pendente.texto ? <p className="balao-texto">{pendente.texto}</p> : null}
        <p className="balao-rodape">
          <span aria-hidden="true">Você</span>
          <span>{pendente.hora}</span>
          {typeof pendente.progresso === 'number' && pendente.fase === 'enviando' ? (
            <span className="balao-situacao balao-situacao--enviando">Subindo o arquivo… {pendente.progresso}%</span>
          ) : pendente.fase === 'recusada' ? (
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

/** O arquivo de uma mensagem que ainda está saindo: a própria foto, ou o nome e o tamanho do arquivo. */
function AnexoNoBalao({ anexo }: { anexo: Anexo }) {
  if (anexo.previa) {
    const medidas = tamanhoNoBalao(anexo.largura, anexo.altura);
    return (
      <span className="balao-foto balao-foto--local">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={anexo.previa} alt={`Foto ${anexo.arquivo.name}`} {...(medidas ? { ...medidas, style: { width: medidas.width } } : {})} />
      </span>
    );
  }
  return (
    <div className="balao-arquivo balao-arquivo--local">
      <span className="balao-arquivo-icone" aria-hidden="true">
        <Icone nome={anexo.tipo === 'audio' ? 'audios' : 'documento'} />
      </span>
      <div className="balao-arquivo-texto">
        <strong>{anexo.arquivo.name}</strong>
        <span>{[{ image: 'Foto', video: 'Vídeo', audio: 'Mensagem de voz', document: 'Documento' }[anexo.tipo], anexo.tamanho].join(' · ')}</span>
      </div>
    </div>
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
  aoEnviar: (texto: string, anexo?: Anexo) => void;
}) {
  const [texto, setTexto] = useState(() => textoInicial ?? rascunhos.get(conversaId) ?? '');
  const [anexo, setAnexo] = useState<Anexo | null>(null);
  const [erroDoAnexo, setErroDoAnexo] = useState<string | null>(null);
  const [soltando, setSoltando] = useState(false);
  const campo = useRef<HTMLTextAreaElement>(null);
  const seletor = useRef<HTMLInputElement>(null);
  /** O anexo que está no campo agora (para as medidas que chegam depois, e para a limpeza ao sair). */
  const anexoNoCampo = useRef<Anexo | null>(null);
  const idCampo = useId();
  const idDica = useId();
  const idAnexo = useId();

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

  // Saiu da conversa com um arquivo anexado e não enviado: a prévia dele é solta.
  useEffect(
    () => () => {
      soltarPrevia(anexoNoCampo.current);
      anexoNoCampo.current = null;
    },
    [],
  );

  function mudar(valor: string) {
    setTexto(valor);
    if (valor.trim()) rascunhos.set(conversaId, valor);
    else rascunhos.delete(conversaId);
  }

  function definirAnexo(novo: Anexo | null) {
    anexoNoCampo.current = novo;
    setAnexo(novo);
  }

  function anexar(arquivo: File | null | undefined) {
    if (!arquivo) return;
    const avaliacao = avaliarArquivo({ nome: arquivo.name, tipoInformado: arquivo.type, tamanho: arquivo.size });
    if (!avaliacao.ok) {
      setErroDoAnexo(avaliacao.erro);
      return;
    }
    setErroDoAnexo(null);
    soltarPrevia(anexoNoCampo.current);
    definirAnexo({
      arquivo,
      tipo: avaliacao.tipo,
      conteudo: avaliacao.conteudo,
      nomeNoDeposito: avaliacao.nomeNoDeposito,
      comoVai: avaliacao.comoVai,
      tamanho: tamanhoLegivel(arquivo.size),
      previa: avaliacao.tipo === 'image' ? URL.createObjectURL(arquivo) : null,
      largura: null,
      altura: null,
      duracao: null,
    });
    void medirArquivo(arquivo, avaliacao.tipo).then((medidas) => {
      // As medidas só valem se o anexo ainda for este mesmo arquivo.
      const atual = anexoNoCampo.current;
      if (atual && atual.arquivo === arquivo) definirAnexo({ ...atual, ...medidas });
    });
    campo.current?.focus();
  }

  function removerAnexo() {
    soltarPrevia(anexoNoCampo.current);
    definirAnexo(null);
    setErroDoAnexo(null);
    if (seletor.current) seletor.current.value = '';
    campo.current?.focus();
  }

  const semLegenda = anexo?.tipo === 'audio';
  const limite = anexo && !semLegenda ? LEGENDA_MAXIMA : TEXTO_MAXIMO;
  const sobrando = limite - texto.length;
  const passouDoLimite = Boolean(anexo) && !semLegenda && sobrando < 0;
  const podeEnviar = anexo ? !passouDoLimite : Boolean(texto.trim());

  function enviar() {
    if (!podeEnviar) return;
    const limpo = texto.trim();
    if (anexo) {
      // Áudio vai sem legenda: o que estava escrito continua no campo, para ir depois como texto.
      if (!semLegenda) mudar('');
      aoEnviar(semLegenda ? '' : limpo, anexo);
      // A prévia não é solta aqui: ela passa a ser do balão da mensagem.
      definirAnexo(null);
      setErroDoAnexo(null);
      if (seletor.current) seletor.current.value = '';
      campo.current?.focus();
      return;
    }
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

  const trazArquivo = (dados: DataTransfer | null): boolean => Boolean(dados && Array.from(dados.types).includes('Files'));

  return (
    <form
      className={`inbox-escrever${soltando ? ' inbox-escrever--soltando' : ''}`}
      onSubmit={(evento) => {
        evento.preventDefault();
        enviar();
      }}
      onDragOver={(evento) => {
        if (!trazArquivo(evento.dataTransfer)) return;
        evento.preventDefault();
        setSoltando(true);
      }}
      onDragLeave={(evento) => {
        if (!evento.currentTarget.contains(evento.relatedTarget as Node | null)) setSoltando(false);
      }}
      onDrop={(evento) => {
        if (!trazArquivo(evento.dataTransfer)) return;
        evento.preventDefault();
        setSoltando(false);
        anexar(evento.dataTransfer.files[0]);
      }}
    >
      <div aria-live="polite">
        {anexo ? (
          <div className="inbox-anexo" id={idAnexo} role="group" aria-label="Arquivo anexado">
            {anexo.previa ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="inbox-anexo-previa" src={anexo.previa} alt="" />
            ) : (
              <span className="inbox-anexo-icone" aria-hidden="true">
                <Icone nome={anexo.tipo === 'audio' ? 'audios' : 'documento'} />
              </span>
            )}
            <div className="inbox-anexo-texto">
              <strong>{anexo.arquivo.name}</strong>
              <span>
                {anexo.tamanho} · {anexo.comoVai}
              </span>
            </div>
            <button type="button" className="btn btn-secondary btn-sm btn-icon-only" onClick={removerAnexo}>
              <Icone nome="fechar" className="icon-15" />
              <span className="so-leitor-de-tela">Remover o anexo</span>
            </button>
          </div>
        ) : null}
      </div>
      {erroDoAnexo ? (
        <p className="inbox-anexo-erro" role="alert">
          {erroDoAnexo}
        </p>
      ) : null}

      <div className="inbox-escrever-linha">
        <input
          ref={seletor}
          type="file"
          hidden
          data-testid="arquivo-para-enviar"
          onChange={(evento) => {
            anexar(evento.target.files?.[0]);
            // Escolher o mesmo arquivo de novo tem de funcionar.
            evento.target.value = '';
          }}
        />
        <button type="button" className="btn btn-secondary btn-icon-only inbox-anexar" onClick={() => seletor.current?.click()}>
          <Icone nome="clipe" />
          <span className="so-leitor-de-tela">Anexar arquivo</span>
        </button>
        <label htmlFor={idCampo} className="so-leitor-de-tela">
          {anexo ? (semLegenda ? 'Mensagem (o áudio vai sem legenda)' : 'Legenda do arquivo') : 'Mensagem'}
        </label>
        <textarea
          ref={campo}
          id={idCampo}
          className="campo inbox-escrever-campo"
          name="texto"
          rows={1}
          value={texto}
          maxLength={TEXTO_MAXIMO}
          readOnly={semLegenda}
          placeholder={anexo ? (semLegenda ? 'Áudio vai sem legenda' : 'Legenda (opcional)') : 'Escreva uma mensagem'}
          aria-describedby={anexo ? `${idAnexo} ${idDica}` : idDica}
          aria-invalid={passouDoLimite || undefined}
          enterKeyHint="enter"
          onChange={(evento) => mudar(evento.target.value)}
          onKeyDown={aoTeclar}
          onPaste={(evento) => {
            // Colar um print (Ctrl+V) anexa a imagem.
            const colado = evento.clipboardData.files[0];
            if (!colado) return;
            evento.preventDefault();
            anexar(colado);
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={!podeEnviar}>
          Enviar
        </button>
      </div>
      <p id={idDica} className="inbox-escrever-dica">
        <span className="inbox-dica-do-teclado">Enter envia · Shift + Enter pula a linha · o clipe anexa foto, áudio, vídeo ou documento</span>
        {passouDoLimite ? (
          <span className="inbox-escrever-excesso">
            A legenda vai até {LEGENDA_MAXIMA.toLocaleString('pt-BR')} letras: tire {plural(-sobrando, 'letra', 'letras')}.
          </span>
        ) : sobrando <= 300 && !semLegenda ? (
          <span>{plural(sobrando, 'letra sobrando', 'letras sobrando')}</span>
        ) : null}
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
