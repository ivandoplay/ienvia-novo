import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import {
  ATENDENTE_A,
  CHIP_A,
  CONTATO_A,
  CONVERSA_A,
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

const CODE_HASH_1 = '1'.repeat(64);
const CODE_HASH_2 = '2'.repeat(64);
const TOKEN_HASH_1 = 'a'.repeat(64);
const TOKEN_HASH_2 = 'b'.repeat(64);
const CIFRA = (prefixo: string) => `v1.${'i'.repeat(16)}.${'t'.repeat(22)}.${prefixo.repeat(24)}`;

const comoAdmin = async <T>(fn: () => Promise<T>): Promise<T> => {
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role authenticated').catch(() => undefined);
  }
};

const comoServico = async <T>(fn: () => Promise<T>): Promise<T> => {
  await banco.db.exec('reset role');
  await banco.db.exec('set local role service_role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role authenticated').catch(() => undefined);
  }
};

async function chamar<T>(fn: string, args: unknown[] = []): Promise<T> {
  const placeholders = args.map((_, idx) => `$${idx + 1}`).join(',');
  const { rows } = await banco.db.query<{ r: T }>(`select public.${fn}(${placeholders}) as r`, args);
  return rows[0]!.r;
}

describe('Motor local — isolamento, permissões e ciclo de vida', () => {
  test('visitantes e equipe sem papel adequado não escrevem nas tabelas do motor local', async () => {
    await banco.comoAnonimo(async () => {
      expect(await banco.esperarErro(() => banco.db.query('select * from public.local_executors'))).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => banco.db.query('select * from public.local_motor_commands'))).toMatch(/permission denied/);
      expect(
        await banco.esperarErro(() => chamar('create_my_local_executor_pairing', [LOJA_A, 'PC Loja', CODE_HASH_1])),
      ).toMatch(/permission denied/);
      expect(
        await banco.esperarErro(() => chamar('pair_local_executor_by_code', [CODE_HASH_1, TOKEN_HASH_1, 'linux', '6.0.0'])),
      ).toMatch(/permission denied/);
    });

    await banco.comoUsuario(ATENDENTE_A, async () => {
      expect(
        await banco.esperarErro(() => chamar('create_my_local_executor_pairing', [LOJA_A, 'PC Atendente', CODE_HASH_1])),
      ).toMatch(/Workspace owner required/);
      expect(
        await banco.esperarErro(() =>
          banco.db.query(`insert into public.local_executors(workspace_id, display_name) values ('${LOJA_A}', 'Pirata')`),
        ),
      ).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => banco.db.query('select * from private.local_executor_tokens'))).toMatch(/permission denied/);
    });

    await banco.comoUsuario(INTRUSO, async () => {
      expect(
        await banco.esperarErro(() => chamar('create_my_local_executor_pairing', [LOJA_A, 'PC Intruso', CODE_HASH_1])),
      ).toMatch(/Workspace owner required/);
    });

    await banco.comoUsuario(SUSPENSO_A, async () => {
      expect(
        await banco.esperarErro(() => chamar('create_my_local_executor_pairing', [LOJA_A, 'PC Suspenso', CODE_HASH_1])),
      ).toMatch(/Workspace owner required/);
    });
  });

  test('pareamento único, heartbeat, comando único (nunca reenvia após lease expirado) e revogação', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await comoAdmin(() => banco.db.exec(`update public.workspaces set max_instances = 5 where id = '${LOJA_A}'`));

      const pareamento = await chamar<{ id: string; status: string }>('create_my_local_executor_pairing', [
        LOJA_A,
        'PC Caixa',
        CODE_HASH_1,
      ]);
      expect(pareamento.status).toBe('pending_pair');

      // Dono de outra loja não vê o aparelho nem vincula chip nele.
      await comoAdmin(() => banco.db.exec(`select set_config('request.jwt.claim.sub', '${DONO_B}', true)`));
      const visivelB = await banco.db.query('select id from public.local_executors where id = $1', [pareamento.id]);
      expect(visivelB.rows).toHaveLength(0);
      expect(
        await banco.esperarErro(() =>
          chamar('create_my_local_instance', [LOJA_B, 'Chip Pirata', 'both', pareamento.id]),
        ),
      ).toMatch(/Executor not found/);

      // Volta como DONA_A.
      await comoAdmin(() => banco.db.exec(`select set_config('request.jwt.claim.sub', '${DONA_A}', true)`));

      // Código errado falha; código certo pareia uma única vez.
      const errado = await comoServico(() =>
        chamar<{ result: string }>('pair_local_executor_by_code', [CODE_HASH_2, TOKEN_HASH_1, 'linux', '6.0.0']),
      );
      expect(errado.result).toBe('invalid_or_expired');

      const pareado = await comoServico(() =>
        chamar<{ result: string; executor_id: string; workspace_id: string }>('pair_local_executor_by_code', [
          CODE_HASH_1,
          TOKEN_HASH_1,
          'android-termux',
          '6.0.0',
          { host: 'pixel' },
        ]),
      );
      expect(pareado).toMatchObject({ result: 'paired', executor_id: pareamento.id, workspace_id: LOJA_A });

      // Repetir o mesmo código não funciona mais.
      const replay = await comoServico(() =>
        chamar<{ result: string }>('pair_local_executor_by_code', [CODE_HASH_1, TOKEN_HASH_2, 'linux', '6.0.0']),
      );
      expect(replay.result).toBe('invalid_or_expired');

      // Cria chip local ligado ao aparelho e pede QR Code.
      const chipLocal = await chamar<{ id: string; engine: string; local_executor_id: string }>('create_my_local_instance', [
        LOJA_A,
        'Balcão Baileys',
        'both',
        pareamento.id,
      ]);
      expect(chipLocal).toMatchObject({ engine: 'baileys', local_executor_id: pareamento.id });

      const acao = await chamar<{ command_id: string; status: string }>('request_my_local_instance_action', [
        LOJA_A,
        chipLocal.id,
        'connect_qr',
        {},
      ]);
      expect(acao.status).toBe('pending');

      // Motor lê heartbeat e retira o comando.
      const pulso = await comoServico(() =>
        chamar<{ result: string; instances: Array<{ id: string }> }>('authenticate_local_executor_heartbeat', [
          TOKEN_HASH_1,
          'android-termux',
          '6.0.1',
          {},
        ]),
      );
      expect(pulso.result).toBe('ok');
      expect(pulso.instances.map((i) => i.id)).toEqual([chipLocal.id]);

      const claimed = await comoServico(() =>
        chamar<{ result: string; commands: Array<{ id: string; command_type: string }> }>('claim_local_motor_commands', [
          TOKEN_HASH_1,
          10,
        ]),
      );
      expect(claimed.commands).toHaveLength(1);
      expect(claimed.commands[0]!.command_type).toBe('connect_qr');

      // Motor publica QR e depois conectado.
      await comoServico(() =>
        chamar('report_local_instance_state', [TOKEN_HASH_1, chipLocal.id, 'connecting', null, 'data:image/png;base64,AAA', null]),
      );
      await comoServico(() => chamar('complete_local_motor_command', [TOKEN_HASH_1, acao.command_id, 'succeeded', null, null]));
      await comoServico(() =>
        chamar('report_local_instance_state', [TOKEN_HASH_1, chipLocal.id, 'connected', '+5586999887766', null, null]),
      );

      // Mensagem recebida cria contato, conversa e responde pelo painel (sem nunca duplicar no timeout!).
      const recebida = await comoServico(() =>
        chamar<{ result: string; conversation_id: string; message_id: string }>('ingest_local_message', [
          TOKEN_HASH_1,
          chipLocal.id,
          'MSG-LOCAL-IN-1',
          '5586999112233@s.whatsapp.net',
          'João Local',
          'Oi pelo Baileys!',
          new Date().toISOString(),
          false,
          null,
        ]),
      );
      expect(recebida.result).toBe('accepted');

      // Eco duplicado com mesmo provider_event_id é ignorado.
      const duplicada = await comoServico(() =>
        chamar<{ result: string }>('ingest_local_message', [
          TOKEN_HASH_1,
          chipLocal.id,
          'MSG-LOCAL-IN-1',
          '5586999112233@s.whatsapp.net',
          'João Local',
          'Oi pelo Baileys!',
          new Date().toISOString(),
          false,
          null,
        ]),
      );
      expect(duplicada.result).toBe('duplicate');

      // Envio pela Inbox enfileira send_text único.
      const envio = await chamar<{ message_id: string; engine: string; command_id: string }>('start_my_text_message', [
        LOJA_A,
        recebida.conversation_id,
        'Resposta local!',
        'chave-local-envio-0001',
      ]);
      expect(envio.engine).toBe('baileys');

      const loteEnvio = await comoServico(() =>
        chamar<{ commands: Array<{ id: string; command_type: string }> }>('claim_local_motor_commands', [TOKEN_HASH_1, 10]),
      );
      expect(loteEnvio.commands).toHaveLength(1);
      expect(loteEnvio.commands[0]!.id).toBe(envio.command_id);

      // Simula lease expirado durante envio: comando NUNCA pode ser re-entregue -> vira incerto!
      await comoAdmin(() =>
        banco.db.exec(`update public.local_motor_commands set lease_until = now() - interval '1 minute' where id = '${envio.command_id}'`),
      );
      const aposExpirar = await comoServico(() =>
        chamar<{ commands: Array<{ id: string }> }>('claim_local_motor_commands', [TOKEN_HASH_1, 10]),
      );
      expect(aposExpirar.commands).toEqual([]);

      const msgEstado = await banco.db.query<{ status: string }>('select status from public.messages where id = $1', [
        envio.message_id,
      ]);
      expect(msgEstado.rows[0]!.status).toBe('awaiting_human_confirmation');

      // Novo envio confirmado normalmente + agendamento funcionando em chip Baileys.
      const envio2 = await chamar<{ message_id: string; command_id: string }>('start_my_text_message', [
        LOJA_A,
        recebida.conversation_id,
        'Segunda resposta local',
        'chave-local-envio-0002',
      ]);
      await comoServico(() => chamar('claim_local_motor_commands', [TOKEN_HASH_1, 10]));
      await comoServico(() =>
        chamar('complete_local_motor_command', [TOKEN_HASH_1, envio2.command_id, 'sent', 'WA-LOCAL-OUT-2', null]),
      );
      const msg2Estado = await banco.db.query<{ status: string; provider_message_id: string }>(
        'select status, provider_message_id from public.messages where id = $1',
        [envio2.message_id],
      );
      expect(msg2Estado.rows[0]).toEqual({ status: 'sent', provider_message_id: 'WA-LOCAL-OUT-2' });

      // Agendamento funciona no chip local!
      const agendada = await chamar<{ id: string }>('schedule_my_message', [
        LOJA_A,
        recebida.conversation_id,
        'Lembrete local',
        new Date(Date.now() - 10_000).toISOString(),
      ]);
      const devidas = await comoServico(() =>
        chamar<Array<{ scheduled_id: string; engine: string; command_id: string }>>('claim_due_scheduled_messages', [10]),
      );
      expect(devidas.some((d) => d.scheduled_id === agendada.id && d.engine === 'baileys')).toBe(true);

      // IA também enfileira em local_motor_commands!
      await comoAdmin(() =>
        banco.db.exec(`
          insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint)
          values ('${LOJA_A}', 'gemini', '${CIFRA('g')}', 'aB12')
          on conflict (workspace_id, provider) do nothing;
          insert into public.ai_agents(workspace_id, label, is_default)
          values ('${LOJA_A}', 'Principal Local', true);
        `),
      );
      await chamar('set_my_instance_ai', [LOJA_A, chipLocal.id, true]);
      const entradaIa = await comoServico(() =>
        chamar<{ result: string; ai: { scheduled: boolean; turn_id: string } }>('ingest_local_message', [
          TOKEN_HASH_1,
          chipLocal.id,
          'MSG-LOCAL-AI-1',
          '5586999112299@s.whatsapp.net',
          'Cliente IA',
          'Qual o valor?',
          new Date().toISOString(),
          false,
          null,
        ]),
      );
      expect(entradaIa.ai.scheduled).toBe(true);
      await comoAdmin(() =>
        banco.db.exec(`update public.ai_turns set due_at = clock_timestamp() - interval '1 second' where id = '${entradaIa.ai.turn_id}'`),
      );
      await comoServico(() => chamar('claim_ai_turn', [LOJA_A, entradaIa.ai.turn_id, null]));
      const parteIa = await comoServico(() =>
        chamar<{ result: string; command_id: string }>('start_ai_message', [LOJA_A, entradaIa.ai.turn_id, 1, 'Custa R$ 50!']),
      );
      expect(parteIa.result).toBe('queued_local');

      // Revogação corta acesso imediatamente.
      await chamar('revoke_my_local_executor', [LOJA_A, pareamento.id]);
      const aposRevogar = await comoServico(() =>
        chamar<{ result: string }>('authenticate_local_executor_heartbeat', [TOKEN_HASH_1, 'linux', '6.0.0', {}]),
      );
      expect(aposRevogar.result).toBe('unauthorized');

      // Remove instância A vazia para deixar cenário limpo? Cada test roda em transação rollback!
      expect(CHIP_A).toBeTruthy();
      expect(CONTATO_A).toBeTruthy();
      expect(CONVERSA_A).toBeTruthy();
    });
  });
});
