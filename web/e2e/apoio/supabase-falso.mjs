/**
 * Um "Supabase de mentira" para os testes de ponta a ponta.
 *
 * Os testes do painel não podem depender do banco de verdade (nem escrever nele).
 * Este servidor imita só o pedacinho do Supabase que o painel usa:
 *   - login, sessão e sair            (/auth/v1/...)
 *   - leitura simples de tabelas       (/rest/v1/<tabela>?coluna=eq.valor)
 *   - contagem de linhas               (HEAD + Prefer: count=exact)
 *   - as ações dos chips               (/rest/v1/rpc/create_my_evolution_instance e afins)
 *   - a Inbox                          (/rest/v1/rpc/read_my_inbox, start_my_text_message e afins)
 *   - o Motor de IA e o Treinamento    (/rest/v1/rpc/read_my_ai_settings, save_my_ai_agent e afins; ver ia-no-banco-falso.mjs)
 *   - o depósito de arquivos           (/storage/v1/object/...: assinar, subir, ler e baixar)
 *   - o que o servidor do painel faz com a "chave do servidor" ao receber um aviso da Evolution
 *     (ingest_evolution_message, begin_media_download, complete_media_download)
 *
 * Ele respeita a regra mais importante do banco real: cada pessoa só enxerga as linhas
 * dos workspaces de que participa. As regras de verdade (RLS) são testadas à parte,
 * em supabase/tests, contra as migrações reais.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import {
  CHAVE_DE_SERVICO_DE_TESTE,
  PARTICIPACOES,
  SEGREDOS_DOS_AVISOS,
  SENHA_DE_TESTE,
  USUARIOS,
  WORKSPACES,
  WORKSPACE_INBOX,
  criarInbox,
  criarTabelas,
  previaDaMensagem,
} from './dados.mjs';
import { FUNCOES_DA_IA, criarIaDoBanco } from './ia-no-banco-falso.mjs';

const PORTA = Number(process.env.PORTA_SUPABASE_FALSO ?? 54399);
const SEGREDO_JWT = 'segredo-so-para-testes';
const UMA_HORA = 3600;

const tabelas = criarTabelas();

/** O depósito de arquivos: caminho → { dados, conteudo }. Começa com os arquivos das conversas de exemplo. */
const deposito = new Map(criarInbox().arquivos.map((arquivo) => [arquivo.caminho, { dados: arquivo.dados, conteudo: arquivo.conteudo }]));
/** Endereços assinados que o depósito já entregou: código → { caminho, uso: 'subir' | 'ler' }. */
const assinaturas = new Map();
/** Avisos da Evolution já recebidos (o mesmo aviso nunca é gravado duas vezes). */
const avisosRecebidos = new Set();
/** Só para os testes: quantas das próximas subidas de arquivo vão falhar (simula a internet caindo no meio). */
let subidasQueVaoFalhar = 0;
/** token de acesso → id do usuário */
const sessoes = new Map();
/** token de renovação → id do usuário */
const renovacoes = new Map();

const base64url = (valor) => Buffer.from(valor).toString('base64url');

function criarJwt(usuario) {
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const corpo = base64url(
    JSON.stringify({
      sub: usuario.id,
      email: usuario.email,
      role: 'authenticated',
      aud: 'authenticated',
      iat: agora,
      exp: agora + UMA_HORA,
      session_id: crypto.randomUUID(),
    }),
  );
  const assinatura = crypto.createHmac('sha256', SEGREDO_JWT).update(`${cabecalho}.${corpo}`).digest('base64url');
  return `${cabecalho}.${corpo}.${assinatura}`;
}

