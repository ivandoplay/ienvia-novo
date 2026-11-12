/**
 * O atendente de IA no banco: quando a IA responde uma mensagem, a vez dela em cada conversa,
 * o envio da resposta, passar para uma pessoa, a pausa quando alguém responde, assumir e devolver,
 * Pausar tudo, ligar e desligar a IA em cada chip, e quem pode fazer o quê.
 *
 * O servidor do painel é quem conversa com o provedor de IA e com a Evolution; aqui se confere o que
 * o banco guarda e decide em cada passo.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import {
  ATENDENTE_A,
  CHIP_A,
  CHIP_B,
  CONTATO_A,
  CONVERSA_A,
  CONVERSA_B,
  DONA_A,
  DONO_B,
  INTRUSO,
  LOJA_A,
  LOJA_B,
  SUSPENSO_A,
  bancoComCenario,
} from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await bancoComCenario();
});

const RESUMO = 'a'.repeat(64);
const CHIP_NA_EVOLUTION = 'ienvia-atendente-0001';
const CLIENTE_A = '5586900000001@s.whatsapp.net';
const CIFRA = (letra: string) => `v1.${'i'.repeat(16)}.${'t'.repeat(22)}.${letra.repeat(24)}`;
const BASE_PADRAO = 'aaaaaaaa-1111-4111-8111-00000000b001';
const BASE_DO_CHIP = 'aaaaaaaa-1111-4111-8111-00000000b002';

type Json = Record<string, unknown>;

/** Sai do papel da pessoa e age como administrador do banco (é assim que o servidor é imitado dentro de um teste de pessoa). */
async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    // Se a chamada falhou, a transação fica parada até o teste voltar ao ponto de retorno (esperarErro),
    // e é essa volta que devolve o papel da pessoa; por isso uma falha aqui é ignorada.
    await banco.db.exec('set local role authenticated').catch(() => undefined);
  }
}
const agirComo = (usuario: string) => banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [usuario]);
const sql = (texto: string) => comoAdmin(() => banco.db.exec(texto));
async function ler<T = Json>(consulta: string, parametros: unknown[] = []): Promise<T[]> {
  return comoAdmin(async () => (await banco.db.query<T>(consulta, parametros)).rows);
}
async function chamar<T = Json>(funcao: string, parametros: unknown[]): Promise<T> {
  const marcas = parametros.map((_, indice) => `$${indice + 1}`).join(',');
  const { rows } = await banco.db.query<{ r: T }>(`select public.${funcao}(${marcas}) as r`, parametros);
  return rows[0]!.r;
}
/** O servidor do painel chamando uma função só dele. */
const servidor = <T = Json>(funcao: string, parametros: unknown[]) => comoAdmin(() => chamar<T>(funcao, parametros));

/**
 * Deixa a Loja A pronta para a IA responder: chip com nome na Evolution e segredo de aviso, chave do
 * provedor principal (Gemini, o padrão) e uma base de treinamento padrão. No cenário o chip já está
 * conectado e com a IA ligada.
 */
async function prepararIa(opcoes: { chave?: boolean; base?: boolean } = {}) {
  await sql(`
    update public.instances set provider_instance_name = '${CHIP_NA_EVOLUTION}' where id = '${CHIP_A}';
    insert into private.evolution_webhook_auth(workspace_id, instance_id, token_sha256) values ('${LOJA_A}', '${CHIP_A}', '${RESUMO}');
  `);
  if (opcoes.chave !== false) {
    await sql(`insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint) values ('${LOJA_A}', 'gemini', '${CIFRA('g')}', 'aB12')`);
  }
  if (opcoes.base !== false) {
    await sql(`
      insert into public.ai_agents(id, workspace_id, label, is_default, business_name, golden_rules)
        values ('${BASE_PADRAO}', '${LOJA_A}', 'Principal', true, 'Pizzaria da A', '- Seja breve.');
      insert into public.ai_agent_faqs(workspace_id, agent_id, position, question, answer)
        values ('${LOJA_A}', '${BASE_PADRAO}', 0, 'Entregam?', 'Sim, até as 23h.');
      insert into public.ai_agent_documents(workspace_id, agent_id, title, content)
        values ('${LOJA_A}', '${BASE_PADRAO}', 'cardapio.txt', 'Calabresa R$ 40');
    `);
  }
}

interface Recebido {
  result: string;
  conversation_id?: string;
  message_id?: string;
  adopted?: boolean;
  ai?: { scheduled: boolean; reason?: string; turn_id?: string; wait_ms?: number } | null;
  ai_stale?: boolean;
}

/** O servidor entrega um aviso de mensagem. `haMinutos` = há quanto tempo a mensagem foi escrita. */
const avisar = (id: string, texto: string, opcoes: { deMim?: boolean; contato?: string; haMinutos?: number } = {}) =>
  servidor<Recebido>('ingest_evolution_message', [
    CHIP_NA_EVOLUTION,
    RESUMO,
    id,
    'MESSAGES_UPSERT',
    opcoes.contato ?? CLIENTE_A,
    'Cliente da A',
    texto,
    new Date(Date.now() - (opcoes.haMinutos ?? 0) * 60_000).toISOString(),
    opcoes.deMim ?? false,
    null,
  ]);

interface Conversa {
  stage: string;
  unread_count: number;
  automation_paused: boolean;
  ai_pause_reason: string | null;
  ai_handoff_note: string | null;
  pausada_por_minutos: number | null;
  assigned_user_id: string | null;
}
async function conversa(id = CONVERSA_A): Promise<Conversa> {
  const linhas = await ler<Conversa>(
    `select stage, unread_count, automation_paused, ai_pause_reason, ai_handoff_note, assigned_user_id,
            round(extract(epoch from (ai_paused_until - clock_timestamp())) / 60)::int as pausada_por_minutos
       from public.conversations where id = $1`,
    [id],
  );
  return linhas[0]!;
}

interface Vez {
  id: string;
  status: string;
  outcome_detail: string | null;
  trigger_message_id: string;
  provider: string | null;
  model: string | null;
}
const vezes = (id = CONVERSA_A) =>
  ler<Vez>(
    'select id, status, outcome_detail, trigger_message_id, provider, model from public.ai_turns where conversation_id = $1 order by due_at, id',
    [id],
  );

/** O tempo passou: a espera de todas as vezes acabou há `segundos` segundos. */
const passarTempo = (segundos: number) => sql(`update public.ai_turns set due_at = clock_timestamp() - interval '${segundos} seconds' where status = 'waiting'`);

interface Pega {
  result: string;
  reason?: string;
  wait_ms?: number;
  status?: string;
  turn?: { id: string; conversation_id: string; trigger_message_id: string };
  settings?: Json;
  keys?: Record<string, string>;
  agent?: (Json & { faqs: Json[]; documents: Json[] }) | null;
  conversation?: Json;
  messages?: Array<{ direction: string; actor_type: string; status: string; body_text: string | null }>;
}
const pegar = (vez: string, gatilho: string | null, empresa = LOJA_A) => servidor<Pega>('claim_ai_turn', [empresa, vez, gatilho]);

interface Comeco {
  result: string;
  message_id?: string;
  reason?: string;
  status?: string;
  provider_instance_name?: string;
  recipient?: string;
  next?: { turn_id: string; trigger_message_id: string; wait_ms: number } | null;
}
const comecarParte = (vez: string, parte: number, texto: string) => servidor<Comeco>('start_ai_message', [LOJA_A, vez, parte, texto]);
const terminarParte = (mensagem: string, desfecho: string, idNoWhatsapp: string | null = null) =>
  servidor<{ status: string; changed: boolean }>('finish_ai_message', [LOJA_A, mensagem, desfecho, idNoWhatsapp]);
const fecharVez = (vez: string, desfecho: string, extras: { detalhe?: string; recado?: string; trava?: boolean; meta?: Json } = {}) =>
  servidor<{ result: string; status?: string }>('finish_ai_turn', [
    LOJA_A,
    vez,
    desfecho,
    extras.detalhe ?? null,
    extras.recado ?? null,
    extras.trava ?? false,
    extras.meta ?? {},
  ]);

/** Uma mensagem do cliente chega, a espera acaba e o servidor pega a vez. */
async function vezEmAndamento(id: string, texto = 'Vocês entregam?') {
  const recebido = await avisar(id, texto);
  expect(recebido.ai).toMatchObject({ scheduled: true });
  await passarTempo(1);
  const pega = await pegar(recebido.ai!.turn_id!, recebido.message_id!);
  expect(pega.result).toBe('claimed');
  return { vez: recebido.ai!.turn_id!, mensagem: recebido.message_id!, pega };
}

