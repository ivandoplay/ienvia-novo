/**
 * Dados de mentira usados pelos testes de ponta a ponta.
 * Nada aqui existe de verdade: são contas e números inventados só para os testes.
 */
import { audioDeExemplo, figurinhaDeExemplo, fotoDeExemplo, pdfDeExemplo } from './arquivos-de-exemplo.mjs';

export const SENHA_DE_TESTE = 'senha-de-teste-123';
/** A "chave do servidor" que o painel usa nos testes (o Supabase de mentira só aceita esta). */
export const CHAVE_DE_SERVICO_DE_TESTE = 'chave-de-servico-de-teste';

export const WORKSPACE_LOJA = 'a0000000-0000-4000-8000-000000000001';
export const WORKSPACE_OUTRA = 'a0000000-0000-4000-8000-000000000002';
/** Empresa usada só pelos testes da tela de Instâncias (os chips dela são criados e apagados a cada teste). */
export const WORKSPACE_CHIPS = 'a0000000-0000-4000-8000-000000000003';
export const LIMITE_DE_CHIPS = 2;
/** Empresa usada só pelos testes da Inbox (as conversas dela voltam ao começo a cada teste). */
export const WORKSPACE_INBOX = 'a0000000-0000-4000-8000-000000000004';

export const USUARIOS = [
  {
    id: 'b0000000-0000-4000-8000-000000000001',
    email: 'dona@zapia.local',
    nome: 'Dona Maria',
    master: false,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    email: 'master@exemplo.com',
    nome: '',
    master: true,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000003',
    email: 'novato@zapia.local',
    nome: '',
    master: false,
  },
  {
    // Para esta conta o "banco" falha ao listar as empresas (simula o banco fora do ar).
    id: 'b0000000-0000-4000-8000-000000000004',
    email: 'azarado@zapia.local',
    nome: '',
    master: false,
    bancoFalha: true,
  },
  {
    // Dona da empresa dos testes de Instâncias.
    id: 'b0000000-0000-4000-8000-000000000005',
    email: 'chips@zapia.local',
    nome: 'Dona dos Chips',
    master: false,
  },
  {
    // Atendente (não é dona) da Loja da Maria: só olha os chips.
    id: 'b0000000-0000-4000-8000-000000000006',
    email: 'atendente@zapia.local',
    nome: 'Ana Atendente',
    master: false,
  },
  {
    // Dona da empresa dos testes da Inbox.
    id: 'b0000000-0000-4000-8000-000000000007',
    email: 'inbox@zapia.local',
    nome: 'Dona da Inbox',
    master: false,
  },
  {
    // Atendente (não é dono) da empresa da Inbox: responde conversas, mas não mexe nos chips.
    id: 'b0000000-0000-4000-8000-000000000008',
    email: 'colega@zapia.local',
    nome: 'Caio Colega',
    master: false,
  },
];

export const WORKSPACES = [
  { id: WORKSPACE_LOJA, name: 'Loja da Maria', status: 'active', max_instances: 3 },
  { id: WORKSPACE_OUTRA, name: 'Outra Empresa', status: 'active', max_instances: 1 },
  { id: WORKSPACE_CHIPS, name: 'Empresa dos Chips', status: 'active', max_instances: LIMITE_DE_CHIPS },
  { id: WORKSPACE_INBOX, name: 'Empresa da Inbox', status: 'active', max_instances: 2 },
];