function usuarioPublico(usuario) {
  return {
    id: usuario.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: usuario.email,
    email_confirmed_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function abrirSessao(usuario) {
  const access_token = criarJwt(usuario);
  const refresh_token = crypto.randomBytes(12).toString('hex');
  sessoes.set(access_token, usuario.id);
  renovacoes.set(refresh_token, usuario.id);
  return {
    access_token,
    token_type: 'bearer',
    expires_in: UMA_HORA,
    expires_at: Math.floor(Date.now() / 1000) + UMA_HORA,
    refresh_token,
    user: usuarioPublico(usuario),
  };
}

const tokenDaRequisicao = (req) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

function usuarioDaRequisicao(req) {
  const id = sessoes.get(tokenDaRequisicao(req));
  return id ? USUARIOS.find((usuario) => usuario.id === id) : undefined;
}

/** O pedido veio do servidor do painel, com a chave do servidor? (ela ignora as regras por usuário) */
const ehOServidorDoPainel = (req) => tokenDaRequisicao(req) === CHAVE_DE_SERVICO_DE_TESTE;

function workspacesDoUsuario(usuario) {
  return PARTICIPACOES.filter((p) => p.user_id === usuario.id && p.status === 'active').map((p) => p.workspace_id);
}

/** Entende os filtros simples do PostgREST: eq, gte e is.null. */
function passaNoFiltro(linha, coluna, expressao) {
  const valor = linha[coluna];
  if (expressao.startsWith('eq.')) return String(valor) === expressao.slice(3);
  if (expressao.startsWith('neq.')) return String(valor) !== expressao.slice(4);
  if (expressao.startsWith('gte.')) return String(valor) >= expressao.slice(4);
  if (expressao === 'is.null') return valor === null || valor === undefined;
  throw new Error(`Filtro não suportado pelo Supabase de mentira: ${coluna}=${expressao}`);
}

function lerCorpo(req) {
  return new Promise((resolve) => {
    let texto = '';
    req.on('data', (parte) => (texto += parte));
    req.on('end', () => {
      try {
        resolve(texto ? JSON.parse(texto) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** O corpo do pedido como veio (um arquivo), com um teto para não estourar a memória do teste. */
function lerArquivo(req, teto = 40 * 1024 * 1024) {
  return new Promise((resolve) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', (parte) => {
      tamanho += parte.length;
      if (tamanho <= teto) partes.push(parte);
    });
    req.on('end', () => resolve({ dados: Buffer.concat(partes), tamanho }));
  });
}

function responder(res, status, corpo, cabecalhos = {}) {
  const texto = corpo === undefined ? '' : JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cabecalhos });
  res.end(texto);
}

const naoAutorizado = (res) => responder(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });

async function rotasDeLogin(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
    const corpo = await lerCorpo(req);
    const tipo = url.searchParams.get('grant_type');

    if (tipo === 'password') {
      const usuario = USUARIOS.find((u) => u.email === String(corpo.email ?? '').toLowerCase());
      if (!usuario || corpo.password !== SENHA_DE_TESTE) {
        return responder(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      return responder(res, 200, abrirSessao(usuario));
    }

    if (tipo === 'refresh_token') {
      const id = renovacoes.get(corpo.refresh_token);
      const usuario = USUARIOS.find((u) => u.id === id);
      if (!usuario) {
        return responder(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      }
      renovacoes.delete(corpo.refresh_token);
      return responder(res, 200, abrirSessao(usuario));
    }
  }

  if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
    const usuario = usuarioDaRequisicao(req);
    return usuario ? responder(res, 200, usuarioPublico(usuario)) : naoAutorizado(res);
  }

  if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    sessoes.delete(token);
    res.writeHead(204);
    return res.end();
  }

  return responder(res, 404, { msg: `Rota de login não imitada: ${req.method} ${url.pathname}` });
}

const ESTADOS_DA_EVOLUTION = { open: 'connected', connecting: 'connecting', close: 'disconnected', closed: 'disconnected', error: 'error' };

/**
 * As ações dos chips, com as mesmas regras do banco de verdade: só o dono da empresa executa,
 * o limite de chips é respeitado e chip removido ("revoked") deixa de existir para as demais ações.
 */
function acoesDosChips(res, usuario, nome, corpo) {
  const erro = (status, code, message) => responder(res, status, { code, details: null, hint: null, message });
  const workspaceId = corpo.p_workspace_id;
  const ehDono = PARTICIPACOES.some(
    (p) => p.user_id === usuario.id && p.workspace_id === workspaceId && p.role === 'owner' && p.status === 'active',
  );
  if (!ehDono) return erro(403, '42501', 'Workspace owner required');

  const chips = tabelas.instances;
  if (nome === 'create_my_evolution_instance') {
    const limite = WORKSPACES.find((w) => w.id === workspaceId)?.max_instances ?? 1;
    const emUso = chips.filter((chip) => chip.workspace_id === workspaceId && chip.status !== 'revoked').length;
    if (emUso >= limite) return erro(400, 'P0001', 'instance_limit_reached');
    const novo = {
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      display_name: String(corpo.p_display_name).trim(),
      purpose: corpo.p_purpose,
      engine: 'evolution',
      status: 'disconnected',
      connected_phone: null,
      is_enabled: false,
      provider_instance_name: corpo.p_provider_instance_name,
      created_at: new Date().toISOString(),
    };
    chips.push(novo);
    return responder(res, 200, { id: novo.id, provider_instance_name: novo.provider_instance_name, status: novo.status });
  }

  const chip = chips.find((item) => item.id === corpo.p_instance_id && item.workspace_id === workspaceId && item.status !== 'revoked');
  if (!chip) return erro(400, 'P0002', 'Instance not found');

  if (nome === 'update_my_instance_settings') {
    chip.display_name = String(corpo.p_display_name).trim();
    chip.purpose = corpo.p_purpose;
    return responder(res, 200, { id: chip.id, display_name: chip.display_name, purpose: chip.purpose });
  }
  if (nome === 'sync_my_evolution_instance') {
    const estado = ESTADOS_DA_EVOLUTION[corpo.p_provider_state];
    if (!estado) return erro(400, '22023', 'Unsupported provider state');
    chip.status = estado;
    if (estado === 'connected' && corpo.p_connected_phone) chip.connected_phone = corpo.p_connected_phone;
    return responder(res, 200, { id: chip.id, status: chip.status, connected_phone: chip.connected_phone, last_seen_at: null });
  }
  if (nome === 'rotate_my_evolution_webhook_token') {
    return responder(res, 200, { id: chip.id });
  }
  if (nome === 'remove_my_instance') {
    chip.status = 'revoked';
    chip.is_enabled = false;
    return responder(res, 200, { id: chip.id, provider_instance_name: chip.provider_instance_name });
  }
  return erro(404, 'PGRST202', `Função não imitada: ${nome}`);
}

/* -------------------------------------------------------------------------- */
/* Inbox                                                                      */
/* -------------------------------------------------------------------------- */

/** Sobe a cada mudança numa empresa; é o que a tela consulta para saber se precisa recarregar. */
const mudancas = new Map();
const anotarMudanca = (workspaceId) => mudancas.set(workspaceId, (mudancas.get(workspaceId) ?? 0) + 1);

/** Empresas com a IA pausada ("Pausar tudo"): empresa → quando foi pausada. */
const pausasDaIa = new Map();
const UMA_HORA_EM_MS = 60 * 60_000;

/** Como a IA está numa conversa, no formato que read_my_conversation devolve em conversation.ai. */
function iaDaConversa(conversa, chip) {
  const agora = Date.now();
  const ate = conversa.ai_paused_until && new Date(conversa.ai_paused_until).getTime() > agora ? conversa.ai_paused_until : null;
  const travada = conversa.automation_paused === true;
  return {
    chip_enabled: chip.is_enabled === true,
    workspace_paused: pausasDaIa.has(conversa.workspace_id),
    locked: travada,
    paused_until: travada ? null : ate,
    pause_reason: conversa.ai_pause_reason ?? null,
    handoff_at: conversa.ai_handoff_at ?? null,
    handoff_note: conversa.ai_handoff_note ?? null,
    working: conversa.ai_working === true,
  };
}

const ETAPAS_ABERTAS = ['new', 'ai', 'waiting_human', 'human', 'waiting_customer'];
const ETAPAS_QUE_ESPERAM = ['new', 'waiting_human', 'human'];
const FUNCOES_DA_INBOX = [
  'read_my_inbox',
  'read_my_conversation',
  'read_my_inbox_version',
  'start_my_text_message',
  'start_my_media_message',
  'finish_my_text_message',
  'transition_workspace_conversation',
];
/** Funções que só o servidor do painel chama (com a chave do servidor). */
const FUNCOES_DO_SERVIDOR = ['ingest_evolution_message', 'begin_media_download', 'complete_media_download'];

const MB = 1024 * 1024;
const CAMINHO_DE_ENVIO = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/envios\/[a-zA-Z0-9_-]{16,80}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

const fichaDoArquivo = (mensagemId) => tabelas.message_attachments.find((ficha) => ficha.message_id === mensagemId);
/** A ficha do arquivo no formato que previaDaMensagem entende. */
const anexoParaPrevia = (ficha) => (ficha ? { tipo: ficha.kind, voz: ficha.is_voice, nome: ficha.file_name } : null);

const limitar = (valor, padrao, maximo) => Math.min(Math.max(Number.isInteger(valor) ? valor : padrao, 1), maximo);

/** Igual ao banco de verdade: atualiza a conversa depois de uma mensagem nossa. */
function tocarConversaDepoisDoEnvio(conversa, texto, quando) {
  if (!conversa.last_message_at || quando >= conversa.last_message_at) conversa.last_message_preview = texto.slice(0, 300);
  if (!conversa.last_message_at || quando > conversa.last_message_at) conversa.last_message_at = quando;
  conversa.activity_at = conversa.last_message_at;
  conversa.unread_count = 0;
  if (ETAPAS_QUE_ESPERAM.includes(conversa.stage) || conversa.stage === 'ai') conversa.stage = 'waiting_customer';
  // Uma pessoa respondeu: a IA para nesta conversa por uma hora (o padrão do Motor de IA), como no banco de verdade.
  if (!conversa.automation_paused) conversa.ai_paused_until = new Date(Date.now() + UMA_HORA_EM_MS).toISOString();
  if (conversa.ai_pause_reason !== 'claimed') conversa.ai_pause_reason = 'human_reply';
  // O recado que a IA tinha deixado já foi atendido.
  conversa.ai_handoff_at = null;
  conversa.ai_handoff_note = null;
  conversa.ai_working = false;
}

/**
 * A IA da empresa: o resumo para o topo do painel, "Pausar tudo", retomar e o liga/desliga de cada chip.
 * As mesmas regras do banco de verdade: qualquer pessoa ativa da empresa lê e pausa; só o dono retoma e mexe nos chips;
 * para ligar a IA num chip é preciso a chave do provedor principal e uma base de treinamento.
 */
const FUNCOES_DO_ATENDENTE = ['read_my_ai_overview', 'pause_my_ai', 'resume_my_ai', 'set_my_instance_ai'];

function acoesDoAtendente(res, usuario, nome, corpo) {
  const erro = (status, code, message) => responder(res, status, { code, details: null, hint: null, message });
  const workspaceId = corpo.p_workspace_id;
  const papel = PARTICIPACOES.find((p) => p.user_id === usuario.id && p.workspace_id === workspaceId && p.status === 'active')?.role ?? null;
  const ehDono = papel === 'owner';
  const chips = tabelas.instances.filter((chip) => chip.workspace_id === workspaceId && chip.status !== 'revoked');

  if (nome === 'read_my_ai_overview') {
    if (!papel) return erro(403, '42501', 'Workspace membership required');
    return responder(res, 200, {
      paused: pausasDaIa.has(workspaceId),
      paused_at: pausasDaIa.get(workspaceId) ?? null,
      can_resume: ehDono,
      can_switch_chips: ehDono,
      missing: iaDoBanco.faltaParaAIa(workspaceId),
      chips_enabled: chips.filter((chip) => chip.is_enabled).length,
      chips_answering: chips.filter((chip) => chip.is_enabled && chip.status === 'connected').length,
    });
  }
  if (nome === 'pause_my_ai') {
    if (!papel) return erro(403, '42501', 'Workspace membership required');
    const mudou = !pausasDaIa.has(workspaceId);
    if (mudou) pausasDaIa.set(workspaceId, new Date().toISOString());
    anotarMudanca(workspaceId);
    return responder(res, 200, { paused: true, changed: mudou });
  }
  if (nome === 'resume_my_ai') {
    if (!ehDono) return erro(403, '42501', 'Workspace owner required');
    const mudou = pausasDaIa.delete(workspaceId);
    anotarMudanca(workspaceId);
    return responder(res, 200, { paused: false, changed: mudou });
  }
  if (nome === 'set_my_instance_ai') {
    if (!ehDono) return erro(403, '42501', 'Workspace owner required');
    if (typeof corpo.p_enabled !== 'boolean') return erro(400, '22023', 'Invalid value');
    const chip = chips.find((item) => item.id === corpo.p_instance_id);
    if (!chip) return erro(400, 'P0002', 'Instance not found');
    if (chip.is_enabled === corpo.p_enabled) return responder(res, 200, { id: chip.id, is_enabled: chip.is_enabled, changed: false });
    if (corpo.p_enabled) {
      if (chip.engine !== 'evolution') return erro(400, 'P0001', 'instance_unavailable');
      const falta = iaDoBanco.faltaParaAIa(workspaceId, chip.id);
      if (falta) return erro(400, 'P0001', falta);
    }
    chip.is_enabled = corpo.p_enabled;
    anotarMudanca(workspaceId);
    return responder(res, 200, { id: chip.id, is_enabled: chip.is_enabled, changed: true });
  }
  return erro(404, 'PGRST202', `Função não imitada: ${nome}`);
}

/**
 * As funções da Inbox, com as mesmas regras e as mesmas respostas do banco de verdade
 * (supabase/migrations, testadas em supabase/tests/conversa.test.ts e inbox.test.ts).
 * Qualquer pessoa ativa da empresa pode usar.
 */
function acoesDaInbox(res, usuario, nome, corpo) {
  const erro = (status, code, message) => responder(res, status, { code, details: null, hint: null, message });
  const workspaceId = corpo.p_workspace_id;
  const participa = PARTICIPACOES.some((p) => p.user_id === usuario.id && p.workspace_id === workspaceId && p.status === 'active');

  if (nome === 'read_my_inbox_version') {
    if (!participa) return responder(res, 200, '');
    const naoLidas = tabelas.conversations
      .filter((conversa) => conversa.workspace_id === workspaceId)
      .reduce((soma, conversa) => soma + (conversa.unread_count ?? 0), 0);
    return responder(res, 200, `${mudancas.get(workspaceId) ?? 0}|${naoLidas}`);
  }
  if (!participa) return erro(403, '42501', 'Workspace membership required');

  const daEmpresa = (tabela) => tabelas[tabela].filter((linha) => linha.workspace_id === workspaceId);
  const contatoDe = (conversa) => daEmpresa('contacts').find((contato) => contato.id === conversa.contact_id) ?? {};
  const chipDe = (conversa) => daEmpresa('instances').find((chip) => chip.id === conversa.instance_id) ?? {};

  if (nome === 'read_my_inbox') {
    let conversas = daEmpresa('conversations');
    if (corpo.p_instance_id) conversas = conversas.filter((conversa) => conversa.instance_id === corpo.p_instance_id);
    const doChip = conversas;

    const busca = String(corpo.p_search ?? '').trim();
    if (busca) {
      if (busca.length > 80) return erro(400, '22023', 'Search text too long');
      const procurado = busca.toLowerCase();
      const telefones = (corpo.p_phones ?? []).filter((trecho) => /^[0-9]{4,20}$/.test(trecho));
      conversas = conversas.filter((conversa) => {
        if (conversa.stage === 'archived') return false;
        const contato = contatoDe(conversa);
        return (
          String(contato.display_name ?? '').toLowerCase().includes(procurado) ||
          String(conversa.last_message_preview ?? '').toLowerCase().includes(procurado) ||
          telefones.some((trecho) => String(contato.phone_e164 ?? '').includes(trecho))
        );
      });
    } else {
      const filtros = {
        open: (conversa) => ETAPAS_ABERTAS.includes(conversa.stage),
        unread: (conversa) => conversa.unread_count > 0 && ETAPAS_ABERTAS.includes(conversa.stage),
        waiting: (conversa) => ETAPAS_QUE_ESPERAM.includes(conversa.stage),
        resolved: (conversa) => conversa.stage === 'resolved',
      };
      const filtro = filtros[corpo.p_view ?? 'open'];
      if (!filtro) return erro(400, '22023', 'Unsupported inbox view');
      conversas = conversas.filter(filtro);
    }

    conversas = [...conversas].sort((a, b) => String(b.activity_at).localeCompare(String(a.activity_at)) || String(b.id).localeCompare(String(a.id)));
    const limite = limitar(corpo.p_limit, 50, 200);
    return responder(res, 200, {
      conversations: conversas.slice(0, limite).map((conversa) => {
        const contato = contatoDe(conversa);
        return {
          id: conversa.id,
          stage: conversa.stage,
          unread_count: conversa.unread_count ?? 0,
          last_message_at: conversa.last_message_at ?? null,
          last_message_preview: conversa.last_message_preview ?? null,
          activity_at: conversa.activity_at ?? conversa.created_at ?? null,
          automation_paused: conversa.automation_paused ?? false,
          instance_id: conversa.instance_id,
          instance_name: chipDe(conversa).display_name ?? null,
          contact_id: conversa.contact_id,
          contact_name: contato.display_name ?? '',
          contact_phone: contato.phone_e164 ?? null,
        };
      }),
      has_more: conversas.length > limite,
      counts: {
        unread: doChip.filter((conversa) => conversa.unread_count > 0 && ETAPAS_ABERTAS.includes(conversa.stage)).length,
        waiting: doChip.filter((conversa) => ETAPAS_QUE_ESPERAM.includes(conversa.stage)).length,
      },
    });
  }

  if (nome === 'read_my_conversation') {
    const conversa = daEmpresa('conversations').find((item) => item.id === corpo.p_conversation_id);
    if (!conversa) return responder(res, 200, null);
    const contato = contatoDe(conversa);
    const chip = chipDe(conversa);
    const limite = limitar(corpo.p_message_limit, 200, 1000);
    const mensagens = daEmpresa('messages')
      .filter((mensagem) => mensagem.conversation_id === conversa.id)
      .sort(
        (a, b) =>
          String(b.occurred_at).localeCompare(String(a.occurred_at)) ||
          String(b.created_at).localeCompare(String(a.created_at)) ||
          String(b.id).localeCompare(String(a.id)),
      );
    return responder(res, 200, {
      conversation: {
        id: conversa.id,
        stage: conversa.stage,
        unread_count: conversa.unread_count ?? 0,
        automation_paused: conversa.automation_paused ?? false,
        created_at: conversa.created_at,
        last_message_at: conversa.last_message_at ?? null,
        contact: {
          id: contato.id,
          display_name: contato.display_name ?? '',
          phone_e164: contato.phone_e164 ?? null,
          erased: Boolean(contato.erased_at),
          created_at: contato.created_at,
        },
        instance: { id: chip.id, display_name: chip.display_name, status: chip.status, engine: chip.engine },
        ai: iaDaConversa(conversa, chip),
      },
      messages: mensagens
        .slice(0, limite)
        .reverse()
        .map((mensagem) => {
          const ficha = fichaDoArquivo(mensagem.id);
          return {
            id: mensagem.id,
            direction: mensagem.direction,
            actor_type: mensagem.actor_type,
            status: mensagem.status,
            body_text: mensagem.body_text,
            occurred_at: mensagem.occurred_at,
            created_at: mensagem.created_at,
            from_panel: Boolean(mensagem.sent_by),
            mine: mensagem.sent_by === usuario.id,
            attachment: ficha
              ? {
                  kind: ficha.kind,
                  content_type: ficha.content_type,
                  byte_size: ficha.byte_size,
                  file_name: ficha.file_name,
                  duration_seconds: ficha.duration_seconds,
                  width: ficha.width,
                  height: ficha.height,
                  is_voice: ficha.is_voice,
                  object_key: ficha.object_key,
                  status: ficha.storage_status,
                }
              : null,
          };
        }),
      has_more: mensagens.length > limite,
    });
  }

  if (nome === 'start_my_text_message') {
    const texto = String(corpo.p_body_text ?? '').trim();
    if (texto.length < 1 || texto.length > 4096) return erro(400, '22023', 'Invalid message text');
    if (typeof corpo.p_idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(corpo.p_idempotency_key)) {
      return erro(400, '22023', 'Invalid idempotency key');
    }
    const conversa = daEmpresa('conversations').find((item) => item.id === corpo.p_conversation_id);
    if (!conversa) return erro(400, 'P0002', 'Conversation not found');

    const repetida = daEmpresa('messages').find((mensagem) => mensagem.idempotency_key === corpo.p_idempotency_key);
    if (repetida) {
      return responder(res, 200, { message_id: repetida.id, status: repetida.status, already_exists: true, body_text: repetida.body_text });
    }
    if (['resolved', 'archived'].includes(conversa.stage)) return erro(400, 'P0001', 'conversation_closed');

    const chip = chipDe(conversa);
    if (!chip.id || chip.engine !== 'evolution' || chip.status === 'revoked' || !chip.provider_instance_name) {
      return erro(400, 'P0001', 'instance_unavailable');
    }
    if (chip.status !== 'connected') return erro(400, 'P0001', 'instance_not_connected');

    const contato = contatoDe(conversa);
    if (!contato.id || contato.erased_at || !/^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$/.test(String(contato.external_user_id ?? ''))) {
      return erro(400, 'P0001', 'contact_unreachable');
    }

    const agora = new Date().toISOString();
    const nova = {
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      conversation_id: conversa.id,
      instance_id: chip.id,
      provider_message_id: null,
      idempotency_key: corpo.p_idempotency_key,
      direction: 'outbound',
      source_engine: 'evolution',
      actor_type: 'human',
      status: 'sending',
      body_text: texto,
      occurred_at: agora,
      created_at: agora,
      sent_by: usuario.id,
    };
    tabelas.messages.push(nova);
    return responder(res, 200, {
      message_id: nova.id,
      status: nova.status,
      already_exists: false,
      provider_instance_name: chip.provider_instance_name,
      recipient: contato.external_user_id,
      body_text: texto,
    });
  }

  if (nome === 'start_my_media_message') {
    const legenda = String(corpo.p_caption ?? '').trim() || null;
    if (typeof corpo.p_idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(corpo.p_idempotency_key)) {
      return erro(400, '22023', 'Invalid idempotency key');
    }
    if (!['image', 'audio', 'video', 'document'].includes(corpo.p_kind)) return erro(400, '22023', 'Invalid media kind');
    if ((legenda?.length ?? 0) > 1024 || (corpo.p_kind === 'audio' && legenda)) return erro(400, '22023', 'Invalid caption');

    const conversa = daEmpresa('conversations').find((item) => item.id === corpo.p_conversation_id);
    if (!conversa) return erro(400, 'P0002', 'Conversation not found');
    const repetida = daEmpresa('messages').find((mensagem) => mensagem.idempotency_key === corpo.p_idempotency_key);
    if (repetida) return responder(res, 200, { message_id: repetida.id, status: repetida.status, already_exists: true });
    if (['resolved', 'archived'].includes(conversa.stage)) return erro(400, 'P0001', 'conversation_closed');

    const chip = chipDe(conversa);
    if (!chip.id || chip.engine !== 'evolution' || chip.status === 'revoked' || !chip.provider_instance_name) {
      return erro(400, 'P0001', 'instance_unavailable');
    }
    if (chip.status !== 'connected') return erro(400, 'P0001', 'instance_not_connected');
    const contato = contatoDe(conversa);
    if (!contato.id || contato.erased_at || !/^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$/.test(String(contato.external_user_id ?? ''))) {
      return erro(400, 'P0001', 'contact_unreachable');
    }

    const caminho = String(corpo.p_object_key ?? '');
    if (!CAMINHO_DE_ENVIO.test(caminho) || !caminho.startsWith(`${workspaceId}/${conversa.id}/envios/${corpo.p_idempotency_key}/`)) {
      return erro(400, '22023', 'Invalid media path');
    }
    const guardado = deposito.get(caminho);
    if (!guardado) return erro(400, 'P0001', 'media_not_uploaded');
    const tamanho = guardado.dados.length;
    const conteudo = String(guardado.conteudo ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    if (tamanho < 1) return erro(400, 'P0001', 'media_empty');
    if (tamanho > (corpo.p_kind === 'document' ? 25 : 16) * MB) return erro(400, 'P0001', 'media_too_large');
    if (
      (corpo.p_kind === 'image' && !['image/jpeg', 'image/png', 'image/webp'].includes(conteudo)) ||
      (corpo.p_kind === 'video' && conteudo !== 'video/mp4') ||
      (corpo.p_kind === 'audio' && !conteudo.startsWith('audio/'))
    ) {
      return erro(400, 'P0001', 'media_type_mismatch');
    }

    const agora = new Date().toISOString();
    const nomeDoArquivo = String(corpo.p_file_name ?? '').trim().slice(0, 200) || null;
    const nova = {
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      conversation_id: conversa.id,
      instance_id: chip.id,
      provider_message_id: null,
      idempotency_key: corpo.p_idempotency_key,
      direction: 'outbound',
      source_engine: 'evolution',
      actor_type: 'human',
      status: 'sending',
      body_text: legenda,
      media_object_key: caminho,
      occurred_at: agora,
      created_at: agora,
      sent_by: usuario.id,
    };
    tabelas.messages.push(nova);
    const inteiroEntre = (valor, minimo, maximo) => (Number.isInteger(valor) && valor >= minimo && valor <= maximo ? valor : null);
    tabelas.message_attachments.push({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      message_id: nova.id,
      object_key: caminho,
      kind: corpo.p_kind,
      content_type: conteudo,
      byte_size: tamanho,
      file_name: nomeDoArquivo,
      duration_seconds: inteiroEntre(corpo.p_duration_seconds, 0, 86400),
      width: inteiroEntre(corpo.p_width, 1, 20000),
      height: inteiroEntre(corpo.p_height, 1, 20000),
      is_voice: corpo.p_kind === 'audio',
      storage_status: 'stored',
    });
    return responder(res, 200, {
      message_id: nova.id,
      status: nova.status,
      already_exists: false,
      provider_instance_name: chip.provider_instance_name,
      recipient: contato.external_user_id,
      object_key: caminho,
      kind: corpo.p_kind,
      content_type: conteudo,
      byte_size: tamanho,
      file_name: nomeDoArquivo,
      caption: legenda,
    });
  }

  if (nome === 'finish_my_text_message') {
    if (!['sent', 'failed', 'uncertain'].includes(corpo.p_outcome)) return erro(400, '22023', 'Invalid outcome');
    const mensagem = daEmpresa('messages').find((item) => item.id === corpo.p_message_id && item.direction === 'outbound');
    if (!mensagem) return erro(400, 'P0002', 'Message not found');
    const semMudanca = () => responder(res, 200, { message_id: mensagem.id, status: mensagem.status, changed: false });

    if (mensagem.status === 'sent') {
      if (corpo.p_outcome === 'sent' && corpo.p_provider_message_id) mensagem.provider_message_id = corpo.p_provider_message_id;
      return semMudanca();
    }
    const emAberto = ['sending', 'awaiting_human_confirmation'].includes(mensagem.status);
    if (!emAberto || (mensagem.status === 'awaiting_human_confirmation' && corpo.p_outcome === 'uncertain')) return semMudanca();

    mensagem.status = { sent: 'sent', failed: 'failed', uncertain: 'awaiting_human_confirmation' }[corpo.p_outcome];
    if (corpo.p_outcome === 'sent' && corpo.p_provider_message_id) mensagem.provider_message_id = corpo.p_provider_message_id;
    const conversa = daEmpresa('conversations').find((item) => item.id === mensagem.conversation_id);
    if (conversa && mensagem.status === 'sent') {
      tocarConversaDepoisDoEnvio(conversa, previaDaMensagem(mensagem.body_text, anexoParaPrevia(fichaDoArquivo(mensagem.id))), mensagem.occurred_at);
    }
    anotarMudanca(workspaceId);
    return responder(res, 200, { message_id: mensagem.id, status: mensagem.status, changed: true });
  }

  if (nome === 'transition_workspace_conversation') {
    const conversa = daEmpresa('conversations').find((item) => item.id === corpo.p_conversation_id);
    if (!conversa) return erro(400, 'P0002', 'Conversation not found');

    if (corpo.p_action === 'claim') {
      if (['resolved', 'archived'].includes(conversa.stage)) return erro(400, '22023', 'Conversation is not active');
      if (conversa.assigned_user_id && conversa.assigned_user_id !== usuario.id) {
        return erro(400, '22023', 'Conversation is assigned to another teammate');
      }
      Object.assign(conversa, {
        stage: 'human',
        automation_paused: true,
        ai_pause_reason: 'claimed',
        ai_paused_until: null,
        ai_working: false,
        assigned_user_id: usuario.id,
        assigned_label: 'Atendente',
      });
    } else if (corpo.p_action === 'release') {
      // Devolver para a IA: ela volta a responder a partir da próxima mensagem do contato.
      if (['resolved', 'archived'].includes(conversa.stage)) return erro(400, '22023', 'Conversation is not active');
      Object.assign(conversa, {
        automation_paused: false,
        ai_paused_until: null,
        ai_pause_reason: null,
        ai_handoff_at: null,
        ai_handoff_note: null,
        assigned_user_id: null,
        assigned_label: null,
      });
    } else if (corpo.p_action === 'resolve') {
      if (conversa.stage === 'archived') return erro(400, '22023', 'Archived conversation cannot be resolved again');
      Object.assign(conversa, { stage: 'resolved', automation_paused: true, unread_count: 0 });
    } else if (corpo.p_action === 'reopen') {
      if (conversa.stage !== 'resolved') return erro(400, '22023', 'Conversation is not resolved');
      const outraAberta = daEmpresa('conversations').some(
        (outra) =>
          outra.id !== conversa.id &&
          outra.contact_id === conversa.contact_id &&
          outra.instance_id === conversa.instance_id &&
          !['resolved', 'archived'].includes(outra.stage),
      );
      if (outraAberta) return erro(400, 'P0001', 'another_open_conversation');
      conversa.stage = 'human';
    } else if (corpo.p_action === 'mark_read') {
      conversa.unread_count = 0;
    } else {
      return erro(400, '22023', 'Unsupported conversation action');
    }
    anotarMudanca(workspaceId);
    return responder(res, 200, {
      id: conversa.id,
      stage: conversa.stage,
      assigned_user_id: conversa.assigned_user_id ?? null,
      assigned_label: conversa.assigned_label ?? null,
      automation_paused: conversa.automation_paused ?? false,
      unread_count: conversa.unread_count ?? 0,
      updated_at: new Date().toISOString(),
    });
  }

  return erro(404, 'PGRST202', `Função não imitada: ${nome}`);
}

/**
 * O que o servidor do painel faz, com a chave do servidor, quando chega um aviso da Evolution:
 * gravar a mensagem e, se ela trouxe um arquivo, reservar e anotar a busca dele.
 * (As regras de verdade estão em supabase/migrations e são testadas em supabase/tests/midia.test.ts.)
 */
function acoesDoServidor(res, nome, corpo) {
  if (nome === 'ingest_evolution_message') {
    const chip = tabelas.instances.find(
      (item) => item.provider_instance_name === corpo.p_instance_name && item.engine === 'evolution' && item.status !== 'revoked',
    );
    const segredo = SEGREDOS_DOS_AVISOS[corpo.p_instance_name];
    const resumoCerto = segredo ? crypto.createHash('sha256').update(segredo).digest('hex') : null;
    if (!chip || !resumoCerto || corpo.p_token_sha256 !== resumoCerto) return responder(res, 200, { result: 'unauthorized' });

    const marca = `${chip.id}:${corpo.p_event_id}`;
    if (avisosRecebidos.has(marca)) return responder(res, 200, { result: 'duplicate' });
    avisosRecebidos.add(marca);

    const texto = String(corpo.p_body_text ?? '').trim() || null;
    const midia = corpo.p_media && typeof corpo.p_media === 'object' && !Array.isArray(corpo.p_media) ? corpo.p_media : null;
    if (!/^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$/.test(String(corpo.p_sender_jid ?? '')) || (!texto && !midia)) {
      return responder(res, 200, { result: 'ignored' });
    }

    const workspaceId = chip.workspace_id;
    const deMim = corpo.p_from_me === true;
    const quando = corpo.p_occurred_at ?? new Date().toISOString();
    const agora = new Date().toISOString();

    let contato = tabelas.contacts.find(
      (item) => item.workspace_id === workspaceId && item.instance_id === chip.id && item.external_user_id === corpo.p_sender_jid && !item.erased_at,
    );
    if (!contato) {
      contato = {
        workspace_id: workspaceId,
        id: crypto.randomUUID(),
        instance_id: chip.id,
        display_name: deMim ? '' : String(corpo.p_push_name ?? '').trim().slice(0, 160),
        phone_e164: `+${String(corpo.p_sender_jid).split('@')[0]}`,
        external_user_id: corpo.p_sender_jid,
        erased_at: null,
        created_at: agora,
      };
      tabelas.contacts.push(contato);
    }
    let conversa = tabelas.conversations
      .filter((item) => item.workspace_id === workspaceId && item.contact_id === contato.id && item.instance_id === chip.id && ETAPAS_ABERTAS.includes(item.stage))
      .sort((a, b) => String(b.activity_at).localeCompare(String(a.activity_at)))[0];
    if (!conversa) {
      conversa = {
        workspace_id: workspaceId,
        id: crypto.randomUUID(),
        contact_id: contato.id,
        instance_id: chip.id,
        stage: deMim ? 'waiting_customer' : 'new',
        unread_count: 0,
        automation_paused: false,
        last_message_at: null,
        last_message_preview: null,
        activity_at: quando,
        created_at: agora,
      };
      tabelas.conversations.push(conversa);
    }

    const mensagemId = crypto.randomUUID();
    let ficha = null;
    if (midia) {
      const tipo = ['image', 'audio', 'video', 'document', 'sticker'].includes(midia.kind) ? midia.kind : 'document';
      const nomeDoArquivo = String(midia.file_name ?? '').trim().slice(0, 200) || null;
      const nomeSeguro =
        (nomeDoArquivo ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^[-._]+|[-._]+$/g, '')
          .slice(0, 100) || { image: 'foto', video: 'video', audio: 'audio', sticker: 'figurinha' }[tipo] || 'documento';
      const tamanho = Number.isInteger(midia.size) && midia.size >= 0 ? midia.size : 0;
      const inteiroEntre = (valor, minimo, maximo) => (Number.isInteger(valor) && valor >= minimo && valor <= maximo ? valor : null);
      ficha = {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        message_id: mensagemId,
        object_key: `${workspaceId}/${conversa.id}/${mensagemId}/${nomeSeguro}`,
        kind: tipo,
        content_type: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(String(midia.mime ?? '')) ? midia.mime : 'application/octet-stream',
        byte_size: tamanho,
        file_name: nomeDoArquivo,
        duration_seconds: inteiroEntre(midia.duration, 0, 86400),
        width: inteiroEntre(midia.width, 1, 20000),
        height: inteiroEntre(midia.height, 1, 20000),
        is_voice: midia.voice === true,
        storage_status: tamanho > 25 * MB ? 'too_large' : 'pending',
      };
      tabelas.message_attachments.push(ficha);
    }
    tabelas.messages.push({
      id: mensagemId,
      workspace_id: workspaceId,
      conversation_id: conversa.id,
      instance_id: chip.id,
      provider_message_id: corpo.p_event_id,
      idempotency_key: null,
      direction: deMim ? 'outbound' : 'inbound',
      source_engine: 'evolution',
      actor_type: deMim ? 'human' : 'contact',
      status: deMim ? 'sent' : 'received',
      body_text: texto,
      media_object_key: ficha?.object_key ?? null,
      occurred_at: quando,
      created_at: agora,
      sent_by: null,
    });

    const previa = previaDaMensagem(texto, anexoParaPrevia(ficha));
    if (deMim) {
      tocarConversaDepoisDoEnvio(conversa, previa, quando);
    } else {
      if (!conversa.last_message_at || quando >= conversa.last_message_at) conversa.last_message_preview = previa;
      if (!conversa.last_message_at || quando > conversa.last_message_at) conversa.last_message_at = quando;
      conversa.activity_at = conversa.last_message_at;
      conversa.unread_count = (conversa.unread_count ?? 0) + 1;
      if (conversa.stage === 'waiting_customer') conversa.stage = 'human';
    }
    anotarMudanca(workspaceId);
    return responder(res, 200, {
      result: 'accepted',
      workspace_id: workspaceId,
      instance_id: chip.id,
      contact_id: contato.id,
      conversation_id: conversa.id,
      message_id: mensagemId,
      direction: deMim ? 'outbound' : 'inbound',
      adopted: false,
      media: ficha ? { object_key: ficha.object_key, status: ficha.storage_status } : null,
    });
  }

  const ficha = tabelas.message_attachments.find((item) => item.workspace_id === corpo.p_workspace_id && item.message_id === corpo.p_message_id);

  if (nome === 'begin_media_download') {
    if (!ficha) return responder(res, 200, { claimed: false, reason: 'not_found' });
    if (!['pending', 'failed'].includes(ficha.storage_status)) return responder(res, 200, { claimed: false, reason: ficha.storage_status });
    const mensagem = tabelas.messages.find((item) => item.id === ficha.message_id);
    const conversa = tabelas.conversations.find((item) => item.id === mensagem?.conversation_id);
    const contato = tabelas.contacts.find((item) => item.id === conversa?.contact_id);
    const chip = tabelas.instances.find((item) => item.id === mensagem?.instance_id);
    if (!mensagem?.provider_message_id || !chip?.provider_instance_name || chip.engine !== 'evolution' || chip.status === 'revoked') {
      return responder(res, 200, { claimed: false, reason: 'unavailable' });
    }
    ficha.storage_status = 'pending';
    return responder(res, 200, {
      claimed: true,
      object_key: ficha.object_key,
      kind: ficha.kind,
      content_type: ficha.content_type,
      provider_instance_name: chip.provider_instance_name,
      provider_message_id: mensagem.provider_message_id,
      remote_jid: contato?.external_user_id ?? null,
      from_me: mensagem.direction === 'outbound',
    });
  }

  if (nome === 'complete_media_download') {
    if (!['stored', 'failed', 'too_large'].includes(corpo.p_outcome)) {
      return responder(res, 400, { code: '22023', details: null, hint: null, message: 'Invalid outcome' });
    }
    if (!ficha || !['pending', 'failed'].includes(ficha.storage_status)) return responder(res, 200, { changed: false });
    ficha.storage_status = corpo.p_outcome;
    if (corpo.p_outcome === 'stored') {
      if (corpo.p_content_type) ficha.content_type = String(corpo.p_content_type).toLowerCase();
      ficha.byte_size = corpo.p_byte_size;
    }
    // É isto que faz as telas abertas perceberem que o arquivo chegou (ou não).
    anotarMudanca(ficha.workspace_id);
    return responder(res, 200, { changed: true, status: ficha.storage_status });
  }

  return responder(res, 404, { code: 'PGRST202', details: null, hint: null, message: `Função não imitada: ${nome}` });
}

/* -------------------------------------------------------------------------- */
/* Depósito de arquivos (Supabase Storage)                                    */
/* -------------------------------------------------------------------------- */

/** O navegador fala direto com o depósito, a partir de outro endereço (o do painel). */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,PUT,POST,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '3600',
};
const NOME_DO_DEPOSITO = 'midias';
const LIMITE_DO_DEPOSITO = 25 * MB;

/** As respostas de erro têm o formato do depósito de verdade (sempre HTTP 400, com o código por dentro). */
const erroDoDeposito = (res, codigo, erro, mensagem) => responder(res, 400, { statusCode: String(codigo), error: erro, message: mensagem }, CORS);
const naoEncontradoNoDeposito = (res) => erroDoDeposito(res, 404, 'not_found', 'Object not found');

/** Quem pode ler: o servidor do painel, ou quem participa da empresa (a empresa é a primeira pasta do caminho). */
function podeLerNoDeposito(req, caminho) {
  if (ehOServidorDoPainel(req)) return true;
  const usuario = usuarioDaRequisicao(req);
  return Boolean(usuario && workspacesDoUsuario(usuario).includes(caminho.split('/')[0]));
}

/** Quem pode subir: o servidor do painel; ou a pessoa, só na pasta "envios" de uma conversa da própria empresa. */
function podeSubirNoDeposito(req, caminho) {
  if (ehOServidorDoPainel(req)) return true;
  const usuario = usuarioDaRequisicao(req);
  const [workspaceId, conversaId] = caminho.split('/');
  return Boolean(
    usuario &&
      CAMINHO_DE_ENVIO.test(caminho) &&
      workspacesDoUsuario(usuario).includes(workspaceId) &&
      tabelas.conversations.some((conversa) => conversa.workspace_id === workspaceId && conversa.id === conversaId),
  );
}

function assinar(caminho, uso) {
  const codigo = crypto.randomBytes(18).toString('hex');
  assinaturas.set(codigo, { caminho, uso });
  return codigo;
}

/** Entrega um arquivo, inteiro ou só o pedaço pedido (o tocador de áudio e vídeo do navegador pede pedaços). */
function entregarArquivo(req, res, arquivo, baixarComo) {
  const total = arquivo.dados.length;
  const cabecalhos = {
    ...CORS,
    'content-type': arquivo.conteudo,
    'accept-ranges': 'bytes',
    'cache-control': 'max-age=3600',
    ...(baixarComo ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(baixarComo)}` } : {}),
  };
  const faixa = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (faixa && (faixa[1] || faixa[2])) {
    const inicio = faixa[1] ? Number(faixa[1]) : Math.max(total - Number(faixa[2]), 0);
    const fim = faixa[1] && faixa[2] ? Math.min(Number(faixa[2]), total - 1) : total - 1;
    if (inicio > fim || inicio >= total) {
      res.writeHead(416, { ...cabecalhos, 'content-range': `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, { ...cabecalhos, 'content-range': `bytes ${inicio}-${fim}/${total}`, 'content-length': fim - inicio + 1 });
    return res.end(req.method === 'HEAD' ? undefined : arquivo.dados.subarray(inicio, fim + 1));
  }
  res.writeHead(200, { ...cabecalhos, 'content-length': total });
  return res.end(req.method === 'HEAD' ? undefined : arquivo.dados);
}

async function rotasDoDeposito(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const resto = decodeURIComponent(url.pathname.slice('/storage/v1/'.length));
  const depois = (prefixo) => (resto.startsWith(prefixo) ? resto.slice(prefixo.length) : null);
  const codigo = url.searchParams.get('token') ?? '';

  // Pedir um endereço de uso único para subir um arquivo.
  let caminho = depois(`object/upload/sign/${NOME_DO_DEPOSITO}/`);
  if (caminho !== null && req.method === 'POST') {
    if (!podeSubirNoDeposito(req, caminho)) return erroDoDeposito(res, 403, 'Unauthorized', 'new row violates row-level security policy');
    if (deposito.has(caminho)) return erroDoDeposito(res, 409, 'Duplicate', 'The resource already exists');
    const novo = assinar(caminho, 'subir');
    return responder(res, 200, { url: `/object/upload/sign/${NOME_DO_DEPOSITO}/${caminho}?token=${novo}`, token: novo }, CORS);
  }
  // Subir o arquivo nesse endereço (sem login: o que vale é o código do endereço).
  if (caminho !== null && req.method === 'PUT') {
    const { dados, tamanho } = await lerArquivo(req);
    if (subidasQueVaoFalhar > 0) {
      subidasQueVaoFalhar -= 1;
      return responder(res, 500, { statusCode: '500', error: 'Internal', message: 'falha simulada ao subir' }, CORS);
    }
    const assinatura = assinaturas.get(codigo);
    if (!assinatura || assinatura.uso !== 'subir' || assinatura.caminho !== caminho) return erroDoDeposito(res, 400, 'InvalidJWT', 'Invalid JWT');
    if (deposito.has(caminho)) return erroDoDeposito(res, 409, 'Duplicate', 'The resource already exists');
    if (tamanho > LIMITE_DO_DEPOSITO) return erroDoDeposito(res, 413, 'Payload too large', 'The object exceeded the maximum allowed size');
    deposito.set(caminho, { dados, conteudo: String(req.headers['content-type'] ?? 'application/octet-stream') });
    return responder(res, 200, { Key: `${NOME_DO_DEPOSITO}/${caminho}` }, CORS);
  }

  // Pedir um endereço de leitura que vale por pouco tempo.
  caminho = depois(`object/sign/${NOME_DO_DEPOSITO}/`);
  if (caminho !== null && req.method === 'POST') {
    if (!podeLerNoDeposito(req, caminho) || !deposito.has(caminho)) return naoEncontradoNoDeposito(res);
    return responder(res, 200, { signedURL: `/object/sign/${NOME_DO_DEPOSITO}/${caminho}?token=${assinar(caminho, 'ler')}` }, CORS);
  }
  // Ler nesse endereço (sem login).
  if (caminho !== null && (req.method === 'GET' || req.method === 'HEAD')) {
    const assinatura = assinaturas.get(codigo);
    const arquivo = deposito.get(caminho);
    if (!assinatura || assinatura.uso !== 'ler' || assinatura.caminho !== caminho) return erroDoDeposito(res, 400, 'InvalidJWT', 'Invalid JWT');
    if (!arquivo) return naoEncontradoNoDeposito(res);
    return entregarArquivo(req, res, arquivo, url.searchParams.get('download'));
  }

  // Apagar (só o servidor do painel).
  if (resto === `object/${NOME_DO_DEPOSITO}` && req.method === 'DELETE') {
    if (!ehOServidorDoPainel(req)) return erroDoDeposito(res, 403, 'Unauthorized', 'new row violates row-level security policy');
    const { prefixes: caminhos = [] } = await lerCorpo(req);
    const apagados = caminhos.filter((item) => deposito.delete(item));
    return responder(res, 200, apagados.map((item) => ({ name: item, bucket_id: NOME_DO_DEPOSITO })), CORS);
  }

  caminho = depois(`object/${NOME_DO_DEPOSITO}/`);
  // Ler com login (é como o servidor do painel lê o arquivo que vai enviar).
  if (caminho !== null && req.method === 'GET') {
    const arquivo = deposito.get(caminho);
    if (!podeLerNoDeposito(req, caminho) || !arquivo) return naoEncontradoNoDeposito(res);
    return entregarArquivo(req, res, arquivo, null);
  }
  // Guardar com login (é como o servidor do painel guarda o arquivo que buscou na Evolution).
  if (caminho !== null && req.method === 'POST') {
    const { dados, tamanho } = await lerArquivo(req);
    if (!podeSubirNoDeposito(req, caminho)) return erroDoDeposito(res, 403, 'Unauthorized', 'new row violates row-level security policy');
    if (deposito.has(caminho) && req.headers['x-upsert'] !== 'true') return erroDoDeposito(res, 409, 'Duplicate', 'The resource already exists');
    if (tamanho > LIMITE_DO_DEPOSITO) return erroDoDeposito(res, 413, 'Payload too large', 'The object exceeded the maximum allowed size');
    deposito.set(caminho, { dados, conteudo: String(req.headers['content-type'] ?? 'application/octet-stream') });
    return responder(res, 200, { Key: `${NOME_DO_DEPOSITO}/${caminho}`, Id: crypto.randomUUID() }, CORS);
  }

  return responder(res, 404, { message: `Rota do depósito não imitada: ${req.method} ${url.pathname}` }, CORS);
}

/** Só para os testes: põe as conversas da Empresa da Inbox de volta no começo. */
function reiniciarInbox() {
  const inbox = criarInbox();
  for (const tabela of ['instances', 'contacts', 'conversations', 'messages', 'message_attachments']) {
    tabelas[tabela] = [...tabelas[tabela].filter((linha) => linha.workspace_id !== WORKSPACE_INBOX), ...inbox[tabela]];
  }
  for (const caminho of [...deposito.keys()]) if (caminho.startsWith(`${WORKSPACE_INBOX}/`)) deposito.delete(caminho);
  for (const arquivo of inbox.arquivos) deposito.set(arquivo.caminho, { dados: arquivo.dados, conteudo: arquivo.conteudo });
  assinaturas.clear();
  avisosRecebidos.clear();
  subidasQueVaoFalhar = 0;
  pausasDaIa.delete(WORKSPACE_INBOX);
  anotarMudanca(WORKSPACE_INBOX);
}

/** Só para os testes: um cliente escreve numa conversa da Empresa da Inbox (como se o aviso da Evolution tivesse chegado). */
function receberMensagem(conversaId, texto) {
  const conversa = tabelas.conversations.find((item) => item.id === conversaId && item.workspace_id === WORKSPACE_INBOX);
  if (!conversa) return false;
  const agora = new Date().toISOString();
  tabelas.messages.push({
    id: crypto.randomUUID(),
    workspace_id: WORKSPACE_INBOX,
    conversation_id: conversa.id,
    instance_id: conversa.instance_id,
    provider_message_id: `WA-${crypto.randomUUID()}`,
    idempotency_key: null,
    direction: 'inbound',
    source_engine: 'evolution',
    actor_type: 'contact',
    status: 'received',
    body_text: texto,
    occurred_at: agora,
    created_at: agora,
    sent_by: null,
  });
  Object.assign(conversa, {
    last_message_at: agora,
    activity_at: agora,
    last_message_preview: texto.slice(0, 300),
    unread_count: (conversa.unread_count ?? 0) + 1,
    stage: conversa.stage === 'waiting_customer' ? 'human' : conversa.stage,
  });
  anotarMudanca(WORKSPACE_INBOX);
  return true;
}

/** O Motor de IA e o Treinamento (as regras estão em ia-no-banco-falso.mjs). */
const iaDoBanco = criarIaDoBanco({ tabelas, responder });

async function rotasDeDados(req, res, url) {
  const recurso = url.pathname.replace('/rest/v1/', '');

  // O servidor do painel, com a chave do servidor (não há pessoa logada: é o aviso da Evolution chegando).
  if (req.method === 'POST' && recurso.startsWith('rpc/') && FUNCOES_DO_SERVIDOR.includes(recurso.slice(4))) {
    if (!ehOServidorDoPainel(req)) return responder(res, 403, { code: '42501', details: null, hint: null, message: 'permission denied for function' });
    return acoesDoServidor(res, recurso.slice(4), await lerCorpo(req));
  }

  const usuario = usuarioDaRequisicao(req);
  if (!usuario) return naoAutorizado(res);
  const permitidos = workspacesDoUsuario(usuario);

  if (req.method === 'POST' && FUNCOES_DA_INBOX.includes(recurso.slice(4)) && recurso.startsWith('rpc/')) {
    return acoesDaInbox(res, usuario, recurso.slice(4), await lerCorpo(req));
  }

  if (req.method === 'POST' && recurso.startsWith('rpc/') && FUNCOES_DA_IA.includes(recurso.slice(4))) {
    return iaDoBanco.acoesDaIa(res, usuario, recurso.slice(4), await lerCorpo(req));
  }

  if (req.method === 'POST' && recurso.startsWith('rpc/') && FUNCOES_DO_ATENDENTE.includes(recurso.slice(4))) {
    return acoesDoAtendente(res, usuario, recurso.slice(4), await lerCorpo(req));
  }

  if (req.method === 'POST' && recurso.startsWith('rpc/') && recurso !== 'rpc/is_my_platform_master') {
    return acoesDosChips(res, usuario, recurso.slice(4), await lerCorpo(req));
  }

  if (req.method === 'POST' && recurso === 'rpc/is_my_platform_master') {
    return responder(res, 200, usuario.master === true);
  }

  if (recurso === 'workspace_memberships') {
    if (usuario.bancoFalha) return responder(res, 500, { message: 'falha simulada do banco' });
    const linhas = PARTICIPACOES.filter((p) => p.user_id === usuario.id && p.status === 'active').map((p) => ({
      role: p.role,
      workspaces: WORKSPACES.find((w) => w.id === p.workspace_id) ?? null,
    }));
    return responder(res, 200, linhas);
  }

  if (recurso === 'profiles') {
    const linhas = usuario.nome ? [{ display_name: usuario.nome }] : [];
    const querUmObjeto = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
    if (!querUmObjeto) return responder(res, 200, linhas);
    return linhas.length === 1
      ? responder(res, 200, linhas[0])
      : responder(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
  }

  const tabela = tabelas[recurso];
  if (!tabela) return responder(res, 404, { message: `Tabela não imitada: ${recurso}` });

  let linhas = tabela.filter((linha) => permitidos.includes(linha.workspace_id));
  try {
    for (const [coluna, expressao] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(coluna)) continue;
      linhas = linhas.filter((linha) => passaNoFiltro(linha, coluna, expressao));
    }
  } catch (erro) {
    return responder(res, 400, { message: erro.message });
  }

  const faixa = linhas.length === 0 ? `*/${linhas.length}` : `0-${linhas.length - 1}/${linhas.length}`;
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-range': faixa, 'content-type': 'application/json; charset=utf-8' });
    return res.end();
  }
  return responder(res, 200, linhas, { 'content-range': faixa });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (url.pathname === '/saude') return responder(res, 200, { ok: true });
    if (url.pathname === '/controle/reiniciar-chips') {
      // Só para os testes: apaga os chips de uma empresa, para cada teste começar do zero.
      const workspace = url.searchParams.get('workspace');
      tabelas.instances = tabelas.instances.filter((chip) => chip.workspace_id !== workspace);
      return responder(res, 200, { ok: true });
    }
    if (url.pathname === '/controle/reiniciar-inbox') {
      reiniciarInbox();
      return responder(res, 200, { ok: true });
    }
    if (url.pathname === '/controle/reiniciar-ia') {
      iaDoBanco.reiniciarIa();
      pausasDaIa.clear();
      return responder(res, 200, { ok: true });
    }
    if (url.pathname === '/controle/ia-na-conversa') {
      // Só para os testes: deixa a IA de uma conversa num estado (como o atendente deixaria).
      // ?conversa=...&estado=respondendo | repassada | sem_leitura | falhou | parada_por_pessoa | limpa
      const conversa = tabelas.conversations.find((item) => item.id === url.searchParams.get('conversa'));
      if (!conversa) return responder(res, 404, { ok: false });
      const estado = url.searchParams.get('estado');
      const daquiAUmaHora = new Date(Date.now() + UMA_HORA_EM_MS).toISOString();
      const limpa = { automation_paused: false, ai_paused_until: null, ai_pause_reason: null, ai_handoff_at: null, ai_handoff_note: null, ai_working: false, assigned_user_id: null };
      const estados = {
        limpa: {},
        respondendo: { stage: 'ai', unread_count: 0 },
        escrevendo: { stage: 'ai', ai_working: true },
        repassada: {
          stage: 'waiting_human',
          unread_count: Math.max(conversa.unread_count ?? 0, 1),
          ai_paused_until: daquiAUmaHora,
          ai_pause_reason: 'handoff',
          ai_handoff_at: new Date().toISOString(),
          ai_handoff_note: url.searchParams.get('recado') ?? 'Cenário: cliente novo | Gatilho: quer fechar o pedido | Próxima jogada: confirmar o endereço',
        },
        sem_leitura: {
          stage: 'waiting_human',
          unread_count: Math.max(conversa.unread_count ?? 0, 1),
          automation_paused: true,
          ai_pause_reason: 'silent_handoff',
          ai_handoff_at: new Date().toISOString(),
          ai_handoff_note: 'O contato mandou um áudio. A IA só escuta áudio pelo Google Gemini, que não está na ordem de uso do Motor de IA (ou está sem chave).',
        },
        falhou: {
          stage: 'waiting_human',
          unread_count: Math.max(conversa.unread_count ?? 0, 1),
          ai_paused_until: daquiAUmaHora,
          ai_pause_reason: 'error',
          ai_handoff_at: new Date().toISOString(),
          ai_handoff_note: 'O Google Gemini recusou a chave. Confira se ela foi copiada inteira e se continua ativa.',
        },
        parada_por_pessoa: { stage: 'waiting_customer', ai_paused_until: daquiAUmaHora, ai_pause_reason: 'human_reply' },
      };
      if (!estados[estado]) return responder(res, 400, { ok: false, erro: 'estado desconhecido' });
      Object.assign(conversa, limpa, estados[estado]);
      anotarMudanca(conversa.workspace_id);
      return responder(res, 200, { ok: true });
    }
    if (url.pathname === '/controle/mensagem-da-ia') {
      // Só para os testes: uma resposta da IA aparece numa conversa (como se o atendente tivesse acabado de enviar).
      const conversa = tabelas.conversations.find((item) => item.id === url.searchParams.get('conversa'));
      if (!conversa) return responder(res, 404, { ok: false });
      const texto = url.searchParams.get('texto') ?? 'Resposta da IA';
      const agora = new Date().toISOString();
      tabelas.messages.push({
        id: crypto.randomUUID(),
        workspace_id: conversa.workspace_id,
        conversation_id: conversa.id,
        instance_id: conversa.instance_id,
        provider_message_id: `WA-IA-${crypto.randomUUID()}`,
        idempotency_key: `ia-${crypto.randomUUID().replaceAll('-', '')}-1`,
        direction: 'outbound',
        source_engine: 'evolution',
        actor_type: 'ai',
        status: url.searchParams.get('situacao') ?? 'sent',
        body_text: texto,
        occurred_at: agora,
        created_at: agora,
        sent_by: null,
      });
      Object.assign(conversa, { last_message_at: agora, activity_at: agora, last_message_preview: texto.slice(0, 300) });
      anotarMudanca(conversa.workspace_id);
      return responder(res, 200, { ok: true });
    }
    if (url.pathname === '/controle/ia-do-chip') {
      // Só para os testes: liga ou desliga a IA de um chip sem passar pela tela.
      const chip = tabelas.instances.find((item) => item.id === url.searchParams.get('chip'));
      if (!chip) return responder(res, 404, { ok: false });
      chip.is_enabled = url.searchParams.get('ligada') === 'sim';
      anotarMudanca(chip.workspace_id);
      return responder(res, 200, { ok: true });
    }
    if (url.pathname === '/controle/receber-mensagem') {
      const ok = receberMensagem(url.searchParams.get('conversa'), url.searchParams.get('texto') ?? 'Mensagem de teste');
      return responder(res, ok ? 200 : 404, { ok });
    }
    if (url.pathname === '/controle/mensagens') {
      // Só para os testes: as mensagens de uma conversa, do jeito que estão guardadas.
      const conversa = url.searchParams.get('conversa');
      return responder(
        res,
        200,
        tabelas.messages
          .filter((mensagem) => mensagem.conversation_id === conversa)
          .map(({ id, body_text, status, direction, provider_message_id }) => {
            const ficha = fichaDoArquivo(id);
            return {
              body_text,
              status,
              direction,
              provider_message_id,
              arquivo: ficha
                ? { tipo: ficha.kind, situacao: ficha.storage_status, nome: ficha.file_name, conteudo: ficha.content_type, tamanho: ficha.byte_size, caminho: ficha.object_key, guardado: deposito.has(ficha.object_key) }
                : null,
            };
          }),
      );
    }
    if (url.pathname === '/controle/falha-ao-subir') {
      // Só para os testes: as próximas N subidas de arquivo falham.
      subidasQueVaoFalhar = Number(url.searchParams.get('vezes') ?? 1);
      return responder(res, 200, { ok: true });
    }
    if (url.pathname === '/controle/arquivos') {
      // Só para os testes: o que está guardado no depósito (dá para filtrar pelo começo do caminho).
      const prefixo = url.searchParams.get('prefixo') ?? '';
      return responder(
        res,
        200,
        [...deposito.entries()].filter(([caminho]) => caminho.startsWith(prefixo)).map(([caminho, arquivo]) => ({ caminho, tamanho: arquivo.dados.length, conteudo: arquivo.conteudo })),
      );
    }
    if (url.pathname.startsWith('/storage/v1/')) return await rotasDoDeposito(req, res, url);
    if (url.pathname.startsWith('/auth/v1/')) return await rotasDeLogin(req, res, url);
    if (url.pathname.startsWith('/rest/v1/')) return await rotasDeDados(req, res, url);
    return responder(res, 404, { message: `Rota não imitada: ${req.method} ${url.pathname}` });
  } catch (erro) {
    console.error('[supabase de mentira] erro:', erro);
    return responder(res, 500, { message: String(erro) });
  }
});

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log(`Supabase de mentira ouvindo em http://127.0.0.1:${PORTA}`);
});