const acao = (nome: string, id = CONVERSA_A, empresa = LOJA_A) => chamar('transition_workspace_conversation', [empresa, id, nome]);

async function responderPeloPainel(texto: string, chave: string, desfecho = 'sent') {
  const inicio = await chamar<{ message_id: string }>('start_my_text_message', [LOJA_A, CONVERSA_A, texto, chave]);
  await chamar('finish_my_text_message', [LOJA_A, inicio.message_id, desfecho, desfecho === 'sent' ? `WA-${chave}` : null]);
  return inicio.message_id;
}

const auditoria = (acaoRegistrada: string) =>
  ler<{ actor_kind: string; actor_user_id: string | null; target_id: string }>(
    'select actor_kind, actor_user_id, target_id from private.audit_events where workspace_id = $1 and action = $2 order by id',
    [LOJA_A, acaoRegistrada],
  );

describe('chegou uma mensagem do cliente: a IA responde?', () => {
  test('com a IA ligada no chip, a mensagem entra na vez da IA e a conversa fica "Com a IA"', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Vocês entregam?');
      expect(recebido).toMatchObject({ result: 'accepted', ai: { scheduled: true, wait_ms: 6000 }, ai_stale: false });
      expect(await vezes()).toEqual([
        { id: recebido.ai!.turn_id, status: 'waiting', outcome_detail: null, trigger_message_id: recebido.message_id, provider: null, model: null },
      ]);
      expect(await conversa()).toMatchObject({ stage: 'ai', unread_count: 3 });
    });
  });

  test('o cliente continua escrevendo: é a mesma vez, e a espera recomeça a partir da última mensagem', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`insert into public.workspace_ai_settings(workspace_id, debounce_seconds) values ('${LOJA_A}', 15)`);
      const primeira = await avisar('WA-IN-1', 'Oi');
      await sql(`update public.ai_turns set due_at = clock_timestamp() + interval '2 seconds'`);
      const segunda = await avisar('WA-IN-2', 'Vocês entregam?');
      expect(segunda.ai).toMatchObject({ scheduled: true, turn_id: primeira.ai!.turn_id, wait_ms: 15000 });
      const [vez] = await vezes();
      expect(vez).toMatchObject({ status: 'waiting', trigger_message_id: segunda.message_id });
      const [espera] = await ler<{ falta: number }>('select round(extract(epoch from (due_at - clock_timestamp())))::int as falta from public.ai_turns');
      expect(espera!.falta).toBeGreaterThanOrEqual(14);
    });
  });

  test.each([
    ['a IA está desligada neste chip', `update public.instances set is_enabled = false where id = '${CHIP_A}'`, 'chip_ai_off'],
    ['a IA da empresa está pausada', `insert into public.workspace_ai_state(workspace_id, paused, paused_at) values ('${LOJA_A}', true, now())`, 'workspace_paused'],
    ['o chip não está conectado', `update public.instances set status = 'disconnected' where id = '${CHIP_A}'`, 'chip_not_connected'],
    ['alguém assumiu a conversa', `update public.conversations set automation_paused = true where id = '${CONVERSA_A}'`, 'conversation_paused'],
    ['a IA está pausada nesta conversa por mais um tempo', `update public.conversations set ai_paused_until = now() + interval '10 minutes' where id = '${CONVERSA_A}'`, 'conversation_paused'],
  ])('quando %s, a mensagem fica para uma pessoa', async (_caso, preparo, motivo) => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(preparo);
      const recebido = await avisar('WA-IN-1', 'Oi');
      expect(recebido).toMatchObject({ result: 'accepted', ai: { scheduled: false, reason: motivo } });
      expect(await vezes()).toEqual([]);
      // A conversa continua onde estava (no cenário: esperando uma pessoa), com a mensagem nova contada.
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', unread_count: 3 });
    });
  });

  test('pausa vencida não segura mais nada: a IA volta a responder sozinha', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`update public.conversations set ai_paused_until = now() - interval '1 minute', ai_pause_reason = 'human_reply' where id = '${CONVERSA_A}'`);
      expect((await avisar('WA-IN-1', 'Oi')).ai).toMatchObject({ scheduled: true });
    });
  });

  test('a conversa estava com a IA e ela não pode mais responder: passa a esperar uma pessoa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const primeira = await avisar('WA-IN-1', 'Oi');
      expect(await conversa()).toMatchObject({ stage: 'ai' });
      await sql(`update public.instances set is_enabled = false where id = '${CHIP_A}'`);
      const segunda = await avisar('WA-IN-2', 'Tem alguém aí?');
      expect(segunda.ai).toEqual({ scheduled: false, reason: 'chip_ai_off' });
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', unread_count: 4 });
      expect(await vezes()).toMatchObject([{ id: primeira.ai!.turn_id, status: 'skipped', outcome_detail: 'chip_ai_off' }]);
    });
  });

  test('mensagem antiga que só chegou agora (o chip ficou sem sinal) não é respondida pela IA', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      expect((await avisar('WA-IN-1', 'Oi', { haMinutos: 30 })).ai).toEqual({ scheduled: false, reason: 'old_message' });
      expect((await avisar('WA-IN-2', 'Oi de novo', { haMinutos: 2 })).ai).toMatchObject({ scheduled: true });
    });
  });

  test('um chip da própria empresa escrevendo para outro não é respondido (dois robôs conversariam sem parar)', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      // O outro chip da empresa é o número do contato, com o nono dígito (o WhatsApp entrega sem).
      await sql(`
        insert into public.instances(workspace_id, channel, engine, display_name, status, connected_phone)
          values ('${LOJA_A}', 'whatsapp', 'evolution', 'Segundo chip', 'connected', '+5586988887777');
      `);
      expect((await avisar('WA-IN-1', 'Oi', { contato: '558688887777@s.whatsapp.net' })).ai).toEqual({ scheduled: false, reason: 'own_chip' });
      expect((await avisar('WA-IN-2', 'Oi', { contato: '5586988887777@s.whatsapp.net' })).ai).toEqual({ scheduled: false, reason: 'own_chip' });
      expect((await avisar('WA-IN-3', 'Oi', { contato: '5586977776666@s.whatsapp.net' })).ai).toMatchObject({ scheduled: true });
    });
  });

  test('conversa resolvida: o cliente volta, nasce uma conversa nova e ela já fica com a IA', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await acao('resolve');
      const recebido = await avisar('WA-IN-1', 'Voltei!');
      expect(recebido.conversation_id).not.toBe(CONVERSA_A);
      expect(recebido.ai).toMatchObject({ scheduled: true });
      expect(await conversa(recebido.conversation_id)).toMatchObject({ stage: 'ai', unread_count: 1, automation_paused: false });
    });
  });

  test('mensagem repetida da Evolution não marca a vez duas vezes', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await avisar('WA-IN-1', 'Oi');
      expect(await avisar('WA-IN-1', 'Oi')).toMatchObject({ result: 'duplicate' });
      expect(await vezes()).toHaveLength(1);
    });
  });
});

