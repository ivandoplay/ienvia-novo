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
  formatarDataHoraCurta,
  horaDaMensagem,
  iniciaisDoContato,
  nomeDoContato,
  paraInputDateTimeLocal,
  quandoNaLista,
  situacaoDoEnvio,
  variacoesDeTelefone,
  visaoNoBanco,
  type EtapaDoKanban,
  type FiltroDeNegocio,
  type SituacaoDoEnvio,
  type Visao,
} from '@/lib/inbox/regras';
import { formatarTelefone } from '@/lib/instancias/regras';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Leitura da Inbox e CRM. Tudo passa pelas funções RPC do banco com checagem de vínculo e RLS.
 */

export interface EtiquetaDoCrm {
  id: string;
  nome: string;
  cor: string;
}

export interface RespostaRapida {
  id: string;
  atalho: string;
  titulo: string;
  texto: string;
}

export interface NotaDaConversa {
  id: string;
  texto: string;
  autor: string;
  minha: boolean;
  quando: string;
}

export interface MensagemAgendada {
  id: string;
  texto: string;
  paraQuando: string;
  paraQuandoLabel: string;
  situacao: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  erro: string | null;
}

export interface ConversaDaLista {
  id: string;
  contatoId: string;
  /** Nome para mostrar: o do contato; sem nome, o telefone. */
  nome: string;
  iniciais: string;
  /** Telefone formatado, só quando há um nome acima (senão o telefone já é o nome). */
  telefone: string;
  etapa: string;
  etapaCrm: string;
  valorNegocio: number;
  situacaoNegocio: string;
  fixada: boolean;
  retornoLabel: string;
  iaIgnorada: boolean;
  bloqueado: boolean;
  agendadasPendentes: number;
  etiquetas: EtiquetaDoCrm[];
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
  contagens: { naoLidas: number; esperando: number; arquivadas?: number } | null;
  falhou: boolean;
}

export interface FiltrosDaInbox {
  visao: Visao;
  chipId: string | null;
  busca: string | null;
  limite: number;
  etiquetaId?: string | null;
  negocio?: FiltroDeNegocio | null;
  etapaCrm?: EtapaDoKanban | null;
}

interface LinhaDeEtiqueta {
  id: string;
  name: string;
  color: string;
}

interface LinhaDeConversa {
  id: string;
  contact_id?: string | null;
  stage: string;
  crm_stage?: string | null;
  deal_value?: number | string | null;
  deal_status?: string | null;
  is_pinned?: boolean | null;
  follow_up_at?: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  activity_at: string | null;
  instance_id: string;
  instance_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  ai_ignored?: boolean | null;
  is_blocked?: boolean | null;
  scheduled_count?: number | null;
  tags?: LinhaDeEtiqueta[] | null;
}

interface RespostaDaInbox {
  conversations?: LinhaDeConversa[] | null;
  has_more?: boolean;
  counts?: { unread?: number; waiting?: number } | null;
  archived_count?: number | null;
}

