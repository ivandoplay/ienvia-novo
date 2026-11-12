import 'server-only';

import { descreverIaNaConversa, lerIaDaConversa, type FaixaDaIa } from '@/lib/atendente/painel';
import {
  duracaoLegivel,
  ehCaminhoDeArquivo,
  enderecoDoArquivo,
  nomeDoTipo,
  situacaoDoArquivo,
  tamanhoLegivel,
  type SituacaoDoArquivo,
  type TipoDeArquivo,
} from '@/lib/inbox/arquivos';
import {
  MENSAGENS_POR_VEZ,
  autorDoEnvio,
  carimboParaNomeDeArquivo,
  dataCurta,
  diaDaConversa,
  horaDaMensagem,
  iniciaisDoContato,
  nomeDoContato,
  quandoNaLista,
  situacaoDoEnvio,
  variacoesDeTelefone,
  visaoNoBanco,
  type SituacaoDoEnvio,
  type Visao,
} from '@/lib/inbox/regras';
import { formatarTelefone } from '@/lib/instancias/regras';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Leitura da Inbox. Tudo passa pelas funções read_my_inbox / read_my_conversation do banco,
 * que conferem de novo se a pessoa participa da empresa (e o RLS vale linha a linha).
 *
 * As horas já saem daqui escritas ("14:05", "ontem", "Hoje"), sempre no fuso da operação:
 * assim o servidor e o navegador mostram exatamente o mesmo texto.
 */

export interface ConversaDaLista {
  id: string;
  /** Nome para mostrar: o do contato; sem nome, o telefone. */
  nome: string;
  iniciais: string;
  /** Telefone formatado, só quando há um nome acima (senão o telefone já é o nome). */
  telefone: string;
  etapa: string;
  naoLidas: number;
  previa: string;
  quando: string;
  chipId: string;
  chipNome: string;
}

export interface ListaDaInbox {
  conversas: ConversaDaLista[];
  temMais: boolean;
  /** Totais dos filtros, já respeitando o chip escolhido. `null` quando a leitura falhou. */
  contagens: { naoLidas: number; esperando: number } | null;
  falhou: boolean;
}

export interface FiltrosDaInbox {
  visao: Visao;
  chipId: string | null;
  busca: string | null;
  limite: number;
}

interface LinhaDeConversa {
  id: string;
  stage: string;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  activity_at: string | null;
  instance_id: string;
  instance_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
}

interface RespostaDaInbox {
  conversations?: LinhaDeConversa[] | null;
  has_more?: boolean;
  counts?: { unread?: number; waiting?: number } | null;
}

const numero = (valor: unknown): number => (typeof valor === 'number' && Number.isFinite(valor) ? valor : 0);

export async function carregarInbox(workspaceId: string, filtros: FiltrosDaInbox, agora: Date = new Date()): Promise<ListaDaInbox> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_inbox', {
    p_workspace_id: workspaceId,
    p_view: visaoNoBanco(filtros.visao),
    p_instance_id: filtros.chipId,
    p_search: filtros.busca,
    p_phones: filtros.busca ? variacoesDeTelefone(filtros.busca) : [],
    p_limit: filtros.limite,
  });

  if (error || !data) {
    console.error('[inbox] não foi possível ler as conversas:', error);
    return { conversas: [], temMais: false, contagens: null, falhou: true };
  }

  const resposta = data as RespostaDaInbox;
  return {
    falhou: false,
    temMais: resposta.has_more === true,
    contagens: resposta.counts ? { naoLidas: numero(resposta.counts.unread), esperando: numero(resposta.counts.waiting) } : null,
    conversas: (resposta.conversations ?? []).map((linha) => {
      const temNome = Boolean(linha.contact_name?.trim());
      return {
        id: linha.id,
        nome: nomeDoContato(linha.contact_name, linha.contact_phone),
        iniciais: iniciaisDoContato(linha.contact_name),
        telefone: temNome ? formatarTelefone(linha.contact_phone) : '',
        etapa: linha.stage,
        naoLidas: numero(linha.unread_count),
        previa: linha.last_message_preview ?? '',
        quando: quandoNaLista(linha.last_message_at ?? linha.activity_at, agora),
        chipId: linha.instance_id,
        chipNome: linha.instance_name ?? '',
      };
    }),
  };
}