describe('pegar a vez', () => {
  test('antes de a espera acabar, o banco diz quanto falta; depois, entrega tudo de que o servidor precisa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`insert into public.workspace_ai_settings(workspace_id, provider, fallback_provider, nvidia_model) values ('${LOJA_A}', 'gemini', 'nvidia', 'meta/llama-4')`);
      await sql(`insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint) values ('${LOJA_A}', 'nvidia', '${CIFRA('n')}', 'zz99')`);
      const recebido = await avisar('WA-IN-1', 'Vocês entregam?');
      const vez = recebido.ai!.turn_id!;

      const cedo = await pegar(vez, recebido.message_id!);
      expect(cedo.result).toBe('early');
      expect(cedo.wait_ms).toBeGreaterThan(4000);
      expect((await vezes())[0]).toMatchObject({ status: 'waiting' });

      await passarTempo(1);
      const pega = await pegar(vez, recebido.message_id!);
      expect(pega).toMatchObject({
        result: 'claimed',
        turn: { id: vez, conversation_id: CONVERSA_A, trigger_message_id: recebido.message_id },
        settings: { provider: 'gemini', fallback_provider: 'nvidia', nvidia_model: 'meta/llama-4', debounce_seconds: 6 },
        keys: { gemini: CIFRA('g'), nvidia: CIFRA('n') },
        conversation: { id: CONVERSA_A, contact_name: 'Cliente da A', recipient: CLIENTE_A, provider_instance_name: CHIP_NA_EVOLUTION },
      });
      expect(pega.agent).toMatchObject({ id: BASE_PADRAO, business_name: 'Pizzaria da A', golden_rules: '- Seja breve.' });
      expect(pega.agent!.faqs).toMatchObject([{ question: 'Entregam?', answer: 'Sim, até as 23h.' }]);
      // O conteúdo dos arquivos de conhecimento vem junto: a IA precisa dele para responder.
      expect(pega.agent!.documents).toMatchObject([{ title: 'cardapio.txt', content: 'Calabresa R$ 40' }]);
      expect(pega.messages!.map((mensagem) => [mensagem.direction, mensagem.body_text])).toEqual([
        ['inbound', 'Oi, tem pizza?'],
        ['inbound', 'Vocês entregam?'],
      ]);
      expect((await vezes())[0]).toMatchObject({ status: 'running' });

      // A vez é de um pedido só.
      expect(await pegar(vez, recebido.message_id!)).toEqual({ result: 'gone', status: 'running' });
    });
  });

  test('chegou mensagem mais nova: o pedido da mensagem antiga para, e o da nova pega a vez', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const primeira = await avisar('WA-IN-1', 'Oi');
      const segunda = await avisar('WA-IN-2', 'Tem pizza doce?');
      await passarTempo(1);
      expect(await pegar(primeira.ai!.turn_id!, primeira.message_id!)).toEqual({ result: 'superseded' });
      expect((await pegar(segunda.ai!.turn_id!, segunda.message_id!)).result).toBe('claimed');
    });
  });

  test('o chip usa a base de treinamento dele quando tem uma; sem base nenhuma, a vez vem sem treinamento', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`
        insert into public.ai_agents(id, workspace_id, label, business_name) values ('${BASE_DO_CHIP}', '${LOJA_A}', 'Chip 2', 'Filial');
        update public.instances set ai_agent_id = '${BASE_DO_CHIP}' where id = '${CHIP_A}';
      `);
      const { pega } = await vezEmAndamento('WA-IN-1');
      expect(pega.agent).toMatchObject({ id: BASE_DO_CHIP, business_name: 'Filial' });
    });
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa({ base: false });
      const { pega } = await vezEmAndamento('WA-IN-1');
      expect(pega.agent).toBeNull();
    });
  });

  test('a IA relê só as últimas mensagens, e nunca as que com certeza não saíram', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`insert into public.workspace_ai_settings(workspace_id, max_history_messages) values ('${LOJA_A}', 4)`);
      await sql(`
        insert into public.messages(workspace_id, conversation_id, instance_id, direction, source_engine, actor_type, status, body_text, occurred_at) values
          ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'outbound', 'evolution', 'human', 'sent', 'Temos sim!', now() + interval '1 second'),
          ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'outbound', 'evolution', 'human', 'failed', 'Esta não saiu', now() + interval '2 seconds'),
          ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'inbound', 'evolution', 'contact', 'received', 'Qual o sabor?', now() + interval '3 seconds'),
          ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'outbound', 'evolution', 'ai', 'awaiting_human_confirmation', 'Calabresa.', now() + interval '4 seconds');
      `);
      const recebido = await servidor<Recebido>('ingest_evolution_message', [
        CHIP_NA_EVOLUTION, RESUMO, 'WA-IN-9', 'MESSAGES_UPSERT', CLIENTE_A, 'Cliente da A', 'E o preço?', new Date(Date.now() + 5000).toISOString(), false, null,
      ]);
      await passarTempo(1);
      const pega = await pegar(recebido.ai!.turn_id!, recebido.message_id!);
      expect(pega.messages!.map((mensagem) => `${mensagem.actor_type}: ${mensagem.body_text}`)).toEqual([
        'human: Temos sim!',
        'contact: Qual o sabor?',
        'ai: Calabresa.',
        'contact: E o preço?',
      ]);
    });
  });

  test('a IA foi desligada no chip durante a espera: a vez é abandonada e a conversa espera uma pessoa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Oi');
      await sql(`update public.instances set is_enabled = false where id = '${CHIP_A}'`);
      await passarTempo(1);
      expect(await pegar(recebido.ai!.turn_id!, recebido.message_id!)).toEqual({ result: 'skipped', reason: 'chip_ai_off' });
      expect(await vezes()).toMatchObject([{ status: 'skipped', outcome_detail: 'chip_ai_off' }]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_human' });
    });
  });

  test('enquanto uma resposta desta conversa ainda está sendo enviada, a próxima vez espera', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await vezEmAndamento('WA-IN-1');
      const segunda = await avisar('WA-IN-2', 'E a entrega?');
      await passarTempo(1);
      expect(await pegar(segunda.ai!.turn_id!, segunda.message_id!)).toEqual({ result: 'busy' });
    });
  });

  test('limite de segurança: depois de 6 respostas em um minuto, a IA para e uma pessoa é chamada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      for (let numero = 1; numero <= 6; numero += 1) {
        const { vez } = await vezEmAndamento(`WA-IN-${numero}`, `mensagem ${numero}`);
        expect(await fecharVez(vez, 'answered')).toMatchObject({ result: 'finished' });
      }
      const setima = await avisar('WA-IN-7', 'mensagem 7');
      await passarTempo(1);
      expect(await pegar(setima.ai!.turn_id!, setima.message_id!)).toEqual({ result: 'handed_off', reason: 'rate_limit' });
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'safety', pausada_por_minutos: 60 });
      expect((await conversa()).ai_handoff_note).toMatch(/muitas vezes em pouco tempo/);
      expect(await auditoria('ai_safety_stop')).toMatchObject([{ actor_kind: 'service', actor_user_id: null, target_id: CONVERSA_A }]);
      // Com a pausa de segurança, a próxima mensagem já nem entra na vez da IA.
      expect((await avisar('WA-IN-8', 'mensagem 8')).ai).toEqual({ scheduled: false, reason: 'conversation_paused' });
    });
  });

  test('vez de outra empresa ou que não existe: nada acontece', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Oi');
      await passarTempo(1);
      expect(await pegar(recebido.ai!.turn_id!, recebido.message_id!, LOJA_B)).toEqual({ result: 'gone' });
      expect(await pegar('99999999-9999-4999-8999-999999999999', null)).toEqual({ result: 'gone' });
      expect((await vezes())[0]).toMatchObject({ status: 'waiting' });
    });
  });
});