/** Quem participa de qual workspace. O "novato" não participa de nenhum. */
export const PARTICIPACOES = [
  { user_id: USUARIOS[0].id, workspace_id: WORKSPACE_LOJA, role: 'owner', status: 'active', created_at: '2026-01-01T00:00:00Z' },
  { user_id: USUARIOS[1].id, workspace_id: WORKSPACE_OUTRA, role: 'owner', status: 'active', created_at: '2026-01-02T00:00:00Z' },
  { user_id: USUARIOS[4].id, workspace_id: WORKSPACE_CHIPS, role: 'owner', status: 'active', created_at: '2026-01-03T00:00:00Z' },
  { user_id: USUARIOS[5].id, workspace_id: WORKSPACE_LOJA, role: 'operator', status: 'active', created_at: '2026-01-04T00:00:00Z' },
  { user_id: USUARIOS[6].id, workspace_id: WORKSPACE_INBOX, role: 'owner', status: 'active', created_at: '2026-01-05T00:00:00Z' },
  { user_id: USUARIOS[7].id, workspace_id: WORKSPACE_INBOX, role: 'operator', status: 'active', created_at: '2026-01-06T00:00:00Z' },
];

/**
 * Mensagem "de agora": a hora é calculada cada vez que alguém pergunta, para o teste
 * valer em qualquer horário do dia (inclusive perto da meia-noite).
 */
const deAgora = (linha) => ({
  ...linha,
  get occurred_at() {
    return new Date().toISOString();
  },
});
const repetir = (quantidade, criar) => Array.from({ length: quantidade }, (_, indice) => criar(indice));

const minutosAtras = (minutos) => new Date(Date.now() - minutos * 60_000).toISOString();
const numerado = (prefixo, numero) => `${prefixo}-0000-4000-8000-${String(numero).padStart(12, '0')}`;

const CHIP_LOJA_COMERCIAL = 'c0000000-0000-4000-8000-000000000001';

/**
 * As conversas da "Loja da Maria": só as quantidades por etapa importam (a Visão geral conta),
 * mas cada uma tem contato, chip e última mensagem para a Inbox da Loja abrir direito.
 */
function conversasDaLoja() {
  const etapas = [
    ['new', 4],
    ['ai', 7],
    ['waiting_human', 3],
    ['human', 2],
    ['waiting_customer', 1],
    ['resolved', 5],
  ];
  const conversas = [];
  const contatos = [];
  let numero = 0;
  for (const [etapa, quantidade] of etapas) {
    for (let vez = 0; vez < quantidade; vez += 1) {
      numero += 1;
      const contato = numerado('c2000000', numero);
      const quando = minutosAtras(numero * 7);
      contatos.push({
        workspace_id: WORKSPACE_LOJA,
        id: contato,
        instance_id: CHIP_LOJA_COMERCIAL,
        display_name: `Cliente ${numero}`,
        phone_e164: `+55859777${String(numero).padStart(5, '0')}`,
        external_user_id: `55859777${String(numero).padStart(5, '0')}@s.whatsapp.net`,
        erased_at: null,
        created_at: '2026-01-01T00:00:00Z',
      });
      conversas.push({
        workspace_id: WORKSPACE_LOJA,
        id: numerado('c1000000', numero),
        contact_id: contato,
        instance_id: CHIP_LOJA_COMERCIAL,
        stage: etapa,
        unread_count: etapa === 'new' || etapa === 'waiting_human' ? 1 : 0,
        automation_paused: false,
        last_message_at: quando,
        last_message_preview: `Mensagem de exemplo ${numero}`,
        activity_at: quando,
        created_at: quando,
      });
    }
  }
  return { conversas, contatos };
}

/* -------------------------------------------------------------------------- */
/* Empresa da Inbox                                                           */
/* -------------------------------------------------------------------------- */

export const CHIP_VENDAS = 'd0000000-0000-4000-8000-000000000001';
export const CHIP_SUPORTE = 'd0000000-0000-4000-8000-000000000002';
/** Chip removido: não aparece em Instâncias, mas as conversas dele continuam na Inbox (é o histórico). */
export const CHIP_ANTIGO = 'd0000000-0000-4000-8000-000000000003';

