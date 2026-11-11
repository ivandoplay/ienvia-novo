/**
 * Conversar pela Inbox: responder, o que acontece quando o envio falha ou fica incerto,
 * o eco que a Evolution manda de volta, mensagens enviadas pelo celular e reabrir conversa.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import {
  ATENDENTE_A,
  CHIP_A,
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

const RESUMO = 'e'.repeat(64);
const CHIP_NA_EVOLUTION = 'ienvia-conversa-0001';
const CLIENTE_A = '5586900000001@s.whatsapp.net';
const chave = (n: number) => `chave-de-envio-${String(n).padStart(4, '0')}`;

async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role authenticated');
  }
}

/** Dentro da mesma transação, passa a agir como outra pessoa. */
const agirComo = (usuario: string) => banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [usuario]);

/** No cenário o chip da Loja A é da Evolution e está conectado, mas ainda sem nome lá nem segredo de aviso. */
const prepararChip = () =>
  comoAdmin(() =>
    banco.db.exec(`
      update public.instances set provider_instance_name = '${CHIP_NA_EVOLUTION}' where id = '${CHIP_A}';
      insert into private.evolution_webhook_auth(workspace_id, instance_id, token_sha256) values ('${LOJA_A}', '${CHIP_A}', '${RESUMO}');
    `),
  );

interface Inicio {
  message_id: string;
  status: string;
  already_exists: boolean;
  provider_instance_name?: string;
  recipient?: string;
}

async function comecar(texto: string, chaveDoEnvio = chave(1), conversa = CONVERSA_A, empresa = LOJA_A): Promise<Inicio> {
  const { rows } = await banco.db.query<{ r: Inicio }>('select public.start_my_text_message($1,$2,$3,$4) as r', [
    empresa,
    conversa,
    texto,
    chaveDoEnvio,
  ]);
  return rows[0]!.r;
}

async function terminar(mensagem: string, resultado: string, idNoWhatsapp: string | null = null, empresa = LOJA_A) {
  const { rows } = await banco.db.query<{ r: { status: string; changed: boolean } }>(
    'select public.finish_my_text_message($1,$2,$3,$4) as r',
    [empresa, mensagem, resultado, idNoWhatsapp],
  );
  return rows[0]!.r;
}

/** O servidor entrega um aviso de mensagem, como a rota de avisos faz. */
const avisar = (idNoWhatsapp: string, texto: string, deMim: boolean, contato = CLIENTE_A, nome: string | null = 'Cliente da A') =>
  comoAdmin(async () => {
    const { rows } = await banco.db.query<{ r: { result: string; adopted?: boolean; direction?: string; conversation_id?: string } }>(
      'select public.ingest_evolution_text($1,$2,$3,$4,$5,$6,$7,now(),$8) as r',
      [CHIP_NA_EVOLUTION, RESUMO, idNoWhatsapp, 'MESSAGES_UPSERT', contato, nome, texto, deMim],
    );
    return rows[0]!.r;
  });

const acao = (nome: string, conversa = CONVERSA_A, empresa = LOJA_A) =>
  banco.db.query('select public.transition_workspace_conversation($1,$2,$3)', [empresa, conversa, nome]);

async function lerConversa(id = CONVERSA_A) {
  const { rows } = await banco.db.query('select stage, unread_count, last_message_preview from public.conversations where id = $1', [id]);
  return rows[0];
}

async function enviadas(conversa = CONVERSA_A) {
  const { rows } = await banco.db.query(
    `select status, body_text, provider_message_id, actor_type, sent_by from public.messages
      where conversation_id = $1 and direction = 'outbound' order by created_at`,
    [conversa],
  );
  return rows;
}

const COMO_ESTAVA = { stage: 'waiting_human', unread_count: 2, last_message_preview: null };