/** O arquivo (foto, áudio, vídeo, documento ou figurinha) de uma mensagem, pronto para a tela. */
export interface ArquivoDaMensagem {
  tipo: TipoDeArquivo;
  situacao: SituacaoDoArquivo;
  /** "Foto", "Mensagem de voz", "Documento"... */
  descricao: string;
  /** Endereço (dentro do painel) que mostra o arquivo. Só existe quando ele está guardado. */
  endereco: string | null;
  /** O mesmo arquivo, para baixar com o nome certo. */
  enderecoParaBaixar: string | null;
  /** Nome do documento, como a pessoa mandou. */
  nome: string | null;
  /** "239 KB", "3,2 MB" ou vazio quando o tamanho não é conhecido. */
  tamanho: string;
  /** "0:09" (áudio e vídeo), quando conhecida. */
  duracao: string | null;
  largura: number | null;
  altura: number | null;
}

export interface MensagemDaConversa {
  id: string;
  /** `true` = veio do contato; `false` = saiu do nosso lado. */
  recebida: boolean;
  /** O texto da mensagem; quando há arquivo, é a legenda (e pode estar vazio). */
  texto: string;
  arquivo: ArquivoDaMensagem | null;
  hora: string;
  /** "Hoje", "Ontem" ou a data por extenso: vira o separador de dias da conversa. */
  dia: string;
  /** Só para as que saíram do nosso lado. */
  autor: string | null;
  situacao: SituacaoDoEnvio | null;
}

export interface ConversaAberta {
  id: string;
  etapa: string;
  naoLidas: number;
  contato: { nome: string; iniciais: string; temNome: boolean; telefone: string; apagado: boolean; desde: string };
  chip: { id: string; apelido: string; estado: string; motor: string };
  /** A faixa da IA nesta conversa (o que ela está fazendo aqui e quais botões cabem). `null` = a IA não participa. */
  ia: FaixaDaIa | null;
  mensagens: MensagemDaConversa[];
  temMensagensAnteriores: boolean;
  desde: string;
}

interface LinhaDeMensagem {
  id: string;
  direction: string;
  actor_type: string;
  status: string;
  body_text: string | null;
  occurred_at: string;
  created_at: string;
  from_panel: boolean;
  mine: boolean;
  attachment: LinhaDeArquivo | null;
}

interface LinhaDeArquivo {
  kind: string;
  content_type: string;
  byte_size: number;
  file_name: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  is_voice: boolean;
  object_key: string;
  status: string;
}

const TIPOS_DE_ARQUIVO: readonly string[] = ['image', 'audio', 'video', 'document', 'sticker'];
/** Terminação mais comum de cada tipo, para o arquivo baixado abrir com dois cliques. */
const TERMINACAO: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

/** Nome do arquivo ao baixar: o do documento; para os outros, "foto-2026-11-11-1405.jpg". */
function nomeAoBaixar(linha: LinhaDeArquivo, tipo: TipoDeArquivo, quando: string): string {
  if (linha.file_name?.trim()) return linha.file_name.trim();
  const base = { image: 'foto', audio: 'audio', video: 'video', document: 'documento', sticker: 'figurinha' }[tipo];
  const carimbo = carimboParaNomeDeArquivo(quando);
  const terminacao = TERMINACAO[linha.content_type];
  return `${base}${carimbo ? `-${carimbo}` : ''}${terminacao ? `.${terminacao}` : ''}`;
}

function lerArquivo(linha: LinhaDeArquivo | null | undefined, mensagem: LinhaDeMensagem, agora: Date): ArquivoDaMensagem | null {
  if (!linha || typeof linha !== 'object') return null;
  const tipo = (TIPOS_DE_ARQUIVO.includes(linha.kind) ? linha.kind : 'document') as TipoDeArquivo;
  const situacao = situacaoDoArquivo(linha.status, mensagem.created_at, agora);
  const disponivel = situacao === 'guardado' && ehCaminhoDeArquivo(linha.object_key);
  return {
    tipo,
    situacao: situacao === 'guardado' && !disponivel ? 'falhou' : situacao,
    descricao: nomeDoTipo(tipo, linha.is_voice === true),
    endereco: disponivel ? enderecoDoArquivo(linha.object_key) : null,
    enderecoParaBaixar: disponivel ? enderecoDoArquivo(linha.object_key, nomeAoBaixar(linha, tipo, mensagem.occurred_at)) : null,
    nome: tipo === 'document' ? linha.file_name?.trim() || 'Documento' : null,
    tamanho: tamanhoLegivel(linha.byte_size),
    duracao: tipo === 'audio' || tipo === 'video' ? duracaoLegivel(linha.duration_seconds) : null,
    largura: typeof linha.width === 'number' && linha.width > 0 ? linha.width : null,
    altura: typeof linha.height === 'number' && linha.height > 0 ? linha.height : null,
  };
}

