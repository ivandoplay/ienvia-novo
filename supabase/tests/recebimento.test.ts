/**
 * Mensagens que chegam pela Evolution: viram contato, conversa e mensagem na empresa certa,
 * sem duplicar e sem deixar outra empresa ver.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import { DONA_A, DONO_B, LOJA_A, bancoComCenario } from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await bancoComCenario();
});

const RESUMO = 'c'.repeat(64);
const CHIP = 'ienvia-recebe-0001';
const CLIENTE = '5585977776666@s.whatsapp.net';

async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role authenticated');
  }
}

/** A dona cria um chip novo na Loja A; devolve o identificador dele. */
async function prepararChip(): Promise<string> {
  await comoAdmin(() => banco.db.exec(`update public.workspaces set max_instances = 5 where id = '${LOJA_A}'`));
  const { rows } = await banco.db.query<{ r: { id: string } }>(
    'select public.create_my_evolution_instance($1,$2,$3,$4,$5) as r',
    [LOJA_A, 'Recebimento', 'attendance', CHIP, RESUMO],
  );
  return rows[0]!.r.id;
}

/** O servidor entrega uma mensagem, como a rota de avisos faz. */
const receber = (id: string, texto: string, opcoes: { resumo?: string; deMim?: boolean; remetente?: string } = {}) =>
  comoAdmin(async () => {
    const { rows } = await banco.db.query<{ r: { result: string; conversation_id?: string } }>(
      'select public.ingest_evolution_text($1,$2,$3,$4,$5,$6,$7,now(),$8) as r',
      [CHIP, opcoes.resumo ?? RESUMO, id, 'MESSAGES_UPSERT', opcoes.remetente ?? CLIENTE, 'Cliente Novo', texto, opcoes.deMim ?? false],
    );
    return rows[0]!.r;
  });

describe('mensagem que chega', () => {
  test('a primeira cria o contato e a conversa; a segunda entra na mesma conversa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const chip = await prepararChip();

      const primeira = await receber('msg-1', 'Oi, tem pizza?');
      const segunda = await receber('msg-2', 'De calabresa');
      expect(primeira.result).toBe('accepted');
      expect(segunda).toMatchObject({ result: 'accepted', conversation_id: primeira.conversation_id });

      const contatos = await banco.db.query(
        'select display_name, phone_e164, channel from public.contacts where instance_id = $1',
        [chip],
      );
      expect(contatos.rows).toEqual([{ display_name: 'Cliente Novo', phone_e164: '+5585977776666', channel: 'whatsapp' }]);

      const conversas = await banco.db.query(
        'select stage, unread_count, last_message_preview from public.conversations where instance_id = $1',
        [chip],
      );
      expect(conversas.rows).toEqual([{ stage: 'new', unread_count: 2, last_message_preview: 'De calabresa' }]);

      const mensagens = await banco.db.query(
        'select direction, actor_type, status, body_text from public.messages where instance_id = $1 order by created_at, body_text desc',
        [chip],
      );
      expect(mensagens.rows.map((linha) => (linha as { body_text: string }).body_text).sort()).toEqual(['De calabresa', 'Oi, tem pizza?']);
      expect(mensagens.rows[0]).toMatchObject({ direction: 'inbound', actor_type: 'contact', status: 'received' });
    });
  });

  test('o mesmo aviso entregue duas vezes não duplica a mensagem nem a contagem', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const chip = await prepararChip();
      expect((await receber('msg-1', 'Oi')).result).toBe('accepted');
      expect((await receber('msg-1', 'Oi')).result).toBe('duplicate');

      const { rows } = await banco.db.query<{ mensagens: number; nao_lidas: number }>(
        `select (select count(*)::int from public.messages where instance_id = $1) as mensagens,
                (select unread_count from public.conversations where instance_id = $1) as nao_lidas`,
        [chip],
      );
      expect(rows[0]).toEqual({ mensagens: 1, nao_lidas: 1 });
    });
  });

  test('segredo errado não grava nada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const chip = await prepararChip();
      expect((await receber('msg-1', 'Oi', { resumo: 'd'.repeat(64) })).result).toBe('unauthorized');
      const { rows } = await banco.db.query('select id from public.messages where instance_id = $1', [chip]);
      expect(rows).toHaveLength(0);
    });
  });

  test('grupo e mensagem enviada pelo próprio chip ficam de fora (por enquanto)', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const chip = await prepararChip();
      expect((await receber('msg-1', 'no grupo', { remetente: '120363000000000000@g.us' })).result).toBe('ignored');
      expect((await receber('msg-2', 'resposta pelo celular', { deMim: true })).result).toBe('ignored');
      const { rows } = await banco.db.query('select id from public.messages where instance_id = $1', [chip]);
      expect(rows).toHaveLength(0);
    });
  });

  test('a conversa nova aparece para a dona da loja e não para a outra empresa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await receber('msg-1', 'Oi, tem pizza?');
      const minhas = await banco.db.query(`select id from public.messages where body_text = 'Oi, tem pizza?' and provider_message_id = 'msg-1'`);
      expect(minhas.rows).toHaveLength(1);

      // Ainda dentro da mesma transação: troca de pessoa para o dono da outra loja.
      await banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [DONO_B]);
      const doVizinho = await banco.db.query(`select id from public.messages where provider_message_id = 'msg-1'`);
      expect(doVizinho.rows).toHaveLength(0);
    });
  });
});