describe('responder pelo painel', () => {
  test('a mensagem nasce "enviando"; quando sai, a conversa fica aguardando o cliente', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const inicio = await comecar('  Temos sim!  ');
      expect(inicio).toMatchObject({
        status: 'sending',
        already_exists: false,
        provider_instance_name: CHIP_NA_EVOLUTION,
        recipient: CLIENTE_A,
      });
      expect(await lerConversa()).toEqual(COMO_ESTAVA);

      expect(await terminar(inicio.message_id, 'sent', 'WA-1')).toMatchObject({ status: 'sent', changed: true });
      expect(await enviadas()).toEqual([
        { status: 'sent', body_text: 'Temos sim!', provider_message_id: 'WA-1', actor_type: 'human', sent_by: DONA_A },
      ]);
      expect(await lerConversa()).toEqual({ stage: 'waiting_customer', unread_count: 0, last_message_preview: 'Temos sim!' });
    });
  });

  test('a atendente da loja também responde', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararChip();
      expect((await comecar('Já te respondo')).status).toBe('sending');
      expect(await enviadas()).toMatchObject([{ sent_by: ATENDENTE_A }]);
    });
  });

  test.each([
    ['o dono de outra loja', DONO_B],
    ['quem não participa de nenhuma empresa', INTRUSO],
    ['o funcionário suspenso', SUSPENSO_A],
  ])('%s não responde pela Loja A', async (_quem, usuario) => {
    await banco.comoUsuario(usuario, async () => {
      expect(await banco.esperarErro(() => comecar('intruso'))).toMatch(/Workspace membership required/);
    });
  });

  test('visitante sem login não executa as funções de envio', async () => {
    await banco.comoAnonimo(async () => {
      expect(await banco.esperarErro(() => comecar('intruso'))).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => terminar(CONVERSA_A, 'sent'))).toMatch(/permission denied/);
    });
  });

  test('ninguém alcança a conversa de outra empresa usando a própria como endereço', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(() => comecar('oi', chave(1), CONVERSA_B))).toMatch(/Conversation not found/);
    });
  });

  test('pedido repetido (clique duplo) não cria a segunda mensagem', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const primeiro = await comecar('Temos sim!');
      const repetido = await comecar('Temos sim!');
      expect(repetido).toEqual({ message_id: primeiro.message_id, status: 'sending', already_exists: true, body_text: 'Temos sim!' });
      expect(await enviadas()).toHaveLength(1);
    });
  });

  test.each([
    ['texto vazio', '   ', chave(1), /Invalid message text/],
    ['texto longo demais', 'x'.repeat(4097), chave(1), /Invalid message text/],
    ['chave de envio fora do formato', 'oi', 'curta', /Invalid idempotency key/],
  ])('recusa %s', async (_caso, texto, chaveDoEnvio, mensagem) => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      expect(await banco.esperarErro(() => comecar(texto, chaveDoEnvio))).toMatch(mensagem);
    });
  });

  test('não envia por chip desconectado, em conversa resolvida, nem por chip do motor local', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await comoAdmin(() => banco.db.exec(`update public.instances set status = 'disconnected' where id = '${CHIP_A}'`));
      expect(await banco.esperarErro(() => comecar('oi'))).toMatch(/instance_not_connected/);

      await comoAdmin(() => banco.db.exec(`update public.instances set status = 'connected' where id = '${CHIP_A}'`));
      await acao('resolve');
      expect(await banco.esperarErro(() => comecar('oi'))).toMatch(/conversation_closed/);
      expect(await enviadas()).toHaveLength(0);
    });
    await banco.comoUsuario(DONO_B, async () => {
      expect(await banco.esperarErro(() => comecar('oi', chave(1), CONVERSA_B, LOJA_B))).toMatch(/instance_unavailable/);
    });
  });

  test('envio que falhou não mexe na conversa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      expect(await terminar(id, 'failed')).toMatchObject({ status: 'failed', changed: true });
      expect(await lerConversa()).toEqual(COMO_ESTAVA);
    });
  });

  test('envio incerto fica esperando uma pessoa decidir, e a decisão dela vale', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      expect(await terminar(id, 'uncertain')).toMatchObject({ status: 'awaiting_human_confirmation', changed: true });
      expect(await terminar(id, 'uncertain')).toMatchObject({ changed: false });
      expect(await lerConversa()).toEqual(COMO_ESTAVA);

      expect(await terminar(id, 'sent')).toMatchObject({ status: 'sent', changed: true });
      expect(await lerConversa()).toMatchObject({ stage: 'waiting_customer', unread_count: 0 });

      const auditoria = await comoAdmin(() =>
        banco.db.query('select action from private.audit_events where target_id = $1 order by id', [id]),
      );
      expect(auditoria.rows).toEqual([{ action: 'message_send_uncertain' }, { action: 'message_send_sent' }]);
    });
  });

  test('a pessoa também pode dizer que o envio incerto não saiu', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      await terminar(id, 'uncertain');
      expect(await terminar(id, 'failed')).toMatchObject({ status: 'failed', changed: true });
      expect(await lerConversa()).toEqual(COMO_ESTAVA);
    });
  });

  test('mensagem que já saiu não muda mais', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      await terminar(id, 'sent', 'WA-1');
      expect(await terminar(id, 'failed')).toEqual({ message_id: id, status: 'sent', changed: false });
    });
  });

  test('outra empresa não finaliza a mensagem de ninguém', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      await agirComo(DONO_B);
      expect(await banco.esperarErro(() => terminar(id, 'failed', null, LOJA_B))).toMatch(/Message not found/);
      expect(await banco.esperarErro(() => terminar(id, 'failed', null, LOJA_A))).toMatch(/Workspace membership required/);
    });
  });
});