describe('enviar a resposta da IA', () => {
  test('a parte nasce "enviando" como mensagem da IA; quando sai, a conversa fica com a IA e sem pendência', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const inicio = await comecarParte(vez, 1, '  Entregamos sim, até as 23h!  ');
      expect(inicio).toMatchObject({ result: 'started', provider_instance_name: CHIP_NA_EVOLUTION, recipient: CLIENTE_A });
      const [mensagem] = await ler('select status, actor_type, direction, body_text, sent_by, idempotency_key from public.messages where id = $1', [inicio.message_id]);
      expect(mensagem).toEqual({
        status: 'sending',
        actor_type: 'ai',
        direction: 'outbound',
        body_text: 'Entregamos sim, até as 23h!',
        sent_by: null,
        idempotency_key: `ia-${vez.replaceAll('-', '')}-1`,
      });

      // Pedido repetido da mesma parte devolve a mesma mensagem: nunca envia duas vezes.
      expect(await comecarParte(vez, 1, 'outro texto')).toEqual({ result: 'already_exists', message_id: inicio.message_id, status: 'sending' });

      expect(await terminarParte(inicio.message_id!, 'sent', 'WA-OUT-1')).toMatchObject({ status: 'sent', changed: true });
      expect(await conversa()).toMatchObject({ stage: 'ai', unread_count: 0, automation_paused: false, ai_pause_reason: null });
      expect(await fecharVez(vez, 'answered', { meta: { provider: 'gemini', model: 'gemini-3.5-flash-lite', duration_ms: 812, tokens_in: 900, tokens_out: 21, attempts: [] } })).toEqual({
        result: 'finished',
        status: 'answered',
      });
      expect(await vezes()).toMatchObject([{ status: 'answered', provider: 'gemini', model: 'gemini-3.5-flash-lite' }]);
      // Resposta comum não enche a auditoria.
      expect(await auditoria('ai_answered')).toEqual([]);
    });
  });

  test('o eco da resposta da IA confirma a mesma mensagem e não conta como "uma pessoa respondeu"', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const inicio = await comecarParte(vez, 1, 'Entregamos sim!');
      // O aviso da Evolution chega antes de o servidor contar que enviou.
      expect(await avisar('WA-OUT-1', 'Entregamos sim!', { deMim: true })).toMatchObject({ result: 'accepted', adopted: true, message_id: inicio.message_id });
      expect(await conversa()).toMatchObject({ stage: 'ai', unread_count: 0, pausada_por_minutos: null, ai_pause_reason: null });
      expect(await terminarParte(inicio.message_id!, 'sent', 'WA-OUT-1')).toMatchObject({ status: 'sent' });
      expect(await ler("select count(*)::int as n from public.messages where conversation_id = $1 and direction = 'outbound'", [CONVERSA_A])).toEqual([{ n: 1 }]);
      // A IA continua valendo para a próxima mensagem.
      await fecharVez(vez, 'answered');
      expect((await avisar('WA-IN-2', 'Obrigado')).ai).toMatchObject({ scheduled: true });
    });
  });

  test('eco que chega com o texto diferente enquanto a IA envia: não pausa a IA, e a cópia some quando o envio é confirmado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const inicio = await comecarParte(vez, 1, 'Entregamos sim!');
      expect(await avisar('WA-OUT-1', 'Entregamos  sim!', { deMim: true })).toMatchObject({ result: 'accepted', adopted: false });
      expect(await conversa()).toMatchObject({ pausada_por_minutos: null, ai_pause_reason: null });
      await terminarParte(inicio.message_id!, 'sent', 'WA-OUT-1');
      expect(await ler("select actor_type, status from public.messages where conversation_id = $1 and direction = 'outbound'", [CONVERSA_A])).toEqual([
        { actor_type: 'ai', status: 'sent' },
      ]);
      expect(await conversa()).toMatchObject({ stage: 'ai' });
    });
  });

  test('não deu para saber se saiu: a mensagem fica "sem confirmação" e a vez passa para uma pessoa, sem reenviar', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const inicio = await comecarParte(vez, 1, 'Entregamos sim!');
      expect(await terminarParte(inicio.message_id!, 'uncertain')).toMatchObject({ status: 'awaiting_human_confirmation', changed: true });
      expect(await auditoria('message_send_uncertain')).toMatchObject([{ actor_kind: 'service', actor_user_id: null }]);
      await fecharVez(vez, 'uncertain_send', { recado: 'Não deu para confirmar se a resposta da IA chegou.' });
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', unread_count: 3, ai_pause_reason: 'uncertain_send', pausada_por_minutos: 60 });
      // Uma pessoa confere no WhatsApp e marca; a função das pessoas serve para a mensagem da IA também.
      expect(await chamar('finish_my_text_message', [LOJA_A, inicio.message_id, 'sent', null])).toMatchObject({ status: 'sent', changed: true });
      // O motivo do repasse acabou: a conversa volta para a IA, sem pendência e sem pausa.
      expect(await conversa()).toMatchObject({ stage: 'ai', unread_count: 0, ai_pause_reason: null, ai_handoff_note: null, pausada_por_minutos: null });
      expect((await avisar('WA-IN-2', 'Obrigado!')).ai).toMatchObject({ scheduled: true });
    });
  });

  test('envio incerto: se o cliente escreveu depois, confirmar o envio libera a IA mas a conversa segue esperando uma pessoa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const inicio = await comecarParte(vez, 1, 'Entregamos sim!');
      await terminarParte(inicio.message_id!, 'uncertain');
      await fecharVez(vez, 'uncertain_send', { recado: 'Não deu para confirmar se a resposta da IA chegou.' });
      expect((await avisar('WA-IN-2', 'Alô?')).ai).toEqual({ scheduled: false, reason: 'conversation_paused' });

      await chamar('finish_my_text_message', [LOJA_A, inicio.message_id, 'sent', null]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', unread_count: 4, ai_pause_reason: null, pausada_por_minutos: null });
    });
  });

  test('envio incerto: marcar que NÃO foi enviada mantém a conversa com a pessoa; o eco da Evolution, sozinho, também não tira', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const inicio = await comecarParte(vez, 1, 'Entregamos sim!');
      await terminarParte(inicio.message_id!, 'uncertain');
      await fecharVez(vez, 'uncertain_send', { recado: 'Não deu para confirmar se a resposta da IA chegou.' });
      await chamar('finish_my_text_message', [LOJA_A, inicio.message_id, 'failed', null]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'uncertain_send', pausada_por_minutos: 60 });
    });
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const inicio = await comecarParte(vez, 1, 'Entregamos sim!');
      await terminarParte(inicio.message_id!, 'uncertain');
      await fecharVez(vez, 'uncertain_send', { recado: 'Não deu para confirmar se a resposta da IA chegou.' });
      // O aviso da Evolution chega atrasado e confirma a mensagem; a conversa continua à vista de uma pessoa.
      expect(await avisar('WA-OUT-1', 'Entregamos sim!', { deMim: true })).toMatchObject({ adopted: true });
      expect(await ler('select status from public.messages where id = $1', [inicio.message_id])).toEqual([{ status: 'sent' }]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', unread_count: 3, ai_pause_reason: 'uncertain_send', pausada_por_minutos: 60 });
    });
  });

  test('uma pessoa responde depois de a IA passar a conversa: o recado da IA sai', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      await fecharVez(vez, 'handoff', { recado: 'Pediu o responsável' });
      await responderPeloPainel('Sou eu, pode falar.', 'chave-de-envio-0010');
      expect(await conversa()).toMatchObject({ stage: 'waiting_customer', ai_pause_reason: 'human_reply', ai_handoff_note: null, pausada_por_minutos: 60 });
    });
    // Com a opção de pausar desligada, a pausa do repasse também sai: a IA volta na próxima mensagem.
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`insert into public.workspace_ai_settings(workspace_id, pause_on_human_reply) values ('${LOJA_A}', false)`);
      const { vez } = await vezEmAndamento('WA-IN-1');
      await fecharVez(vez, 'handoff', { recado: 'Pediu o responsável' });
      await responderPeloPainel('Sou eu, pode falar.', 'chave-de-envio-0011');
      expect(await conversa()).toMatchObject({ ai_pause_reason: null, ai_handoff_note: null, pausada_por_minutos: null, automation_paused: false });
      expect((await avisar('WA-IN-2', 'Ok!')).ai).toMatchObject({ scheduled: true });
    });
    // Quem assumiu a conversa e responde continua com ela assumida.
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await acao('claim');
      await responderPeloPainel('Oi!', 'chave-de-envio-0012');
      expect(await conversa()).toMatchObject({ automation_paused: true, ai_pause_reason: 'claimed' });
    });
  });

  test.each([
    ['uma pessoa assumiu a conversa', async () => void (await acao('claim')), 'conversation_paused', 'human'],
    ['a IA da empresa foi pausada', async () => void (await chamar('pause_my_ai', [LOJA_A])), 'workspace_paused', 'waiting_human'],
    ['a IA foi desligada no chip', async () => void (await chamar('set_my_instance_ai', [LOJA_A, CHIP_A, false])), 'chip_ai_off', 'waiting_human'],
  ])('a resposta já estava pronta, mas %s: nada é enviado', async (_caso, mudar, motivo, etapa) => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      await mudar();
      expect(await comecarParte(vez, 1, 'Entregamos sim!')).toEqual({ result: 'aborted', reason: motivo, next: null });
      expect(await ler("select count(*)::int as n from public.messages where conversation_id = $1 and actor_type = 'ai'", [CONVERSA_A])).toEqual([{ n: 0 }]);
      expect(await vezes()).toMatchObject([{ status: 'skipped', outcome_detail: motivo }]);
      expect(await conversa()).toMatchObject({ stage: etapa });
      // A vez já está fechada: o servidor não consegue fechar de novo de outro jeito.
      expect(await fecharVez(vez, 'answered')).toEqual({ result: 'ignored', status: 'skipped' });
    });
  });

  test('uma pessoa está enviando uma resposta neste instante: a IA não envia por cima', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      await chamar('start_my_text_message', [LOJA_A, CONVERSA_A, 'Deixa que eu respondo', 'chave-de-envio-0001']);
      expect(await comecarParte(vez, 1, 'Entregamos sim!')).toEqual({ result: 'aborted', reason: 'human_replying', next: null });
    });
  });

  test('o cliente escreveu de novo enquanto a IA preparava a resposta: ela é abandonada e a vez nova responde tudo', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1', 'Vocês entregam?');
      const nova = await avisar('WA-IN-2', 'No bairro Centro');
      expect(nova.ai).toMatchObject({ scheduled: true });
      expect(nova.ai!.turn_id).not.toBe(vez);

      const inicio = await comecarParte(vez, 1, 'Entregamos sim!');
      expect(inicio).toMatchObject({ result: 'aborted', reason: 'superseded', next: { turn_id: nova.ai!.turn_id, trigger_message_id: nova.message_id } });
      expect(inicio.next!.wait_ms).toBeGreaterThan(4000);
      expect(await vezes()).toMatchObject([
        { id: vez, status: 'skipped', outcome_detail: 'superseded' },
        { id: nova.ai!.turn_id, status: 'waiting' },
      ]);
      expect(await conversa()).toMatchObject({ stage: 'ai' });

      await passarTempo(1);
      const pega = await pegar(nova.ai!.turn_id!, nova.message_id!);
      expect(pega.result).toBe('claimed');
      expect(pega.messages!.map((mensagem) => mensagem.body_text)).toEqual(['Oi, tem pizza?', 'Vocês entregam?', 'No bairro Centro']);
    });
  });

  test('resposta em partes: se uma pessoa assume no meio, as partes que faltam não saem', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const primeira = await comecarParte(vez, 1, 'Entregamos sim!');
      await terminarParte(primeira.message_id!, 'sent', 'WA-OUT-1');
      // Mensagem nova do cliente no meio de uma resposta em partes NÃO abandona as partes seguintes.
      await avisar('WA-IN-2', 'Legal');
      const segunda = await comecarParte(vez, 2, 'A taxa é R$ 5.');
      expect(segunda.result).toBe('started');
      await terminarParte(segunda.message_id!, 'sent', 'WA-OUT-2');

      await acao('claim');
      expect(await comecarParte(vez, 3, 'Quer pedir?')).toEqual({ result: 'aborted', reason: 'conversation_paused', next: null });
      expect((await vezes())[0]).toMatchObject({ status: 'answered', outcome_detail: 'stopped_after_part_2:conversation_paused' });
    });
  });

  test('texto vazio, grande demais ou parte fora do combinado: recusado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      expect(await banco.esperarErro(() => comecarParte(vez, 1, '   '))).toMatch(/Invalid message text/);
      expect(await banco.esperarErro(() => comecarParte(vez, 1, 'x'.repeat(4097)))).toMatch(/Invalid message text/);
      expect(await banco.esperarErro(() => comecarParte(vez, 0, 'Oi'))).toMatch(/Invalid part/);
      expect(await banco.esperarErro(() => comecarParte(vez, 6, 'Oi'))).toMatch(/Invalid part/);
      expect(await banco.esperarErro(() => terminarParte('99999999-9999-4999-8999-999999999999', 'sent'))).toMatch(/Message not found/);
    });
  });

  test('a função de terminar envio da IA não mexe em mensagem de pessoa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const inicio = await chamar<{ message_id: string }>('start_my_text_message', [LOJA_A, CONVERSA_A, 'Oi', 'chave-de-envio-0002']);
      expect(await banco.esperarErro(() => terminarParte(inicio.message_id, 'sent'))).toMatch(/Message not found/);
    });
  });
});