/** Segredo que a "Evolution" manda junto com os avisos do chip Vendas (o painel só aceita aviso com o segredo certo). */
export const SEGREDO_DO_AVISO_DO_CHIP_VENDAS = 'segredo-de-teste-do-aviso-do-chip-vendas';
export const SEGREDOS_DOS_AVISOS = { 'ienvia-fixo-vendas': SEGREDO_DO_AVISO_DO_CHIP_VENDAS };

/** Nomes dos chips fixos dentro da Evolution de mentira. */
export const CHIPS_FIXOS_NA_EVOLUTION = [
  { nome: 'ienvia-fixo-vendas', estado: 'open', telefone: '5585999990010' },
  { nome: 'ienvia-fixo-suporte', estado: 'close', telefone: null },
];

/**
 * A Evolution de mentira decide o que acontece com um envio pelo fim do número de destino:
 *   ...0404 → "este número não tem WhatsApp" (a mensagem com certeza não sai);
 *   ...0500 → erro do servidor (não dá para saber se saiu);
 *   outro   → enviada.
 */
export const CONVERSAS_DA_INBOX = {
  ana: 'f0000000-0000-4000-8000-000000000001',
  bruno: 'f0000000-0000-4000-8000-000000000002',
  semNome: 'f0000000-0000-4000-8000-000000000003',
  carla: 'f0000000-0000-4000-8000-000000000004',
  diego: 'f0000000-0000-4000-8000-000000000005',
  elisa: 'f0000000-0000-4000-8000-000000000006',
  fabio: 'f0000000-0000-4000-8000-000000000007',
  gabi: 'f0000000-0000-4000-8000-000000000008',
  helena: 'f0000000-0000-4000-8000-000000000009',
};

/** O texto que representa a mensagem na lista de conversas (igual à função message_preview do banco). */
export function previaDaMensagem(texto, anexo) {
  const limpo = String(texto ?? '').trim();
  if (!anexo) return limpo.slice(0, 300);
  const rotulo =
    {
      image: '📷 Foto',
      video: '🎥 Vídeo',
      audio: anexo.voz ? '🎤 Áudio' : '🎵 Áudio',
      sticker: 'Figurinha',
    }[anexo.tipo] ?? `📄 ${String(anexo.nome ?? '').trim() || 'Documento'}`;
  return `${rotulo}${limpo ? `: ${limpo}` : ''}`.slice(0, 300);
}

const NOME_PADRAO_NO_DEPOSITO = { image: 'foto', audio: 'audio', video: 'video', sticker: 'figurinha', document: 'documento' };

/**
 * O cenário da Inbox, sempre "de agora" (as horas são calculadas na hora em que ele é montado):
 *
 *   Ana Souza      nova, 2 não lidas                       chip Vendas (conectado)
 *   Bruno Lima     com você, 1 não lida, já teve resposta  chip Vendas
 *   (sem nome)     aguardando o cliente; começou no celular chip Vendas
 *   Carla Dias     nova, 1 não lida                        chip Suporte (desconectado)
 *   Diego Rocha    resolvida ontem                         chip Vendas
 *   Elisa Prado    com você; o número dela não tem WhatsApp (o envio falha)
 *   Fábio Nunes    com você; a Evolution dá erro (o envio fica sem confirmação)
 *   Gabi Moura     resolvida; conversa de um chip que já foi removido
 *   Helena Castro  aguardando o cliente; conversa com arquivos: foto, áudio, documento, figurinha,
 *                  um vídeo grande demais para guardar e uma foto que o painel não conseguiu trazer
 */