describe('eco da Evolution (a mensagem que nós mesmos enviamos volta como aviso)', () => {
  test('o eco de um envio do painel é reconhecido como a mesma mensagem', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');

      expect(await avisar('WA-9', 'Temos sim!', true)).toMatchObject({ result: 'accepted', adopted: true, direction: 'outbound' });
      expect(await enviadas()).toMatchObject([{ status: 'sent', provider_message_id: 'WA-9', sent_by: DONA_A }]);

      // O painel termina logo depois, com o mesmo identificador: nada muda e nada duplica.
      expect(await terminar(id, 'sent', 'WA-9')).toMatchObject({ status: 'sent', changed: false });
      expect(await enviadas()).toHaveLength(1);
    });
  });

  test('eco que chega depois de o painel anotar o identificador é só repetição', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      await terminar(id, 'sent', 'WA-9');
      expect((await avisar('WA-9', 'Temos sim!', true)).result).toBe('duplicate');
      expect(await enviadas()).toHaveLength(1);
    });
  });

  test('o eco confirma sozinho um envio que estava sem confirmação', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      await terminar(id, 'uncertain');
      expect(await avisar('WA-9', 'Temos sim!', true)).toMatchObject({ result: 'accepted', adopted: true });
      expect(await enviadas()).toMatchObject([{ status: 'sent', provider_message_id: 'WA-9' }]);
      expect(await lerConversa()).toMatchObject({ stage: 'waiting_customer', unread_count: 0 });
    });
  });

  test('eco guardado como mensagem do celular (o texto veio diferente) não vira mensagem repetida', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      expect(await avisar('WA-9', 'Temos sim! (editado)', true)).toMatchObject({ result: 'accepted', adopted: false });
      expect(await enviadas()).toHaveLength(2);

      expect(await terminar(id, 'sent', 'WA-9')).toMatchObject({ status: 'sent', changed: true });
      expect(await enviadas()).toEqual([
        { status: 'sent', body_text: 'Temos sim!', provider_message_id: 'WA-9', actor_type: 'human', sent_by: DONA_A },
      ]);
    });
  });

  describe('duas mensagens do painel com o mesmo texto, enviadas quase juntas', () => {
    /** Cria as duas e faz o eco da primeira cair na segunda (a mais recente em aberto). */
    async function prepararTroca() {
      await prepararChip();
      const primeira = (await comecar('ok', chave(1))).message_id;
      const segunda = (await comecar('ok', chave(2))).message_id;
      await comoAdmin(() =>
        banco.db.query(`update public.messages set created_at = now() - interval '1 minute' where id = $1`, [primeira]),
      );
      expect(await avisar('WA-1', 'ok', true)).toMatchObject({ result: 'accepted', adopted: true });
      const { rows } = await banco.db.query('select status, provider_message_id from public.messages where id = $1', [segunda]);
      expect(rows).toEqual([{ status: 'sent', provider_message_id: 'WA-1' }]);
      return { primeira, segunda };
    }
    const ler = async (id: string) =>
      (await banco.db.query('select status, provider_message_id from public.messages where id = $1', [id])).rows[0];

    test('a dona do identificador termina primeiro: a outra devolve e espera a própria confirmação', async () => {
      await banco.comoUsuario(DONA_A, async () => {
        const { primeira, segunda } = await prepararTroca();

        expect(await terminar(primeira, 'sent', 'WA-1')).toMatchObject({ status: 'sent', changed: true });
        expect(await ler(primeira)).toEqual({ status: 'sent', provider_message_id: 'WA-1' });
        expect(await ler(segunda)).toEqual({ status: 'awaiting_human_confirmation', provider_message_id: null });

        expect(await terminar(segunda, 'sent', 'WA-2')).toMatchObject({ status: 'sent', changed: true });
        expect(await ler(segunda)).toEqual({ status: 'sent', provider_message_id: 'WA-2' });
        expect(await enviadas()).toHaveLength(2);
      });
    });

    test('a que ficou com o identificador errado termina primeiro: ele é corrigido', async () => {
      await banco.comoUsuario(DONA_A, async () => {
        const { primeira, segunda } = await prepararTroca();

        expect(await terminar(segunda, 'sent', 'WA-2')).toMatchObject({ status: 'sent', changed: false });
        expect(await ler(segunda)).toEqual({ status: 'sent', provider_message_id: 'WA-2' });

        expect(await terminar(primeira, 'sent', 'WA-1')).toMatchObject({ status: 'sent', changed: true });
        expect(await ler(primeira)).toEqual({ status: 'sent', provider_message_id: 'WA-1' });
        expect(await enviadas()).toHaveLength(2);
      });
    });

    test('se a outra falhou de verdade, ela termina como falha', async () => {
      await banco.comoUsuario(DONA_A, async () => {
        const { primeira, segunda } = await prepararTroca();
        await terminar(primeira, 'sent', 'WA-1');
        expect(await terminar(segunda, 'failed')).toMatchObject({ status: 'failed', changed: true });
        expect(await ler(primeira)).toEqual({ status: 'sent', provider_message_id: 'WA-1' });
      });
    });
  });

  test('conversa resolvida logo depois do envio: o eco confirma a mensagem lá mesmo, sem abrir conversa nova', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await comecar('Temos sim!');
      await acao('resolve');

      const eco = await avisar('WA-9', 'Temos sim!', true);
      expect(eco).toMatchObject({ result: 'accepted', adopted: true, conversation_id: CONVERSA_A });
      expect(await enviadas()).toMatchObject([{ status: 'sent', provider_message_id: 'WA-9' }]);
      expect(await lerConversa()).toMatchObject({ stage: 'resolved' });
      const { rows } = await banco.db.query('select count(*)::int as n from public.conversations where workspace_id = $1', [LOJA_A]);
      expect(rows).toEqual([{ n: 1 }]);
    });
  });

  test('o painel já anotou o identificador e a conversa foi resolvida: o eco não cria nada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      await terminar(id, 'sent', 'WA-9');
      await acao('resolve');

      expect((await avisar('WA-9', 'Temos sim!', true)).result).toBe('duplicate');
      const { rows } = await banco.db.query(
        `select (select count(*)::int from public.conversations where workspace_id = $1) as conversas,
                (select count(*)::int from public.messages where workspace_id = $1 and direction = 'outbound') as enviadas`,
        [LOJA_A],
      );
      expect(rows).toEqual([{ conversas: 1, enviadas: 1 }]);
    });
  });

  test('envio em aberto há mais de 2 horas não é confirmado por um eco de agora', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      await terminar(id, 'uncertain');
      await comoAdmin(() =>
        banco.db.query(`update public.messages set created_at = now() - interval '3 hours' where id = $1`, [id]),
      );

      expect(await avisar('WA-9', 'Temos sim!', true)).toMatchObject({ result: 'accepted', adopted: false });
      expect(await enviadas()).toMatchObject([
        { status: 'awaiting_human_confirmation', provider_message_id: null, sent_by: DONA_A },
        { status: 'sent', provider_message_id: 'WA-9', sent_by: null },
      ]);
    });
  });

  test('envio que a pessoa confirmou à mão ainda recebe o identificador se o eco chegar logo depois', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const { message_id: id } = await comecar('Temos sim!');
      await terminar(id, 'uncertain');
      await terminar(id, 'sent');

      expect(await avisar('WA-9', 'Temos sim!', true)).toMatchObject({ result: 'accepted', adopted: true });
      expect(await enviadas()).toMatchObject([{ status: 'sent', provider_message_id: 'WA-9' }]);
    });
  });

  test('mensagem enviada direto pelo celular do chip entra na conversa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      expect(await avisar('WA-CEL-1', 'Respondi pelo celular', true)).toMatchObject({ result: 'accepted', adopted: false });
      expect(await enviadas()).toEqual([
        { status: 'sent', body_text: 'Respondi pelo celular', provider_message_id: 'WA-CEL-1', actor_type: 'human', sent_by: null },
      ]);
      expect(await lerConversa()).toEqual({ stage: 'waiting_customer', unread_count: 0, last_message_preview: 'Respondi pelo celular' });
    });
  });

  test('conversa começada pelo celular: o contato nasce sem nome e ganha o nome quando responde', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const novo = '5585911112222@s.whatsapp.net';
      const ida = await avisar('WA-N-1', 'Olá, aqui é da loja', true, novo, 'Nome do Dono do Chip');
      const lerContato = async () =>
        (await banco.db.query('select display_name, phone_e164 from public.contacts where external_user_id = $1', [novo])).rows[0];

      expect(await lerContato()).toEqual({ display_name: '', phone_e164: '+5585911112222' });
      expect(await lerConversa(ida.conversation_id)).toMatchObject({ stage: 'waiting_customer', unread_count: 0 });

      const volta = await avisar('WA-N-2', 'Oi!', false, novo, 'Joana');
      expect(volta.conversation_id).toBe(ida.conversation_id);
      expect(await lerContato()).toMatchObject({ display_name: 'Joana' });
      expect(await lerConversa(ida.conversation_id)).toEqual({ stage: 'human', unread_count: 1, last_message_preview: 'Oi!' });
    });
  });
});