describe('fechar a vez', () => {
  test('a IA entendeu que não havia o que responder: a conversa fica com ela, sem pendência', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1', 'ok, obrigado');
      expect(await fecharVez(vez, 'silent')).toEqual({ result: 'finished', status: 'silent' });
      expect(await conversa()).toMatchObject({ stage: 'ai', unread_count: 0, automation_paused: false });
    });
  });

  test('a IA pede uma pessoa: a conversa vai para "Esperando você" com o recado, e a IA volta sozinha depois da pausa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`insert into public.workspace_ai_settings(workspace_id, human_pause_minutes) values ('${LOJA_A}', 30)`);
      const { vez } = await vezEmAndamento('WA-IN-1', 'Quero fechar o pedido');
      const parte = await comecarParte(vez, 1, 'Um minutinho, já te atendo!');
      await terminarParte(parte.message_id!, 'sent', 'WA-OUT-1');
      const recado = 'Cenário: cliente novo | Gatilho: quer fechar pedido | Próxima jogada: confirmar endereço';
      expect(await fecharVez(vez, 'handoff', { recado, detalhe: 'pediu para fechar' })).toEqual({ result: 'finished', status: 'handed_off' });
      expect(await conversa()).toMatchObject({
        stage: 'waiting_human',
        unread_count: 1,
        automation_paused: false,
        ai_pause_reason: 'handoff',
        ai_handoff_note: recado,
        pausada_por_minutos: 30,
      });
      expect(await auditoria('ai_handoff')).toMatchObject([{ actor_kind: 'service', target_id: CONVERSA_A }]);
      expect((await avisar('WA-IN-2', 'Oi?')).ai).toEqual({ scheduled: false, reason: 'conversation_paused' });
    });
  });

  test('com a trava pedida, ou quando a IA não entendeu a mensagem, ela só volta quando alguém devolver a conversa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      await fecharVez(vez, 'handoff', { recado: 'Pediu o responsável', trava: true });
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', automation_paused: true, pausada_por_minutos: null, ai_pause_reason: 'handoff' });
    });
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1', '???');
      await fecharVez(vez, 'silent_handoff', { recado: 'Não entendi a mensagem' });
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', automation_paused: true, ai_pause_reason: 'silent_handoff', ai_handoff_note: 'Não entendi a mensagem' });
    });
  });

  test('a IA não conseguiu responder: a conversa vai para uma pessoa com a explicação', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      const tentativas = [{ provider: 'gemini', model: 'gemini-3.5-flash-lite', error: 'chave_vazada' }];
      expect(await fecharVez(vez, 'failed', { recado: 'A IA não respondeu: o Google bloqueou a chave.', detalhe: 'chave_vazada', meta: { attempts: tentativas } })).toEqual({
        result: 'finished',
        status: 'failed',
      });
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'error', pausada_por_minutos: 60 });
      expect(await ler('select attempts, outcome_detail from public.ai_turns where id = $1', [vez])).toEqual([{ attempts: tentativas, outcome_detail: 'chave_vazada' }]);
      expect(await auditoria('ai_failed')).toHaveLength(1);
    });
  });

  test('despedida depois de uma recusa: a conversa é encerrada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1', 'Não tenho interesse');
      expect(await fecharVez(vez, 'closed', { recado: 'Recusa cordial' })).toEqual({ result: 'finished', status: 'closed' });
      expect(await conversa()).toMatchObject({ stage: 'resolved', unread_count: 0, automation_paused: true, ai_pause_reason: 'closed' });
      expect(await ler('select consent_status from public.contacts where id = $1', [CONTATO_A])).toEqual([{ consent_status: 'unknown' }]);
    });
  });

  test('o contato pediu para parar: a conversa é encerrada e fica registrado que ele não quer mais mensagens', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez, mensagem } = await vezEmAndamento('WA-IN-1', 'Pare de me mandar mensagem');
      await fecharVez(vez, 'opt_out', { recado: 'Pediu para não receber mais mensagens' });
      expect(await conversa()).toMatchObject({ stage: 'resolved', automation_paused: true, ai_pause_reason: 'opt_out' });
      expect(await ler('select consent_status from public.contacts where id = $1', [CONTATO_A])).toEqual([{ consent_status: 'opted_out' }]);
      expect(await ler('select purpose, action, source, evidence_reference, recorded_by from public.contact_consent_events where contact_id = $1', [CONTATO_A])).toEqual([
        { purpose: 'global', action: 'opted_out', source: 'ai_attendant', evidence_reference: `message:${mensagem}`, recorded_by: null },
      ]);
      expect(await ler('select status from public.contact_consent_state where contact_id = $1', [CONTATO_A])).toEqual([{ status: 'opted_out' }]);
    });
  });

  test('fechar duas vezes não muda nada; desfecho desconhecido é recusado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      await fecharVez(vez, 'answered');
      expect(await fecharVez(vez, 'handoff', { recado: 'tarde demais' })).toEqual({ result: 'ignored', status: 'answered' });
      expect(await conversa()).toMatchObject({ ai_handoff_note: null });
      expect(await banco.esperarErro(() => fecharVez(vez, 'inventado'))).toMatch(/Invalid outcome/);
      expect(await banco.esperarErro(() => fecharVez('99999999-9999-4999-8999-999999999999', 'answered'))).toMatch(/Turn not found/);
    });
  });
});