export function criarInbox() {
  const dona = USUARIOS[6].id;
  const colega = USUARIOS[7].id;
  const daInbox = (linha) => ({ workspace_id: WORKSPACE_INBOX, ...linha });
  const chip = (id, apelido, estado, nomeNaEvolution, telefone) =>
    daInbox({
      id,
      display_name: apelido,
      purpose: 'both',
      engine: 'evolution',
      status: estado,
      connected_phone: telefone,
      is_enabled: false,
      provider_instance_name: nomeNaEvolution,
      created_at: `2026-01-0${id.slice(-1)}T00:00:00Z`,
    });

  const instances = [
    chip(CHIP_VENDAS, 'Vendas', 'connected', 'ienvia-fixo-vendas', '+5585999990010'),
    chip(CHIP_SUPORTE, 'Suporte', 'disconnected', 'ienvia-fixo-suporte', null),
    chip(CHIP_ANTIGO, 'Número antigo', 'revoked', 'ienvia-fixo-antigo', null),
  ];

  const contacts = [];
  const conversations = [];
  const messages = [];
  /** A ficha de cada arquivo (tabela message_attachments). */
  const message_attachments = [];
  /** Os arquivos em si, como estariam no depósito: [{ caminho, dados, conteudo }]. */
  const arquivos = [];
  let numeroDaMensagem = 0;

  /**
   * mensagens: [minutos atrás, 'cliente' | 'painel' | 'colega' | 'celular', texto, arquivo?]
   * arquivo:   { tipo, conteudo, dados?, nome?, nomeNoDeposito?, duracao?, largura?, altura?, voz?, tamanho?, status? }
   */
  function conversa(id, numero, nome, telefone, chipId, etapa, naoLidas, mensagens) {
    const contato = numerado('e0000000', numero);
    contacts.push(
      daInbox({
        id: contato,
        instance_id: chipId,
        display_name: nome,
        phone_e164: `+${telefone}`,
        external_user_id: `${telefone}@s.whatsapp.net`,
        erased_at: null,
        created_at: minutosAtras(60 * 24 * 30),
      }),
    );
    let ultima = null;
    for (const [minutos, autor, texto, anexo] of mensagens) {
      numeroDaMensagem += 1;
      const quando = minutosAtras(minutos);
      const recebida = autor === 'cliente';
      const mensagemId = numerado('f1000000', numeroDaMensagem);
      const chave = autor === 'painel' || autor === 'colega' ? `chave-fixa-000000${numeroDaMensagem}` : null;
      let caminho = null;
      if (anexo) {
        const nomeNoDeposito = anexo.nomeNoDeposito ?? NOME_PADRAO_NO_DEPOSITO[anexo.tipo];
        caminho = chave
          ? `${WORKSPACE_INBOX}/${id}/envios/${chave}/${nomeNoDeposito}`
          : `${WORKSPACE_INBOX}/${id}/${mensagemId}/${nomeNoDeposito}`;
        const status = anexo.status ?? 'stored';
        message_attachments.push(
          daInbox({
            id: numerado('f2000000', numeroDaMensagem),
            message_id: mensagemId,
            object_key: caminho,
            kind: anexo.tipo,
            content_type: anexo.conteudo,
            byte_size: anexo.tamanho ?? anexo.dados?.length ?? 0,
            file_name: anexo.nome ?? null,
            duration_seconds: anexo.duracao ?? null,
            width: anexo.largura ?? null,
            height: anexo.altura ?? null,
            is_voice: anexo.voz === true,
            storage_status: status,
          }),
        );
        if (status === 'stored' && anexo.dados) arquivos.push({ caminho, dados: anexo.dados, conteudo: anexo.conteudo });
      }
      ultima = { quando, texto: previaDaMensagem(texto, anexo) };
      messages.push(
        daInbox({
          id: mensagemId,
          conversation_id: id,
          instance_id: chipId,
          provider_message_id: `WA-FIXA-${numeroDaMensagem}`,
          idempotency_key: chave,
          direction: recebida ? 'inbound' : 'outbound',
          source_engine: 'evolution',
          actor_type: recebida ? 'contact' : 'human',
          status: recebida ? 'received' : 'sent',
          body_text: texto || null,
          media_object_key: caminho,
          occurred_at: quando,
          created_at: quando,
          sent_by: autor === 'painel' ? dona : autor === 'colega' ? colega : null,
        }),
      );
    }
    conversations.push(
      daInbox({
        id,
        contact_id: contato,
        instance_id: chipId,
        stage: etapa,
        unread_count: naoLidas,
        automation_paused: false,
        last_message_at: ultima?.quando ?? null,
        last_message_preview: ultima?.texto ?? null,
        activity_at: ultima?.quando ?? minutosAtras(0),
        created_at: minutosAtras(mensagens[0]?.[0] ?? 0),
      }),
    );
  }

  // "Ontem ao meio-dia" no fuso da operação (UTC-3), para valer em qualquer hora em que o teste rode.
  const UM_DIA = 24 * 60 * 60_000;
  const TRES_HORAS = 3 * 60 * 60_000;
  const meiaNoiteDeHoje = Math.floor((Date.now() - TRES_HORAS) / UM_DIA) * UM_DIA + TRES_HORAS;
  const ONTEM = Math.round((Date.now() - (meiaNoiteDeHoje - UM_DIA / 2)) / 60_000);
  const C = CONVERSAS_DA_INBOX;
  conversa(C.ana, 1, 'Ana Souza', '5585988880001', CHIP_VENDAS, 'new', 2, [
    [12, 'cliente', 'Oi, boa tarde!'],
    [11, 'cliente', 'Vocês entregam no centro?'],
  ]);
  conversa(C.bruno, 2, 'Bruno Lima', '5585988880002', CHIP_VENDAS, 'human', 1, [
    [50, 'cliente', 'Qual o valor do frete?'],
    [48, 'painel', 'O frete é R$ 10,00.'],
    [20, 'cliente', 'Fechado, pode mandar.'],
  ]);
  conversa(C.semNome, 3, '', '5511977770003', CHIP_VENDAS, 'waiting_customer', 0, [
    [90, 'celular', 'Olá! Vi que você pediu um orçamento.'],
  ]);
  conversa(C.carla, 4, 'Carla Dias', '5585988880004', CHIP_SUPORTE, 'new', 1, [[30, 'cliente', 'Meu pedido não chegou']]);
  conversa(C.diego, 5, 'Diego Rocha', '5585988880005', CHIP_VENDAS, 'resolved', 0, [
    [ONTEM + 5, 'cliente', 'Obrigado!'],
    [ONTEM, 'colega', 'Por nada! Qualquer coisa é só chamar.'],
  ]);
  conversa(C.elisa, 6, 'Elisa Prado', '5585988880404', CHIP_VENDAS, 'human', 0, [[130, 'cliente', 'Podem me ligar?']]);
  conversa(C.fabio, 7, 'Fábio Nunes', '5585988880500', CHIP_VENDAS, 'human', 0, [[140, 'cliente', 'Tem em estoque?']]);
  conversa(C.gabi, 8, 'Gabi Moura', '5585988880008', CHIP_ANTIGO, 'resolved', 0, [[60 * 24 * 3, 'cliente', 'Oi, ainda atendem neste número?']]);

  // A conversa dos arquivos. É a mais antiga das ativas, para ficar no fim da lista.
  const foto = fotoDeExemplo();
  const fachada = fotoDeExemplo({ tom: 'tarde' });
  const figurinha = figurinhaDeExemplo();
  const voz = audioDeExemplo(3);
  const tabela = pdfDeExemplo();
  conversa(C.helena, 9, 'Helena Castro', '5585988880009', CHIP_VENDAS, 'waiting_customer', 0, [
    [200, 'cliente', 'Olha a vitrine como ficou', { tipo: 'image', conteudo: 'image/png', dados: foto, largura: 480, altura: 360 }],
    [198, 'cliente', '', { tipo: 'audio', conteudo: 'audio/wav', dados: voz, duracao: 3, voz: true }],
    [190, 'painel', 'Segue a tabela.', { tipo: 'document', conteudo: 'application/pdf', dados: tabela, nome: 'Tabela de preços.pdf', nomeNoDeposito: 'Tabela-de-precos.pdf' }],
    [185, 'cliente', '', { tipo: 'sticker', conteudo: 'image/png', dados: figurinha, largura: 192, altura: 192 }],
    [180, 'cliente', 'O vídeo da inauguração', { tipo: 'video', conteudo: 'video/mp4', tamanho: 41_943_040, duracao: 95, status: 'too_large' }],
    [170, 'cliente', '', { tipo: 'image', conteudo: 'image/jpeg', tamanho: 182_000, largura: 480, altura: 360, status: 'failed' }],
    [150, 'painel', 'Nossa fachada nova', { tipo: 'image', conteudo: 'image/png', dados: fachada, largura: 480, altura: 360, nomeNoDeposito: 'fachada.png' }],
  ]);

  return { instances, contacts, conversations, messages, message_attachments, arquivos };
}

