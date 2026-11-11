/**
 * Leitura da Inbox: a lista de conversas (com filtros, busca e contadores), a conversa aberta
 * e o "mudou alguma coisa?" que a tela consulta de tempos em tempos.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import {
  ATENDENTE_A,
  CHIP_A,
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

const CHIP_2 = '11111111-0000-4000-8000-0000000000c1';
const id = (n: number) => `11111111-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role authenticated');
  }
}

/**
 * Além da conversa do cenário (Cliente da A, esperando atendente, 2 não lidas), a Loja A ganha:
 *   Bruno   — nova, 1 não lida, no segundo chip           (há 1 min)
 *   Carla   — aguardando o cliente, tudo lido             (há 2 min)
 *   Débora  — resolvida                                    (há 3 min)
 *   50%_off — com a IA, 3 não lidas (nome com curingas)    (há 4 min)
 *   Elias   — arquivada                                    (há 5 min)
 */
const povoar = () =>
  comoAdmin(() =>
    banco.db.exec(`
      insert into public.instances (id, workspace_id, channel, engine, display_name, status) values
        ('${CHIP_2}', '${LOJA_A}', 'whatsapp', 'evolution', 'Segundo chip', 'disconnected');
      insert into public.contacts (id, workspace_id, instance_id, channel, external_user_id, display_name, phone_e164) values
        ('${id(1)}', '${LOJA_A}', '${CHIP_2}', 'whatsapp', '558588887777@s.whatsapp.net', 'Bruno Lima', '+558588887777'),
        ('${id(2)}', '${LOJA_A}', '${CHIP_A}', 'whatsapp', '5511977776666@s.whatsapp.net', 'Carla', '+5511977776666'),
        ('${id(3)}', '${LOJA_A}', '${CHIP_A}', 'whatsapp', '5521966665555@s.whatsapp.net', 'Débora', '+5521966665555'),
        ('${id(4)}', '${LOJA_A}', '${CHIP_A}', 'whatsapp', '5531955554444@s.whatsapp.net', '50%_off', '+5531955554444'),
        ('${id(5)}', '${LOJA_A}', '${CHIP_A}', 'whatsapp', '5541944443333@s.whatsapp.net', 'Elias', '+5541944443333');
      insert into public.conversations (id, workspace_id, contact_id, instance_id, stage, unread_count, last_message_at, last_message_preview) values
        ('${id(11)}', '${LOJA_A}', '${id(1)}', '${CHIP_2}', 'new', 1, now() - interval '1 minute', 'Quero um orçamento'),
        ('${id(12)}', '${LOJA_A}', '${id(2)}', '${CHIP_A}', 'waiting_customer', 0, now() - interval '2 minutes', 'Pode ser amanhã?'),
        ('${id(13)}', '${LOJA_A}', '${id(3)}', '${CHIP_A}', 'resolved', 0, now() - interval '3 minutes', 'Obrigada!'),
        ('${id(14)}', '${LOJA_A}', '${id(4)}', '${CHIP_A}', 'ai', 3, now() - interval '4 minutes', 'Tem desconto de 100%?'),
        ('${id(15)}', '${LOJA_A}', '${id(5)}', '${CHIP_A}', 'archived', 0, now() - interval '5 minutes', 'orçamento antigo');
    `),
  );

interface Linha {
  id: string;
  stage: string;
  unread_count: number;
  contact_name: string;
  contact_phone: string | null;
  instance_name: string;
  last_message_preview: string | null;
}
interface Inbox {
  conversations: Linha[];
  has_more: boolean;
  counts: { unread: number; waiting: number };
}

async function lerInbox(
  opcoes: { ver?: string | null; chip?: string | null; busca?: string | null; telefones?: string[] | null; limite?: number | null; empresa?: string } = {},
): Promise<Inbox> {
  const { rows } = await banco.db.query<{ r: Inbox }>('select public.read_my_inbox($1,$2,$3,$4,$5,$6) as r', [
    opcoes.empresa ?? LOJA_A,
    opcoes.ver ?? null,
    opcoes.chip ?? null,
    opcoes.busca ?? null,
    opcoes.telefones ?? null,
    opcoes.limite ?? null,
  ]);
  return rows[0]!.r;
}
const nomes = (inbox: Inbox) => inbox.conversations.map((conversa) => conversa.contact_name);

interface Aberta {
  conversation: {
    id: string;
    stage: string;
    unread_count: number;
    contact: { id: string; display_name: string; phone_e164: string | null; erased: boolean };
    instance: { id: string; display_name: string; status: string; engine: string };
  };
  messages: Array<{ body_text: string; direction: string; status: string; from_panel: boolean; mine: boolean; has_media: boolean }>;
  has_more: boolean;
}
async function abrir(conversa: string, limite: number | null = null, empresa = LOJA_A): Promise<Aberta | null> {
  const { rows } = await banco.db.query<{ r: Aberta | null }>('select public.read_my_conversation($1,$2,$3) as r', [
    empresa,
    conversa,
    limite,
  ]);
  return rows[0]!.r;
}