describe('uma pessoa responde: a IA para naquela conversa', () => {
  test('resposta pelo painel desfaz a vez que esperava e pausa a IA pelo tempo configurado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Vocês entregam?');
      await responderPeloPainel('Entregamos sim!', 'chave-de-envio-0003');
      expect(await vezes()).toMatchObject([{ id: recebido.ai!.turn_id, status: 'skipped', outcome_detail: 'human_replied' }]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_customer', unread_count: 0, automation_paused: false, ai_pause_reason: 'human_reply', pausada_por_minutos: 60 });

      const depois = await avisar('WA-IN-2', 'Obrigado');
      expect(depois.ai).toEqual({ scheduled: false, reason: 'conversation_paused' });
      expect(await conversa()).toMatchObject({ stage: 'human', unread_count: 1 });
    });
  });

  test('mesmo quando a mensagem da pessoa não sai, a IA para: alguém está cuidando', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await avisar('WA-IN-1', 'Oi');
      await responderPeloPainel('Oi!', 'chave-de-envio-0004', 'failed');
      expect(await conversa()).toMatchObject({ ai_pause_reason: 'human_reply', pausada_por_minutos: 60 });
      expect((await vezes())[0]).toMatchObject({ status: 'skipped', outcome_detail: 'human_replied' });
    });
  });

  test('com a opção desligada no Motor de IA, a IA não é pausada (mas não responde por cima da pessoa)', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`insert into public.workspace_ai_settings(workspace_id, pause_on_human_reply) values ('${LOJA_A}', false)`);
      await avisar('WA-IN-1', 'Oi');
      await responderPeloPainel('Oi!', 'chave-de-envio-0005');
      expect((await vezes())[0]).toMatchObject({ status: 'skipped', outcome_detail: 'human_replied' });
      expect(await conversa()).toMatchObject({ stage: 'waiting_customer', ai_pause_reason: null, pausada_por_minutos: null });
      expect((await avisar('WA-IN-2', 'Tem pizza doce?')).ai).toMatchObject({ scheduled: true });
      expect(await conversa()).toMatchObject({ stage: 'ai' });
    });
  });

  test('com a trava permanente no treinamento, a IA só volta quando alguém devolver a conversa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`update public.ai_agents set lock_until_manual_resume = true where id = '${BASE_PADRAO}'`);
      await responderPeloPainel('Oi!', 'chave-de-envio-0006');
      expect(await conversa()).toMatchObject({ automation_paused: true, ai_pause_reason: 'human_reply', pausada_por_minutos: null });
    });
  });

  test('resposta digitada direto no celular do chip vale igual', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Vocês entregam?');
      expect(await avisar('WA-CEL-1', 'Entregamos!', { deMim: true })).toMatchObject({ result: 'accepted', adopted: false });
      expect(await vezes()).toMatchObject([{ id: recebido.ai!.turn_id, status: 'skipped', outcome_detail: 'human_replied' }]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_customer', ai_pause_reason: 'human_reply', pausada_por_minutos: 60 });
    });
  });

  test('mensagem antiga do celular que só chegou agora não desfaz a vez de uma mensagem nova nem pausa a IA', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Vocês entregam?');
      await avisar('WA-CEL-1', 'Resposta de ontem', { deMim: true, haMinutos: 600 });
      expect(await vezes()).toMatchObject([{ id: recebido.ai!.turn_id, status: 'waiting' }]);
      expect(await conversa()).toMatchObject({ ai_pause_reason: null, pausada_por_minutos: null });
    });
  });
});

describe('assumir a conversa e devolver para a IA', () => {
  test('assumir tira a conversa da IA; devolver põe de volta, a partir da próxima mensagem do cliente', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Oi');
      await acao('claim');
      expect(await conversa()).toMatchObject({ stage: 'human', automation_paused: true, ai_pause_reason: 'claimed', assigned_user_id: ATENDENTE_A });
      expect(await vezes()).toMatchObject([{ id: recebido.ai!.turn_id, status: 'skipped', outcome_detail: 'claimed' }]);
      expect((await avisar('WA-IN-2', 'Alô?')).ai).toEqual({ scheduled: false, reason: 'conversation_paused' });

      await acao('release');
      expect(await conversa()).toMatchObject({ stage: 'human', automation_paused: false, ai_pause_reason: null, ai_handoff_note: null, assigned_user_id: null, pausada_por_minutos: null });
      expect(await ler("select action, actor_kind from private.audit_events where workspace_id = $1 and action = 'conversation_released'", [LOJA_A])).toEqual([
        { action: 'conversation_released', actor_kind: 'operator' },
      ]);
      expect((await avisar('WA-IN-3', 'Tem pizza?')).ai).toMatchObject({ scheduled: true });
      expect(await conversa()).toMatchObject({ stage: 'ai' });
    });
  });

  test('devolver também desfaz a pausa com hora marcada e apaga o recado da IA', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const { vez } = await vezEmAndamento('WA-IN-1');
      await fecharVez(vez, 'handoff', { recado: 'Pediu o responsável' });
      await acao('release');
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', automation_paused: false, ai_pause_reason: null, ai_handoff_note: null, pausada_por_minutos: null });
    });
  });

  test('resolver desfaz a vez que esperava; conversa resolvida não é devolvida para a IA', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await avisar('WA-IN-1', 'Oi');
      await acao('resolve');
      expect((await vezes())[0]).toMatchObject({ status: 'skipped', outcome_detail: 'resolved' });
      expect(await banco.esperarErro(() => acao('release'))).toMatch(/Conversation is not active/);
    });
  });

  test('quem não é da empresa não devolve conversa de ninguém', async () => {
    for (const pessoa of [INTRUSO, SUSPENSO_A, DONO_B]) {
      await banco.comoUsuario(pessoa, async () => {
        expect(await banco.esperarErro(() => acao('release'))).toMatch(/Workspace membership required/);
      });
    }
    await banco.comoAnonimo(async () => {
      expect(await banco.esperarErro(() => acao('release'))).toMatch(/permission denied|Authentication required/);
    });
  });
});

describe('Pausar tudo', () => {
  test('qualquer pessoa da empresa pausa; as conversas que a IA ia responder passam a esperar uma pessoa', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Oi');
      const versaoAntes = await chamar<string>('read_my_inbox_version', [LOJA_A]);

      expect(await chamar('pause_my_ai', [LOJA_A])).toEqual({ paused: true, changed: true });
      expect(await vezes()).toMatchObject([{ id: recebido.ai!.turn_id, status: 'skipped', outcome_detail: 'workspace_paused' }]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', unread_count: 3 });
      expect(await ler('select paused, paused_by from public.workspace_ai_state where workspace_id = $1', [LOJA_A])).toEqual([{ paused: true, paused_by: ATENDENTE_A }]);
      expect(await auditoria('ai_paused_all')).toMatchObject([{ actor_kind: 'operator', actor_user_id: ATENDENTE_A }]);
      // As telas abertas percebem a mudança.
      expect(await chamar<string>('read_my_inbox_version', [LOJA_A])).not.toBe(versaoAntes);

      // Pausar de novo não muda nada nem registra de novo.
      expect(await chamar('pause_my_ai', [LOJA_A])).toEqual({ paused: true, changed: false });
      expect(await auditoria('ai_paused_all')).toHaveLength(1);
      expect((await avisar('WA-IN-2', 'Oi?')).ai).toEqual({ scheduled: false, reason: 'workspace_paused' });

      // Retomar é só com o dono.
      expect(await banco.esperarErro(() => chamar('resume_my_ai', [LOJA_A]))).toMatch(/Workspace owner required/);
      await agirComo(DONA_A);
      expect(await chamar('resume_my_ai', [LOJA_A])).toEqual({ paused: false, changed: true });
      expect(await chamar('resume_my_ai', [LOJA_A])).toEqual({ paused: false, changed: false });
      expect(await ler('select paused, resumed_by from public.workspace_ai_state where workspace_id = $1', [LOJA_A])).toEqual([{ paused: false, resumed_by: DONA_A }]);
      expect(await auditoria('ai_resumed_all')).toMatchObject([{ actor_kind: 'owner', actor_user_id: DONA_A }]);
      expect((await avisar('WA-IN-3', 'Voltou?')).ai).toMatchObject({ scheduled: true });
    });
  });

  test('pausar uma empresa não pausa a outra; quem é de fora não pausa nem retoma ninguém', async () => {
    await banco.comoUsuario(DONO_B, async () => {
      await chamar('pause_my_ai', [LOJA_B]);
      expect(await ler('select workspace_id from public.workspace_ai_state where paused')).toEqual([{ workspace_id: LOJA_B }]);
      expect(await banco.esperarErro(() => chamar('pause_my_ai', [LOJA_A]))).toMatch(/Workspace membership required/);
      expect(await banco.esperarErro(() => chamar('resume_my_ai', [LOJA_A]))).toMatch(/Workspace owner required/);
    });
    for (const pessoa of [INTRUSO, SUSPENSO_A]) {
      await banco.comoUsuario(pessoa, async () => {
        expect(await banco.esperarErro(() => chamar('pause_my_ai', [LOJA_A]))).toMatch(/Workspace membership required/);
      });
    }
    await banco.comoAnonimo(async () => {
      expect(await banco.esperarErro(() => chamar('pause_my_ai', [LOJA_A]))).toMatch(/permission denied|Authentication required/);
    });
  });
});