/** Linhas de cada tabela. A "Loja da Maria" tem movimento; a "Outra Empresa" está vazia. */
export function criarTabelas() {
  const daLoja = (linha) => ({ workspace_id: WORKSPACE_LOJA, ...linha });
  const loja = conversasDaLoja();
  const inbox = criarInbox();
  return {
    // Os chips da Loja usam o motor local, para a tela de Instâncias não tentar conferi-los na Evolution.
    instances: [
      daLoja({ id: CHIP_LOJA_COMERCIAL, display_name: 'Comercial', purpose: 'both', engine: 'baileys', status: 'connected', connected_phone: '+5585999990001', is_enabled: true, provider_instance_name: null, local_executor_id: null, pairing_qr: null, pairing_code: null, created_at: '2026-01-01T00:00:00Z' }),
      daLoja({ id: 'c0000000-0000-4000-8000-000000000002', display_name: 'Suporte', purpose: 'attendance', engine: 'baileys', status: 'connected', connected_phone: '+5585999990002', is_enabled: false, provider_instance_name: null, local_executor_id: null, pairing_qr: null, pairing_code: null, created_at: '2026-01-02T00:00:00Z' }),
      daLoja({ id: 'c0000000-0000-4000-8000-000000000003', display_name: 'Promoções', purpose: 'campaigns', engine: 'baileys', status: 'disconnected', connected_phone: null, is_enabled: false, provider_instance_name: null, local_executor_id: null, pairing_qr: null, pairing_code: null, created_at: '2026-01-03T00:00:00Z' }),
      ...inbox.instances,
    ],
    local_executors: [],
    local_executor_tokens: [],
    local_motor_commands: [],
    conversations: [...loja.conversas, ...inbox.conversations],
    message_attachments: [...inbox.message_attachments],
    campaigns: [
      daLoja({ id: 'k1', status: 'running' }),
      daLoja({ id: 'k2', status: 'draft' }),
    ],
    messages: [
      ...repetir(12, (n) => deAgora(daLoja({ id: `m-in-${n}`, direction: 'inbound', actor_type: 'contact' }))),
      ...repetir(9, (n) => deAgora(daLoja({ id: `m-ai-${n}`, direction: 'outbound', actor_type: 'ai' }))),
      // Mensagens antigas não entram na conta de "hoje".
      ...repetir(30, (n) => daLoja({ id: `m-old-${n}`, direction: 'inbound', actor_type: 'contact', occurred_at: '2020-01-01T12:00:00Z' })),
      ...inbox.messages,
    ],
    contacts: [
      // 22 contatos das conversas + 19 avulsos = 41 contatos ativos na Loja.
      ...loja.contatos,
      ...repetir(19, (n) => daLoja({ id: `p-${n}`, display_name: `Contato avulso ${n + 1}`, phone_e164: null, erased_at: null })),
      daLoja({ id: 'p-apagado', erased_at: '2026-01-01T00:00:00Z' }),
      ...inbox.contacts,
    ],
  };
}