const versao = async (empresa = LOJA_A) =>
  (await banco.db.query<{ v: string }>('select public.read_my_inbox_version($1) as v', [empresa])).rows[0]!.v;

describe('lista de conversas', () => {
  test('Ativas é o padrão: da mais recente para a mais antiga, sem resolvidas nem arquivadas', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      const inbox = await lerInbox();
      expect(nomes(inbox)).toEqual(['Cliente da A', 'Bruno Lima', 'Carla', '50%_off']);
      expect(inbox.has_more).toBe(false);
      expect(inbox.conversations[1]).toMatchObject({
        id: id(11),
        stage: 'new',
        unread_count: 1,
        contact_phone: '+558588887777',
        instance_name: 'Segundo chip',
        last_message_preview: 'Quero um orçamento',
      });
    });
  });

  test.each([
    ['unread', ['Cliente da A', 'Bruno Lima', '50%_off']],
    ['waiting', ['Cliente da A', 'Bruno Lima']],
    ['resolved', ['Débora']],
    ['open', ['Cliente da A', 'Bruno Lima', 'Carla', '50%_off']],
  ])('filtro "%s"', async (ver, esperado) => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await povoar();
      expect(nomes(await lerInbox({ ver }))).toEqual(esperado);
    });
  });

  test('os contadores não dependem do filtro escolhido', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      for (const ver of ['open', 'unread', 'waiting', 'resolved']) {
        expect((await lerInbox({ ver })).counts).toEqual({ unread: 3, waiting: 2 });
      }
    });
  });

  test('ver por chip: lista e contadores só daquele chip', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      const doSegundo = await lerInbox({ chip: CHIP_2 });
      expect(nomes(doSegundo)).toEqual(['Bruno Lima']);
      expect(doSegundo.counts).toEqual({ unread: 1, waiting: 1 });
      expect((await lerInbox({ chip: CHIP_A })).counts).toEqual({ unread: 2, waiting: 1 });
    });
  });

  test('"ver mais": o limite corta a lista e avisa que há mais', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      const pagina = await lerInbox({ limite: 2 });
      expect(nomes(pagina)).toEqual(['Cliente da A', 'Bruno Lima']);
      expect(pagina.has_more).toBe(true);
      expect((await lerInbox({ limite: 4 })).has_more).toBe(false);
    });
  });

  test('filtro desconhecido é recusado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(() => lerInbox({ ver: 'qualquer' }))).toMatch(/Unsupported inbox view/);
    });
  });
});

describe('busca', () => {
  test('por nome, sem diferenciar maiúsculas, em qualquer etapa (menos arquivadas)', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      expect(nomes(await lerInbox({ busca: 'bruno' }))).toEqual(['Bruno Lima']);
      expect(nomes(await lerInbox({ busca: '  DÉBORA ', ver: 'unread' }))).toEqual(['Débora']);
      expect(nomes(await lerInbox({ busca: 'Elias' }))).toEqual([]);
    });
  });

  test('pelo texto da última mensagem', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      expect(nomes(await lerInbox({ busca: 'orçamento' }))).toEqual(['Bruno Lima']);
    });
  });

  test('por telefone, com as variações que o painel manda', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      // A pessoa digitou "(85) 98888-7777"; o número guardado não tem o nono dígito.
      expect(nomes(await lerInbox({ busca: '(85) 98888-7777', telefones: ['85988887777', '8588887777'] }))).toEqual(['Bruno Lima']);
      expect(nomes(await lerInbox({ busca: '8888-7777', telefones: ['88887777'] }))).toEqual(['Bruno Lima']);
      // Um trecho curto pode bater em mais de um contato.
      expect(nomes(await lerInbox({ busca: '7777', telefones: ['7777'] }))).toEqual(['Bruno Lima', 'Carla']);
      // Trecho curto demais, ou que não é só dígito, é ignorado.
      expect(nomes(await lerInbox({ busca: '777', telefones: ['777', '55%'] }))).toEqual([]);
    });
  });

  test('% e _ digitados são procurados ao pé da letra', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      expect(nomes(await lerInbox({ busca: '%' }))).toEqual(['50%_off']);
      expect(nomes(await lerInbox({ busca: '_' }))).toEqual(['50%_off']);
      expect(nomes(await lerInbox({ busca: '0%_o' }))).toEqual(['50%_off']);
      expect(nomes(await lerInbox({ busca: '100%' }))).toEqual(['50%_off']);
      expect(nomes(await lerInbox({ busca: 'B%o' }))).toEqual([]);
    });
  });

  test('a busca respeita o filtro de chip', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await povoar();
      expect(nomes(await lerInbox({ busca: 'a', chip: CHIP_2 }))).toEqual(['Bruno Lima']);
    });
  });

  test('texto de busca grande demais é recusado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(() => lerInbox({ busca: 'x'.repeat(81) }))).toMatch(/Search text too long/);
    });
  });
});