const numero = (valor: unknown): number => {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  if (typeof valor === 'string' && valor.trim()) {
    const parsed = Number(valor);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const lerEtiquetas = (raw: LinhaDeEtiqueta[] | null | undefined): EtiquetaDoCrm[] =>
  Array.isArray(raw)
    ? raw
        .filter((t): t is LinhaDeEtiqueta => Boolean(t && typeof t.id === 'string' && typeof t.name === 'string'))
        .map((t) => ({ id: t.id, nome: t.name, cor: t.color || '#64748b' }))
    : [];

export async function carregarInbox(workspaceId: string, filtros: FiltrosDaInbox, agora: Date = new Date()): Promise<ListaDaInbox> {
  const supabase = await criarClienteServidor();
  const usaFiltrosCrm = Boolean(filtros.etiquetaId || filtros.negocio || filtros.etapaCrm);
  const { data, error } = usaFiltrosCrm
    ? await supabase.rpc('read_my_crm_inbox', {
        p_workspace_id: workspaceId,
        p_view: visaoNoBanco(filtros.visao),
        p_instance_id: filtros.chipId,
        p_search: filtros.busca,
        p_phones: filtros.busca ? variacoesDeTelefone(filtros.busca) : [],
        p_limit: filtros.limite,
        p_tag_id: filtros.etiquetaId ?? null,
        p_deal_status: filtros.negocio ?? null,
        p_crm_stage: filtros.etapaCrm ?? null,
      })
    : await supabase.rpc('read_my_inbox', {
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
    contagens: resposta.counts
      ? {
          naoLidas: numero(resposta.counts.unread),
          esperando: numero(resposta.counts.waiting),
          arquivadas: typeof resposta.archived_count === 'number' ? resposta.archived_count : 0,
        }
      : null,
    conversas: (resposta.conversations ?? []).map((linha) => {
      const temNome = Boolean(linha.contact_name?.trim());
      return {
        id: linha.id,
        contatoId: linha.contact_id ?? '',
        nome: nomeDoContato(linha.contact_name, linha.contact_phone),
        iniciais: iniciaisDoContato(linha.contact_name),
        telefone: temNome ? formatarTelefone(linha.contact_phone) : '',
        etapa: linha.stage,
        etapaCrm: linha.crm_stage ?? 'novo',
        valorNegocio: numero(linha.deal_value),
        situacaoNegocio: linha.deal_status ?? 'open',
        fixada: linha.is_pinned === true,
        retornoLabel: formatarDataHoraCurta(linha.follow_up_at),
        iaIgnorada: linha.ai_ignored === true,
        bloqueado: linha.is_blocked === true,
        agendadasPendentes: numero(linha.scheduled_count),
        etiquetas: lerEtiquetas(linha.tags),
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
  etapaCrm: string;
  valorNegocio: number;
  situacaoNegocio: string;
  motivoPerda: string;
  fixada: boolean;
  retornoEm: string | null;
  retornoInput: string;
  retornoLabel: string;
  naoLidas: number;
  contato: {
    id: string;
    nome: string;
    iniciais: string;
    temNome: boolean;
    telefone: string;
    telefoneCru: string;
    email: string;
    empresa: string;
    documento: string;
    cidade: string;
    origem: string;
    observacoes: string;
    iaIgnorada: boolean;
    bloqueado: boolean;
    canal: string;
    apagado: boolean;
    desde: string;
    etiquetas: EtiquetaDoCrm[];
  };
  chip: { id: string; apelido: string; estado: string; motor: string };
  /** A faixa da IA nesta conversa (o que ela está fazendo aqui e quais botões cabem). `null` = a IA não participa. */
  ia: FaixaDaIa | null;
  mensagens: MensagemDaConversa[];
  notas: NotaDaConversa[];
  agendadas: MensagemAgendada[];
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
    crm_stage?: string | null;
    deal_value?: number | string | null;
    deal_status?: string | null;
    deal_lost_reason?: string | null;
    is_pinned?: boolean | null;
    follow_up_at?: string | null;
    unread_count: number;
    created_at: string;
    contact: {
      id?: string | null;
      display_name: string | null;
      phone_e164: string | null;
      email?: string | null;
      company?: string | null;
      document_id?: string | null;
      city?: string | null;
      lead_source?: string | null;
      notes?: string | null;
      ai_ignored?: boolean | null;
      is_blocked?: boolean | null;
      channel?: string | null;
      erased: boolean;
      created_at: string;
      tags?: LinhaDeEtiqueta[] | null;
    };
    instance: { id: string; display_name: string; status: string; engine: string };
    ai?: unknown;
  };
  messages?: LinhaDeMensagem[] | null;
  notes?: Array<{ id: string; body_text: string; created_at: string; author_name?: string; mine?: boolean }> | null;
  scheduled?: Array<{
    id: string;
    body_text: string;
    scheduled_for: string;
    status: string;
    error_detail?: string | null;
  }> | null;
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
      etapaCrm: conversa.crm_stage ?? 'novo',
      valorNegocio: numero(conversa.deal_value),
      situacaoNegocio: conversa.deal_status ?? 'open',
      motivoPerda: conversa.deal_lost_reason ?? '',
      fixada: conversa.is_pinned === true,
      retornoEm: conversa.follow_up_at ?? null,
      retornoInput: paraInputDateTimeLocal(conversa.follow_up_at),
      retornoLabel: formatarDataHoraCurta(conversa.follow_up_at),
      naoLidas: numero(conversa.unread_count),
      desde: dataCurta(conversa.created_at),
      contato: {
        id: conversa.contact.id ?? '',
        nome: nomeDoContato(conversa.contact.display_name, conversa.contact.phone_e164),
        iniciais: iniciaisDoContato(conversa.contact.display_name),
        temNome: Boolean(conversa.contact.display_name?.trim()),
        telefone: formatarTelefone(conversa.contact.phone_e164),
        telefoneCru: conversa.contact.phone_e164 ?? '',
        email: conversa.contact.email ?? '',
        empresa: conversa.contact.company ?? '',
        documento: conversa.contact.document_id ?? '',
        cidade: conversa.contact.city ?? '',
        origem: conversa.contact.lead_source ?? '',
        observacoes: conversa.contact.notes ?? '',
        iaIgnorada: conversa.contact.ai_ignored === true,
        bloqueado: conversa.contact.is_blocked === true,
        canal: conversa.contact.channel ?? 'whatsapp',
        apagado: conversa.contact.erased === true,
        desde: dataCurta(conversa.contact.created_at),
        etiquetas: lerEtiquetas(conversa.contact.tags),
      },
      chip: {
        id: conversa.instance.id,
        apelido: conversa.instance.display_name,
        estado: conversa.instance.status,
        motor: conversa.instance.engine,
      },
      ia: descreverIaNaConversa(lerIaDaConversa(conversa.ai), conversa.stage, agora),
      temMensagensAnteriores: resposta.has_more === true,
      notas: (resposta.notes ?? []).map((nota) => ({
        id: nota.id,
        texto: nota.body_text,
        autor: nota.mine ? 'Você' : nota.author_name || 'Equipe',
        minha: nota.mine === true,
        quando: formatarDataHoraCurta(nota.created_at),
      })),
      agendadas: (resposta.scheduled ?? []).map((item) => ({
        id: item.id,
        texto: item.body_text,
        paraQuando: item.scheduled_for,
        paraQuandoLabel: formatarDataHoraCurta(item.scheduled_for),
        situacao:
          item.status === 'processing' || item.status === 'sent' || item.status === 'failed' || item.status === 'cancelled'
            ? item.status
            : 'pending',
        erro: item.error_detail ?? null,
      })),
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

/** Etiquetas e respostas rápidas da empresa. */
export interface CatalogosDoCrm {
  etiquetas: EtiquetaDoCrm[];
  respostasRapidas: RespostaRapida[];
  falhou: boolean;
}

export async function carregarCatalogosDoCrm(workspaceId: string): Promise<CatalogosDoCrm> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_crm_catalogs', { p_workspace_id: workspaceId });
  if (error || !data) {
    return { etiquetas: [], respostasRapidas: [], falhou: Boolean(error) };
  }
  const resp = data as {
    tags?: Array<{ id: string; name: string; color: string }> | null;
    quick_replies?: Array<{ id: string; shortcut: string; title: string; body_text: string }> | null;
  };
  return {
    falhou: false,
    etiquetas: (resp.tags ?? []).map((t) => ({ id: t.id, nome: t.name, cor: t.color || '#64748b' })),
    respostasRapidas: (resp.quick_replies ?? []).map((q) => ({
      id: q.id,
      atalho: q.shortcut,
      titulo: q.title,
      texto: q.body_text,
    })),
  };
}

export interface ContatoDoDiretorio {
  id: string;
  nome: string;
  iniciais: string;
  temNome: boolean;
  telefone: string;
  telefoneCru: string;
  email: string;
  empresa: string;
  documento: string;
  cidade: string;
  origem: string;
  observacoes: string;
  iaIgnorada: boolean;
  bloqueado: boolean;
  apagado: boolean;
  canal: string;
  criadoEm: string;
  etiquetas: EtiquetaDoCrm[];
  conversaId: string | null;
  ultimaMensagemEm: string | null;
  ultimaPrevia: string;
  naoLidas: number;
  etapaCrm: string;
  valorNegocio: number;
  situacaoNegocio: string;
  fixada: boolean;
}

export async function carregarDiretorioDeContatos(
  workspaceId: string,
  opcoes: {
    busca?: string | null;
    etiquetaId?: string | null;
    estado?: 'all' | 'ignored' | 'blocked' | 'manual';
    limite?: number;
    deslocamento?: number;
  } = {},
  agora: Date = new Date(),
): Promise<{ contatos: ContatoDoDiretorio[]; total: number; falhou: boolean }> {
  const supabase = await criarClienteServidor();
  const busca = opcoes.busca?.trim() || null;
  const { data, error } = await supabase.rpc('read_my_contacts_directory', {
    p_workspace_id: workspaceId,
    p_search: busca,
    p_phones: busca ? variacoesDeTelefone(busca) : [],
    p_status: opcoes.estado ?? 'all',
    p_limit: opcoes.limite ?? 100,
    p_offset: opcoes.deslocamento ?? 0,
    p_tag_id: opcoes.etiquetaId ?? null,
  });
  if (error || !data) {
    console.error('[crm] não foi possível ler contatos:', error);
    return { contatos: [], total: 0, falhou: true };
  }
  const resp = data as {
    total?: number;
    contacts?: Array<{
      id: string;
      display_name: string | null;
      phone_e164: string | null;
      email: string | null;
      company: string | null;
      document_id: string | null;
      city: string | null;
      lead_source: string | null;
      notes: string | null;
      ai_ignored: boolean;
      is_blocked: boolean;
      erased_at: string | null;
      channel: string;
      created_at: string;
      tags?: LinhaDeEtiqueta[] | null;
      conversation_id: string | null;
      last_message_at: string | null;
      last_message_preview: string | null;
      unread_count: number;
      crm_stage: string | null;
      deal_value: number | string | null;
      deal_status: string | null;
      is_pinned: boolean | null;
    }> | null;
  };
  return {
    falhou: false,
    total: numero(resp.total),
    contatos: (resp.contacts ?? []).map((c) => ({
      id: c.id,
      nome: nomeDoContato(c.display_name, c.phone_e164),
      iniciais: iniciaisDoContato(c.display_name),
      temNome: Boolean(c.display_name?.trim()),
      telefone: formatarTelefone(c.phone_e164),
      telefoneCru: c.phone_e164 ?? '',
      email: c.email ?? '',
      empresa: c.company ?? '',
      documento: c.document_id ?? '',
      cidade: c.city ?? '',
      origem: c.lead_source ?? '',
      observacoes: c.notes ?? '',
      iaIgnorada: c.ai_ignored === true,
      bloqueado: c.is_blocked === true,
      apagado: Boolean(c.erased_at),
      canal: c.channel || 'whatsapp',
      criadoEm: dataCurta(c.created_at),
      etiquetas: lerEtiquetas(c.tags),
      conversaId: c.conversation_id ?? null,
      ultimaMensagemEm: c.last_message_at ? quandoNaLista(c.last_message_at, agora) : null,
      ultimaPrevia: c.last_message_preview ?? '',
      naoLidas: numero(c.unread_count),
      etapaCrm: c.crm_stage ?? 'novo',
      valorNegocio: numero(c.deal_value),
      situacaoNegocio: c.deal_status ?? 'open',
      fixada: c.is_pinned === true,
    })),
  };
}

export interface CartaoDoKanban {
  id: string;
  conversaId: string;
  contatoId: string;
  nome: string;
  iniciais: string;
  telefone: string;
  empresa: string;
  previa: string;
  quando: string;
  etapa: string;
  etapaCrm: string;
  valorNegocio: number;
  situacaoNegocio: string;
  motivoPerda: string;
  fixada: boolean;
  retornoEm: string | null;
  retornoLabel: string;
  naoLidas: number;
  iaIgnorada: boolean;
  chipId: string;
  chipNome: string;
  etiquetas: EtiquetaDoCrm[];
}

export async function carregarKanban(
  workspaceId: string,
  opcoes: { chipId?: string | null; etiquetaId?: string | null; busca?: string | null } = {},
  agora: Date = new Date(),
): Promise<{ cartoes: CartaoDoKanban[]; falhou: boolean }> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_kanban', {
    p_workspace_id: workspaceId,
    p_instance_id: opcoes.chipId ?? null,
    p_tag_id: opcoes.etiquetaId ?? null,
    p_search: opcoes.busca?.trim() || null,
  });
  if (error || !data) {
    console.error('[crm] não foi possível ler kanban:', error);
    return { cartoes: [], falhou: true };
  }
  const resp = data as {
    cards?: Array<{
      id: string;
      contact_id: string;
      instance_id: string;
      instance_name: string | null;
      stage: string;
      crm_stage: string | null;
      deal_value: number | string | null;
      deal_status: string | null;
      deal_lost_reason: string | null;
      is_pinned: boolean | null;
      follow_up_at: string | null;
      unread_count: number;
      last_message_at: string | null;
      last_message_preview: string | null;
      contact_name: string | null;
      contact_phone: string | null;
      contact_company: string | null;
      ai_ignored: boolean | null;
      tags?: LinhaDeEtiqueta[] | null;
    }> | null;
  };
  return {
    falhou: false,
    cartoes: (resp.cards ?? []).map((card) => ({
      id: card.id,
      conversaId: card.id,
      contatoId: card.contact_id,
      nome: nomeDoContato(card.contact_name, card.contact_phone),
      iniciais: iniciaisDoContato(card.contact_name),
      telefone: formatarTelefone(card.contact_phone),
      empresa: card.contact_company ?? '',
      previa: card.last_message_preview ?? '',
      quando: quandoNaLista(card.last_message_at, agora),
      etapa: card.stage,
      etapaCrm: card.crm_stage ?? 'novo',
      valorNegocio: numero(card.deal_value),
      situacaoNegocio: card.deal_status ?? 'open',
      motivoPerda: card.deal_lost_reason ?? '',
      fixada: card.is_pinned === true,
      retornoEm: card.follow_up_at ?? null,
      retornoLabel: formatarDataHoraCurta(card.follow_up_at),
      naoLidas: numero(card.unread_count),
      iaIgnorada: card.ai_ignored === true,
      chipId: card.instance_id,
      chipNome: card.instance_name ?? '',
      etiquetas: lerEtiquetas(card.tags),
    })),
  };
}

export interface ResultadoBuscaGlobal {
  conversas: Array<{
    id: string;
    nome: string;
    telefone: string;
    previa: string;
    quando: string;
    etapaCrm: string;
    valorNegocio: number;
  }>;
  contatos: Array<{
    id: string;
    nome: string;
    telefone: string;
    empresa: string;
    conversaId: string | null;
  }>;
  notas: Array<{
    id: string;
    conversaId: string;
    texto: string;
    contatoNome: string;
  }>;
}

export async function buscarGlobalNoWorkspace(
  workspaceId: string,
  busca: string,
  agora: Date = new Date(),
): Promise<ResultadoBuscaGlobal> {
  const limpo = busca.trim();
  if (!limpo) return { conversas: [], contatos: [], notas: [] };
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('global_search_my_workspace', {
    p_workspace_id: workspaceId,
    p_search: limpo,
    p_phones: variacoesDeTelefone(limpo),
  });
  if (error || !data) return { conversas: [], contatos: [], notas: [] };
  const resp = data as {
    conversations?: Array<{
      id: string;
      contact_name: string | null;
      contact_phone: string | null;
      last_message_preview: string | null;
      last_message_at: string | null;
      crm_stage: string | null;
      deal_value: number | string | null;
    }> | null;
    contacts?: Array<{
      id: string;
      display_name: string | null;
      phone_e164: string | null;
      company: string | null;
      conversation_id: string | null;
    }> | null;
    notes?: Array<{
      id: string;
      conversation_id: string;
      body_text: string;
      contact_name: string | null;
    }> | null;
  };
  return {
    conversas: (resp.conversations ?? []).map((c) => ({
      id: c.id,
      nome: nomeDoContato(c.contact_name, c.contact_phone),
      telefone: formatarTelefone(c.contact_phone),
      previa: c.last_message_preview ?? '',
      quando: quandoNaLista(c.last_message_at, agora),
      etapaCrm: c.crm_stage ?? 'novo',
      valorNegocio: numero(c.deal_value),
    })),
    contatos: (resp.contacts ?? []).map((c) => ({
      id: c.id,
      nome: nomeDoContato(c.display_name, c.phone_e164),
      telefone: formatarTelefone(c.phone_e164),
      empresa: c.company ?? '',
      conversaId: c.conversation_id ?? null,
    })),
    notas: (resp.notes ?? []).map((n) => ({
      id: n.id,
      conversaId: n.conversation_id,
      texto: n.body_text,
      contatoNome: n.contact_name ?? 'Contato',
    })),
  };
}

/** Um chip na caixa "Ver por chip". Chips removidos continuam aqui: as conversas deles são o histórico. */
export interface ChipDaInbox {
  id: string;
  apelido: string;
  removido: boolean;
  estado: string;
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
  return (data ?? []).map((linha) => ({
    id: linha.id,
    apelido: linha.display_name,
    removido: linha.status === 'revoked',
    estado: linha.status,
  }));
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
