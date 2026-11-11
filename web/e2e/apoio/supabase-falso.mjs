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
 *
 * Ele respeita a regra mais importante do banco real: cada pessoa só enxerga as linhas
 * dos workspaces de que participa. As regras de verdade (RLS) são testadas à parte,
 * em supabase/tests, contra as migrações reais.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { PARTICIPACOES, SENHA_DE_TESTE, USUARIOS, WORKSPACES, WORKSPACE_INBOX, criarInbox, criarTabelas } from './dados.mjs';

const PORTA = Number(process.env.PORTA_SUPABASE_FALSO ?? 54399);
const SEGREDO_JWT = 'segredo-so-para-testes';
const UMA_HORA = 3600;

const tabelas = criarTabelas();
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

function usuarioDaRequisicao(req) {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const id = sessoes.get(token);
  return id ? USUARIOS.find((usuario) => usuario.id === id) : undefined;
}

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

const ETAPAS_ABERTAS = ['new', 'ai', 'waiting_human', 'human', 'waiting_customer'];
const ETAPAS_QUE_ESPERAM = ['new', 'waiting_human', 'human'];
const FUNCOES_DA_INBOX = [
  'read_my_inbox',
  'read_my_conversation',
  'read_my_inbox_version',
  'start_my_text_message',
  'finish_my_text_message',
  'transition_workspace_conversation',
];

const limitar = (valor, padrao, maximo) => Math.min(Math.max(Number.isInteger(valor) ? valor : padrao, 1), maximo);

/** Igual ao banco de verdade: atualiza a conversa depois de uma mensagem nossa. */
function tocarConversaDepoisDoEnvio(conversa, texto, quando) {
  if (!conversa.last_message_at || quando >= conversa.last_message_at) conversa.last_message_preview = texto.slice(0, 300);
  if (!conversa.last_message_at || quando > conversa.last_message_at) conversa.last_message_at = quando;
  conversa.activity_at = conversa.last_message_at;
  conversa.unread_count = 0;
  if (ETAPAS_QUE_ESPERAM.includes(conversa.stage)) conversa.stage = 'waiting_customer';
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
      },
      messages: mensagens
        .slice(0, limite)
        .reverse()
        .map((mensagem) => ({
          id: mensagem.id,
          direction: mensagem.direction,
          actor_type: mensagem.actor_type,
          status: mensagem.status,
          body_text: mensagem.body_text,
          occurred_at: mensagem.occurred_at,
          created_at: mensagem.created_at,
          from_panel: Boolean(mensagem.sent_by),
          mine: mensagem.sent_by === usuario.id,
          has_media: false,
        })),
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
    if (conversa && mensagem.status === 'sent') tocarConversaDepoisDoEnvio(conversa, mensagem.body_text, mensagem.occurred_at);
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
      Object.assign(conversa, { stage: 'human', automation_paused: true, assigned_user_id: usuario.id, assigned_label: 'Atendente' });
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

/** Só para os testes: põe as conversas da Empresa da Inbox de volta no começo. */
function reiniciarInbox() {
  const inbox = criarInbox();
  for (const tabela of ['instances', 'contacts', 'conversations', 'messages']) {
    tabelas[tabela] = [...tabelas[tabela].filter((linha) => linha.workspace_id !== WORKSPACE_INBOX), ...inbox[tabela]];
  }
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

async function rotasDeDados(req, res, url) {
  const usuario = usuarioDaRequisicao(req);
  if (!usuario) return naoAutorizado(res);
  const permitidos = workspacesDoUsuario(usuario);
  const recurso = url.pathname.replace('/rest/v1/', '');

  if (req.method === 'POST' && FUNCOES_DA_INBOX.includes(recurso.slice(4)) && recurso.startsWith('rpc/')) {
    return acoesDaInbox(res, usuario, recurso.slice(4), await lerCorpo(req));
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
        tabelas.messages.filter((mensagem) => mensagem.conversation_id === conversa).map(({ body_text, status, direction, provider_message_id }) => ({ body_text, status, direction, provider_message_id })),
      );
    }
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