describe('ligar e desligar a IA em cada chip', () => {
  test('só o dono liga; para ligar é preciso a chave do provedor principal e uma base de treinamento', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa({ chave: false, base: false });
      await sql(`update public.instances set is_enabled = false where id = '${CHIP_A}'`);
      const ligar = () => chamar('set_my_instance_ai', [LOJA_A, CHIP_A, true]);

      expect(await banco.esperarErro(ligar)).toMatch(/ai_key_missing/);
      // Chave de um provedor que não é o principal não conta.
      await sql(`insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint) values ('${LOJA_A}', 'nvidia', '${CIFRA('n')}', 'zz99')`);
      expect(await banco.esperarErro(ligar)).toMatch(/ai_key_missing/);
      await sql(`insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint) values ('${LOJA_A}', 'gemini', '${CIFRA('g')}', 'aB12')`);
      expect(await banco.esperarErro(ligar)).toMatch(/ai_training_missing/);
      await sql(`insert into public.ai_agents(id, workspace_id, label, is_default) values ('${BASE_PADRAO}', '${LOJA_A}', 'Principal', true)`);

      expect(await ligar()).toEqual({ id: CHIP_A, is_enabled: true, changed: true });
      expect(await ligar()).toEqual({ id: CHIP_A, is_enabled: true, changed: false });
      expect(await auditoria('instance_ai_enabled')).toMatchObject([{ actor_kind: 'owner', actor_user_id: DONA_A, target_id: CHIP_A }]);

      await agirComo(ATENDENTE_A);
      expect(await banco.esperarErro(() => chamar('set_my_instance_ai', [LOJA_A, CHIP_A, false]))).toMatch(/Workspace owner required/);
      await agirComo(DONO_B);
      expect(await banco.esperarErro(() => chamar('set_my_instance_ai', [LOJA_A, CHIP_A, false]))).toMatch(/Workspace owner required/);
      expect(await ler('select is_enabled from public.instances where id = $1', [CHIP_A])).toEqual([{ is_enabled: true }]);
    });
  });

  test('desligar a IA no chip passa para uma pessoa as conversas que ela ia responder agora', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Oi');
      expect(await chamar('set_my_instance_ai', [LOJA_A, CHIP_A, false])).toEqual({ id: CHIP_A, is_enabled: false, changed: true });
      expect(await vezes()).toMatchObject([{ id: recebido.ai!.turn_id, status: 'skipped', outcome_detail: 'chip_ai_off' }]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_human' });
      expect(await auditoria('instance_ai_disabled')).toHaveLength(1);
    });
  });

  test('chip removido, de outra empresa ou de um motor que a IA ainda não usa: recusado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      expect(await banco.esperarErro(() => chamar('set_my_instance_ai', [LOJA_A, CHIP_B, true]))).toMatch(/Instance not found/);
      await sql(`update public.instances set status = 'revoked', is_enabled = false where id = '${CHIP_A}'`);
      expect(await banco.esperarErro(() => chamar('set_my_instance_ai', [LOJA_A, CHIP_A, true]))).toMatch(/Instance not found/);
      expect(await banco.esperarErro(() => chamar('set_my_instance_ai', [LOJA_A, CHIP_A, null]))).toMatch(/Invalid value/);
    });
    await banco.comoUsuario(DONO_B, async () => {
      // O chip da Loja B é do motor local (baileys), que a IA só vai usar na Fase 4.
      expect(await banco.esperarErro(() => chamar('set_my_instance_ai', [LOJA_B, CHIP_B, true]))).toMatch(/instance_unavailable/);
    });
  });

  test('o resumo da IA diz o que falta, quantos chips estão ligados e quem pode o quê', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa({ chave: false, base: false });
      expect(await chamar('read_my_ai_overview', [LOJA_A])).toEqual({
        paused: false,
        paused_at: null,
        can_resume: true,
        can_switch_chips: true,
        missing: 'ai_key_missing',
        chips_enabled: 1,
        chips_answering: 1,
      });
      await sql(`insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint) values ('${LOJA_A}', 'gemini', '${CIFRA('g')}', 'aB12')`);
      expect(await chamar('read_my_ai_overview', [LOJA_A])).toMatchObject({ missing: 'ai_training_missing' });
      await sql(`insert into public.ai_agents(id, workspace_id, label, is_default) values ('${BASE_PADRAO}', '${LOJA_A}', 'Principal', true)`);
      await sql(`update public.instances set status = 'disconnected' where id = '${CHIP_A}'`);
      await chamar('pause_my_ai', [LOJA_A]);

      await agirComo(ATENDENTE_A);
      const resumo = await chamar<Json>('read_my_ai_overview', [LOJA_A]);
      expect(resumo).toMatchObject({ paused: true, can_resume: false, can_switch_chips: false, missing: null, chips_enabled: 1, chips_answering: 0 });
      expect(resumo.paused_at).toBeTruthy();

      await agirComo(INTRUSO);
      expect(await banco.esperarErro(() => chamar('read_my_ai_overview', [LOJA_A]))).toMatch(/Workspace membership required/);
    });
  });
});

describe('o que ficou para trás', () => {
  test('resposta interrompida no meio e vez que esperou demais vão para uma pessoa; vez sem dono é entregue para responder', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      // Três contatos: uma resposta interrompida, uma vez esquecida há muito tempo e uma esquecida há pouco.
      const { vez: interrompida } = await vezEmAndamento('WA-IN-1');
      const velha = await avisar('WA-IN-2', 'Oi', { contato: '5586900000022@s.whatsapp.net' });
      const recente = await avisar('WA-IN-3', 'Oi', { contato: '5586900000033@s.whatsapp.net' });
      await sql(`
        update public.ai_turns set claimed_at = clock_timestamp() - interval '4 minutes' where id = '${interrompida}';
        update public.ai_turns set due_at = clock_timestamp() - interval '11 minutes' where id = '${velha.ai!.turn_id}';
        update public.ai_turns set due_at = clock_timestamp() - interval '30 seconds' where id = '${recente.ai!.turn_id}';
      `);

      // O próximo aviso da empresa percebe que há algo para trás.
      const aviso = await avisar('WA-IN-4', 'Oi', { contato: '5586900000044@s.whatsapp.net' });
      expect(aviso.ai_stale).toBe(true);

      const varredura = await servidor<{ reaped: number; orphans: Array<{ turn_id: string; trigger_message_id: string }> }>('sweep_ai_turns', [LOJA_A]);
      expect(varredura.reaped).toBe(2);
      expect(varredura.orphans).toEqual([{ turn_id: recente.ai!.turn_id, trigger_message_id: recente.message_id }]);

      expect(await vezes()).toMatchObject([{ id: interrompida, status: 'failed', outcome_detail: 'interrupted' }]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'error' });
      expect((await conversa()).ai_handoff_note).toMatch(/interrompida no meio de uma resposta/);
      expect(await vezes(velha.conversation_id)).toMatchObject([{ status: 'skipped', outcome_detail: 'expired' }]);
      expect((await conversa(velha.conversation_id)).ai_handoff_note).toMatch(/não respondeu esta conversa a tempo/);
      expect(await conversa(recente.conversation_id)).toMatchObject({ stage: 'ai' });
      expect(await auditoria('ai_turn_abandoned')).toHaveLength(2);

      // A vez sem dono ainda pode ser pega (sem dizer de qual mensagem veio o pedido).
      expect((await pegar(recente.ai!.turn_id!, null)).result).toBe('claimed');
      expect((await servidor<{ reaped: number; orphans: unknown[] }>('sweep_ai_turns', [LOJA_A])).orphans).toEqual([]);
    });
  });

  test('abrir o painel já arruma o que ficou para trás, mesmo sem aviso novo da Evolution', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararIa();
      const recebido = await avisar('WA-IN-1', 'Vocês entregam?');
      // O servidor caiu antes de responder, e ninguém mais escreveu para a empresa.
      await sql(`update public.ai_turns set due_at = clock_timestamp() - interval '6 minutes'`);
      expect(await conversa()).toMatchObject({ stage: 'ai' });

      // Qualquer pessoa da equipe abre qualquer tela do painel (toda tela pede o resumo da IA).
      await chamar('read_my_ai_overview', [LOJA_A]);
      expect(await vezes()).toMatchObject([{ id: recebido.ai!.turn_id, status: 'skipped', outcome_detail: 'expired' }]);
      expect(await conversa()).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'error', ai_handoff_note: 'A IA não respondeu esta conversa a tempo.' });

      // Uma vez que ainda está dentro do prazo não é mexida.
      const outra = await avisar('WA-IN-2', 'Oi', { contato: '5586900000055@s.whatsapp.net' });
      await sql(`update public.ai_turns set due_at = clock_timestamp() - interval '2 minutes' where id = '${outra.ai!.turn_id}'`);
      await chamar('read_my_ai_overview', [LOJA_A]);
      expect(await vezes(outra.conversation_id)).toMatchObject([{ status: 'waiting' }]);
    });
  });

  test('sem nada para trás, o aviso diz isso e a varredura não mexe em nada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      expect((await avisar('WA-IN-1', 'Oi')).ai_stale).toBe(false);
      expect(await servidor('sweep_ai_turns', [LOJA_A])).toEqual({ reaped: 0, orphans: [] });
    });
  });
});