interface RespostaDaConversa {
  conversation: {
    id: string;
    stage: string;
    unread_count: number;
    created_at: string;
    contact: { display_name: string | null; phone_e164: string | null; erased: boolean; created_at: string };
    instance: { id: string; display_name: string; status: string; engine: string };
    ai?: unknown;
  };
  messages?: LinhaDeMensagem[] | null;
  has_more?: boolean;
}

/**
 * Uma conversa com as mensagens mais recentes. `conversa: null` e `falhou: false` significa
 * "não existe (ou não é desta empresa)".
 */
export async function carregarConversa(
  workspaceId: string,
  conversaId: string,
  limiteDeMensagens: number = MENSAGENS_POR_VEZ,
  agora: Date = new Date(),
): Promise<{ conversa: ConversaAberta | null; falhou: boolean }> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_conversation', {
    p_workspace_id: workspaceId,
    p_conversation_id: conversaId,
    p_message_limit: limiteDeMensagens,
  });

  if (error) {
    console.error('[inbox] não foi possível ler a conversa:', error);
    return { conversa: null, falhou: true };
  }
  const resposta = data as RespostaDaConversa | null;
  if (!resposta?.conversation) return { conversa: null, falhou: false };

  const { conversation: conversa } = resposta;
  return {
    falhou: false,
    conversa: {
      id: conversa.id,
      etapa: conversa.stage,
      naoLidas: numero(conversa.unread_count),
      desde: dataCurta(conversa.created_at),
      contato: {
        nome: nomeDoContato(conversa.contact.display_name, conversa.contact.phone_e164),
        iniciais: iniciaisDoContato(conversa.contact.display_name),
        temNome: Boolean(conversa.contact.display_name?.trim()),
        telefone: formatarTelefone(conversa.contact.phone_e164),
        apagado: conversa.contact.erased === true,
        desde: dataCurta(conversa.contact.created_at),
      },
      chip: {
        id: conversa.instance.id,
        apelido: conversa.instance.display_name,
        estado: conversa.instance.status,
        motor: conversa.instance.engine,
      },
      ia: descreverIaNaConversa(lerIaDaConversa(conversa.ai), conversa.stage, agora),
      temMensagensAnteriores: resposta.has_more === true,
      mensagens: (resposta.messages ?? []).map((linha) => {
        const recebida = linha.direction === 'inbound';
        return {
          id: linha.id,
          recebida,
          texto: linha.body_text ?? '',
          arquivo: lerArquivo(linha.attachment, linha, agora),
          hora: horaDaMensagem(linha.occurred_at),
          dia: diaDaConversa(linha.occurred_at, agora),
          autor: recebida ? null : autorDoEnvio({ autor: linha.actor_type, doPainel: linha.from_panel, minha: linha.mine }),
          situacao: recebida ? null : situacaoDoEnvio(linha.status, linha.created_at, agora),
        };
      }),
    },
  };
}

/** Um chip na caixa "Ver por chip". Chips removidos continuam aqui: as conversas deles são o histórico. */
export interface ChipDaInbox {
  id: string;
  apelido: string;
  removido: boolean;
}

export async function listarChipsDaInbox(workspaceId: string): Promise<ChipDaInbox[]> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('instances')
    .select('id, display_name, status')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .returns<Array<{ id: string; display_name: string; status: string }>>();

  if (error) {
    console.error('[inbox] não foi possível ler os chips:', error);
    return [];
  }
  return (data ?? []).map((linha) => ({ id: linha.id, apelido: linha.display_name, removido: linha.status === 'revoked' }));
}

/**
 * "Mudou alguma coisa?" Um texto curto que muda quando qualquer conversa ou chip da empresa muda.
 * `null` quando não deu para ler.
 */
export async function lerVersaoDaInbox(workspaceId: string): Promise<string | null> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_inbox_version', { p_workspace_id: workspaceId });
  if (error || typeof data !== 'string') {
    console.error('[inbox] não foi possível ler a versão:', error);
    return null;
  }
  return data;
}

/**
 * Nome do canal privado de Broadcast (Supabase Realtime) da empresa.
 * Só contém um segredo aleatório opaco, nunca o ID da empresa; `null` quando indisponível.
 */
export async function lerCanalDaInbox(workspaceId: string): Promise<string | null> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_inbox_channel', { p_workspace_id: workspaceId });
  if (error || typeof data !== 'string' || !data.trim()) return null;
  return data.trim();
}