describe('conversa aberta', () => {
  test('traz a conversa, o contato, o chip e as mensagens da mais antiga para a mais nova', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await comoAdmin(() =>
        banco.db.exec(`
          insert into public.messages (workspace_id, conversation_id, instance_id, direction, source_engine, actor_type, status, body_text, occurred_at, sent_by, idempotency_key) values
            ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'outbound', 'evolution', 'human', 'sent', 'Temos sim!', now() + interval '1 minute', '${DONA_A}', 'chave-de-teste-0001'),
            ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'outbound', 'evolution', 'human', 'sent', 'Respondi pelo celular', now() + interval '2 minutes', null, null),
            ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'outbound', 'evolution', 'human', 'failed', 'Da atendente', now() + interval '3 minutes', '${ATENDENTE_A}', 'chave-de-teste-0002');
        `),
      );
      const aberta = await abrir(CONVERSA_A);
      expect(aberta?.conversation).toMatchObject({
        id: CONVERSA_A,
        stage: 'waiting_human',
        unread_count: 2,
        contact: { id: CONTATO_A, display_name: 'Cliente da A', phone_e164: '+5586900000001', erased: false },
        instance: { id: CHIP_A, display_name: 'Chip da Loja A', status: 'connected', engine: 'evolution' },
      });
      expect(aberta?.messages).toMatchObject([
        { body_text: 'Oi, tem pizza?', direction: 'inbound', status: 'received', from_panel: false, mine: false, has_media: false },
        { body_text: 'Temos sim!', direction: 'outbound', status: 'sent', from_panel: true, mine: true },
        { body_text: 'Respondi pelo celular', direction: 'outbound', from_panel: false, mine: false },
        { body_text: 'Da atendente', direction: 'outbound', status: 'failed', from_panel: true, mine: false },
      ]);
      expect(aberta?.has_more).toBe(false);

      const ultimas = await abrir(CONVERSA_A, 2);
      expect(ultimas?.messages.map((mensagem) => mensagem.body_text)).toEqual(['Respondi pelo celular', 'Da atendente']);
      expect(ultimas?.has_more).toBe(true);
    });
  });

  test('duas mensagens no mesmo segundo saem na ordem em que foram gravadas', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await comoAdmin(() =>
        banco.db.exec(`
          insert into public.messages (workspace_id, conversation_id, instance_id, direction, source_engine, actor_type, status, body_text, occurred_at, created_at) values
            ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'inbound', 'evolution', 'contact', 'received', 'segunda', '2030-01-01T10:00:00Z', '2030-01-01T10:00:02Z'),
            ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'inbound', 'evolution', 'contact', 'received', 'primeira', '2030-01-01T10:00:00Z', '2030-01-01T10:00:01Z'),
            ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'inbound', 'evolution', 'contact', 'received', 'terceira', '2030-01-01T10:00:00Z', '2030-01-01T10:00:03Z');
        `),
      );
      const aberta = await abrir(CONVERSA_A, 3);
      expect(aberta?.messages.map((mensagem) => mensagem.body_text)).toEqual(['primeira', 'segunda', 'terceira']);
    });
  });

  test('conversa de outra empresa não abre', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await abrir(CONVERSA_B)).toBeNull();
      expect(await banco.esperarErro(() => abrir(CONVERSA_B, null, LOJA_B))).toMatch(/Workspace membership required/);
    });
  });
});

describe('quem pode ler', () => {
  test.each([
    ['o dono de outra loja', DONO_B],
    ['quem não participa de nenhuma empresa', INTRUSO],
    ['o funcionário suspenso', SUSPENSO_A],
  ])('%s não lê a Inbox da Loja A', async (_quem, usuario) => {
    await banco.comoUsuario(usuario, async () => {
      expect(await banco.esperarErro(() => lerInbox())).toMatch(/Workspace membership required/);
      expect(await banco.esperarErro(() => abrir(CONVERSA_A))).toMatch(/Workspace membership required/);
      expect(await versao()).toBe('');
    });
  });

  test('visitante sem login não executa as funções de leitura', async () => {
    await banco.comoAnonimo(async () => {
      expect(await banco.esperarErro(() => lerInbox())).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => abrir(CONVERSA_A))).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => versao())).toMatch(/permission denied/);
    });
  });

  test('o dono da Loja B só vê a Loja B', async () => {
    await banco.comoUsuario(DONO_B, async () => {
      const inbox = await lerInbox({ empresa: LOJA_B });
      expect(nomes(inbox)).toEqual(['Cliente da B']);
      expect(inbox.counts).toEqual({ unread: 1, waiting: 1 });
    });
  });
});

describe('"mudou alguma coisa?"', () => {
  test('o texto muda quando chega mensagem e quando um chip muda', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const antes = await versao();
      expect(antes).not.toBe('');
      expect(await versao()).toBe(antes);

      await comoAdmin(() => banco.db.exec(`update public.conversations set unread_count = unread_count + 1 where id = '${CONVERSA_A}'`));
      const comMensagem = await versao();
      expect(comMensagem).not.toBe(antes);

      await comoAdmin(() =>
        banco.db.exec(`update public.instances set status = 'disconnected', updated_at = now() + interval '1 second' where id = '${CHIP_A}'`),
      );
      expect(await versao()).not.toBe(comMensagem);
    });
  });
});