describe('ler a conversa: como a IA está nela', () => {
  const lerIa = async () => {
    const lida = await chamar<{ conversation: { ai: Json } }>('read_my_conversation', [LOJA_A, CONVERSA_A, 50]);
    return lida.conversation.ai;
  };

  test('do começo ao repasse', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararIa();
      expect(await lerIa()).toEqual({
        chip_enabled: true,
        workspace_paused: false,
        locked: false,
        paused_until: null,
        pause_reason: null,
        handoff_at: null,
        handoff_note: null,
        working: false,
      });

      const { vez } = await vezEmAndamento('WA-IN-1');
      expect(await lerIa()).toMatchObject({ working: true, locked: false });

      await fecharVez(vez, 'handoff', { recado: 'Quer falar com o responsável' });
      const repassada = await lerIa();
      expect(repassada).toMatchObject({ working: false, locked: false, pause_reason: 'handoff', handoff_note: 'Quer falar com o responsável' });
      expect(repassada.paused_until).toBeTruthy();
      expect(repassada.handoff_at).toBeTruthy();

      await acao('claim');
      expect(await lerIa()).toMatchObject({ locked: true, paused_until: null, pause_reason: 'claimed' });
      await chamar('pause_my_ai', [LOJA_A]);
      expect(await lerIa()).toMatchObject({ workspace_paused: true });
    });
  });

  test('pausa vencida não aparece mais como pausa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await sql(`update public.conversations set ai_paused_until = now() - interval '1 minute', ai_pause_reason = 'human_reply' where id = '${CONVERSA_A}'`);
      // O motivo continua guardado (explica o que houve); o que deixa de valer é a pausa.
      expect(await lerIa()).toMatchObject({ paused_until: null, pause_reason: 'human_reply', locked: false });
      // Na próxima resposta da IA, o que restava da pausa antiga sai.
      const { vez } = await vezEmAndamento('WA-IN-1');
      const parte = await comecarParte(vez, 1, 'Oi!');
      await terminarParte(parte.message_id!, 'sent', 'WA-OUT-1');
      expect(await lerIa()).toMatchObject({ paused_until: null, pause_reason: null, locked: false });
    });
  });
});

describe('quem pode o quê', () => {
  const SO_DO_SERVIDOR: Array<[string, unknown[]]> = [
    ['claim_ai_turn', [LOJA_A, '99999999-9999-4999-8999-999999999999', null]],
    ['start_ai_message', [LOJA_A, '99999999-9999-4999-8999-999999999999', 1, 'Oi']],
    ['finish_ai_message', [LOJA_A, '99999999-9999-4999-8999-999999999999', 'sent', null]],
    ['finish_ai_turn', [LOJA_A, '99999999-9999-4999-8999-999999999999', 'answered', null, null, false, {}]],
    ['sweep_ai_turns', [LOJA_A]],
    ['read_ai_attachment', [LOJA_A, '99999999-9999-4999-8999-999999999999']],
  ];

  test('as funções do servidor não aceitam chamada de pessoa nem de visitante', async () => {
    for (const pessoa of [DONA_A, ATENDENTE_A, INTRUSO]) {
      await banco.comoUsuario(pessoa, async () => {
        for (const [funcao, parametros] of SO_DO_SERVIDOR) {
          expect(await banco.esperarErro(() => chamar(funcao, parametros)), funcao).toMatch(/permission denied for function/);
        }
      });
    }
    await banco.comoAnonimo(async () => {
      for (const [funcao, parametros] of SO_DO_SERVIDOR) {
        expect(await banco.esperarErro(() => chamar(funcao, parametros)), funcao).toMatch(/permission denied for function/);
      }
    });
  });

  test('o servidor (service_role) chama as funções dele', async () => {
    await banco.comoServico(async () => {
      expect(await chamar('claim_ai_turn', [LOJA_A, '99999999-9999-4999-8999-999999999999', null])).toEqual({ result: 'gone' });
      expect(await chamar('sweep_ai_turns', [LOJA_A])).toEqual({ reaped: 0, orphans: [] });
      expect(await chamar('read_ai_attachment', [LOJA_A, '99999999-9999-4999-8999-999999999999'])).toBeNull();
    });
  });

  test('as peças internas não são chamadas por ninguém de fora', async () => {
    const internas = [
      `select private.schedule_ai_turn('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', gen_random_uuid(), now())`,
      `select private.note_human_reply('${LOJA_A}', '${CONVERSA_A}', now())`,
      `select private.hand_conversation_to_human('${LOJA_A}', '${CONVERSA_A}', 'handoff', 'x', false)`,
      `select private.cancel_waiting_ai_turn('${LOJA_A}', '${CONVERSA_A}', 'x')`,
      `select private.reap_ai_turns('${LOJA_A}', null)`,
      `select private.ai_block_reason('${LOJA_A}', '${CONVERSA_A}')`,
      `select private.ai_missing_setup('${LOJA_A}', null)`,
      `select private.finish_outbound_message('${LOJA_A}', gen_random_uuid(), 'sent', null, null, 'service')`,
      `select private.touch_conversation_after_ai_reply('${LOJA_A}', '${CONVERSA_A}', 'x', now())`,
    ];
    await banco.comoUsuario(DONA_A, async () => {
      for (const consulta of internas) {
        expect(await banco.esperarErro(() => banco.db.query(consulta)), consulta).toMatch(/permission denied/);
      }
    });
  });

  test('a equipe lê as vezes da IA e a pausa da própria empresa, e só; ninguém grava direto', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararIa();
      await avisar('WA-IN-1', 'Oi');
      await sql(`insert into public.workspace_ai_state(workspace_id, paused) values ('${LOJA_A}', false), ('${LOJA_B}', true)`);
      expect((await banco.db.query('select status from public.ai_turns')).rows).toEqual([{ status: 'waiting' }]);
      expect((await banco.db.query('select workspace_id from public.workspace_ai_state')).rows).toEqual([{ workspace_id: LOJA_A }]);

      for (const consulta of [
        `update public.ai_turns set status = 'answered'`,
        `delete from public.ai_turns`,
        `insert into public.ai_turns(workspace_id, conversation_id, instance_id, trigger_message_id, due_at) select workspace_id, conversation_id, instance_id, trigger_message_id, now() from public.ai_turns`,
        `update public.workspace_ai_state set paused = false`,
        `insert into public.workspace_ai_state(workspace_id, paused) values ('${LOJA_A}', true)`,
        `update public.instances set is_enabled = false where id = '${CHIP_A}'`,
      ]) {
        expect(await banco.esperarErro(() => banco.db.query(consulta)), consulta).toMatch(/permission denied/);
      }

      await agirComo(DONO_B);
      expect((await banco.db.query('select status from public.ai_turns')).rows).toEqual([]);
      expect((await banco.db.query('select workspace_id from public.workspace_ai_state')).rows).toEqual([{ workspace_id: LOJA_B }]);
      await agirComo(INTRUSO);
      expect((await banco.db.query('select status from public.ai_turns')).rows).toEqual([]);
      expect((await banco.db.query('select workspace_id from public.workspace_ai_state')).rows).toEqual([]);
    });
    await banco.comoAnonimo(async () => {
      expect(await banco.esperarErro(() => banco.db.query('select 1 from public.ai_turns'))).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => banco.db.query('select 1 from public.workspace_ai_state'))).toMatch(/permission denied/);
    });
  });

  test('só existe uma vez esperando e uma em andamento por conversa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararIa();
      await avisar('WA-IN-1', 'Oi');
      const repetir = (situacao: string) =>
        sql(`insert into public.ai_turns(workspace_id, conversation_id, instance_id, trigger_message_id, status, due_at)
             select workspace_id, conversation_id, instance_id, trigger_message_id, '${situacao}', now() from public.ai_turns limit 1`);
      expect(await banco.esperarErro(() => repetir('waiting'))).toMatch(/ai_turns_one_waiting_uq/);
      await repetir('running');
      expect(await banco.esperarErro(() => repetir('running'))).toMatch(/ai_turns_one_running_uq/);
    });
  });
});