describe('resolver e reabrir', () => {
  test('resolver zera as mensagens não lidas', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await acao('resolve');
      expect(await lerConversa()).toMatchObject({ stage: 'resolved', unread_count: 0 });
    });
  });

  test('marcar como lida zera o contador e não enche a auditoria', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await acao('mark_read');
      await acao('mark_read');
      expect(await lerConversa()).toMatchObject({ stage: 'waiting_human', unread_count: 0 });
      const auditoria = await comoAdmin(() =>
        banco.db.query('select count(*)::int as n from private.audit_events where target_id = $1', [CONVERSA_A]),
      );
      expect(auditoria.rows).toEqual([{ n: 0 }]);
    });
  });

  test('resolver e reabrir ficam na auditoria', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await acao('resolve');
      await acao('reopen');
      const auditoria = await comoAdmin(() =>
        banco.db.query('select action from private.audit_events where target_id = $1 order by id', [CONVERSA_A]),
      );
      expect(auditoria.rows).toEqual([{ action: 'conversation_resolved' }, { action: 'conversation_reopened' }]);
    });
  });

  test('uma conversa resolvida pode ser reaberta', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await acao('resolve');
      expect(await lerConversa()).toMatchObject({ stage: 'resolved' });
      await acao('reopen');
      expect(await lerConversa()).toMatchObject({ stage: 'human' });
    });
  });

  test('não reabre se o contato já escreveu de novo e existe uma conversa mais nova', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await acao('resolve');
      const nova = await avisar('WA-R-1', 'Voltei!', false);
      expect(nova.conversation_id).not.toBe(CONVERSA_A);
      expect(await banco.esperarErro(() => acao('reopen'))).toMatch(/another_open_conversation/);
    });
  });

  test('só reabre o que está resolvido, e só quem é da empresa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(() => acao('reopen'))).toMatch(/Conversation is not resolved/);
    });
    await banco.comoUsuario(DONO_B, async () => {
      expect(await banco.esperarErro(() => acao('reopen'))).toMatch(/Workspace membership required/);
    });
  });
});
