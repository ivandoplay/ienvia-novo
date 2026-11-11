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
  MASTER,
  bancoComCenario,
} from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await bancoComCenario();
});

const executar = (sql: string) => () => banco.db.query(sql);

describe('o que o navegador NÃO pode fazer direto no banco', () => {
  test('não cria empresa nem se coloca dentro de uma', async () => {
    await banco.comoUsuario(INTRUSO, async () => {
      expect(await banco.esperarErro(executar(`insert into public.workspaces (name) values ('Empresa pirata')`))).toMatch(/permission denied/);
      expect(
        await banco.esperarErro(
          executar(`insert into public.workspace_memberships (workspace_id, user_id, role, status) values ('${LOJA_A}', '${INTRUSO}', 'owner', 'active')`),
        ),
      ).toMatch(/permission denied/);
    });
  });

  test('não se promove a administrador da plataforma', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(executar(`insert into private.platform_admins (user_id) values ('${DONA_A}')`))).toMatch(/permission denied/);
      expect(await banco.esperarErro(executar('select * from private.audit_events'))).toMatch(/permission denied/);
    });
  });

  test('não grava mensagem, chip ou envio por conta própria (isso é trabalho do servidor)', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(
        await banco.esperarErro(
          executar(`insert into public.messages (workspace_id, conversation_id, instance_id, direction, source_engine, actor_type, status, body_text, occurred_at)
                    values ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'outbound', 'system', 'human', 'sent', 'forjada', now())`),
        ),
      ).toMatch(/permission denied/);
      expect(
        await banco.esperarErro(
          executar(`insert into public.instances (workspace_id, channel, engine, display_name) values ('${LOJA_A}', 'whatsapp', 'baileys', 'Chip pirata')`),
        ),
      ).toMatch(/permission denied/);
      expect(await banco.esperarErro(executar(`update public.instances set is_enabled = true where id = '${CHIP_A}'`))).toMatch(/permission denied/);
      expect(await banco.esperarErro(executar('select * from public.outbox_jobs'))).toMatch(/permission denied/);
      expect(await banco.esperarErro(executar('select * from public.webhook_events'))).toMatch(/permission denied/);
    });
  });

  test('não apaga contato, conversa nem mensagem', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      for (const tabela of ['contacts', 'conversations', 'messages', 'campaigns', 'instances']) {
        expect(await banco.esperarErro(executar(`delete from public.${tabela}`))).toMatch(/permission denied/);
      }
    });
  });

  test('não move um contato ou conversa para outra empresa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(executar(`update public.contacts set workspace_id = '${LOJA_B}' where id = '${CONTATO_A}'`))).toMatch(/permission denied/);
      expect(await banco.esperarErro(executar(`update public.conversations set workspace_id = '${LOJA_B}' where id = '${CONVERSA_A}'`))).toMatch(/permission denied/);
    });
  });

  test('alterar a conversa de outra empresa não tem efeito', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const resultado = await banco.db.query(`update public.conversations set stage = 'resolved' where id = '${CONVERSA_B}'`);
      expect(resultado.affectedRows).toBe(0);
    });
    const depois = await banco.db.query<{ stage: string }>(`select stage from public.conversations where id = '${CONVERSA_B}'`);
    expect(depois.rows[0]?.stage).toBe('new');
  });

  test('não cadastra contato dentro de outra empresa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(
        await banco.esperarErro(executar(`insert into public.contacts (workspace_id, channel, display_name) values ('${LOJA_B}', 'manual', 'Infiltrado')`)),
      ).toMatch(/row-level security/);
    });
  });
});

describe('o que cada pessoa PODE fazer', () => {
  test('a equipe cadastra e corrige contatos da própria empresa', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await banco.db.query(`insert into public.contacts (workspace_id, channel, display_name, phone_e164) values ('${LOJA_A}', 'manual', 'Novo cliente', '+5586911112222')`);
      await banco.db.query(`update public.contacts set display_name = 'Cliente corrigido' where id = '${CONTATO_A}'`);
      const r = await banco.db.query<{ n: number }>(`select count(*)::int as n from public.contacts where workspace_id = '${LOJA_A}'`);
      expect(r.rows[0]?.n).toBe(2);
    });
  });

  test('só a dona muda o nome da empresa', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      const r = await banco.db.query(`update public.workspaces set name = 'Nome da atendente' where id = '${LOJA_A}'`);
      expect(r.affectedRows).toBe(0);
    });
    await banco.comoUsuario(DONA_A, async () => {
      const r = await banco.db.query(`update public.workspaces set name = 'Loja A Renovada' where id = '${LOJA_A}'`);
      expect(r.affectedRows).toBe(1);
      // ...mas não muda a situação (ativa/encerrada), que é decisão da plataforma.
      expect(await banco.esperarErro(executar(`update public.workspaces set status = 'closed' where id = '${LOJA_A}'`))).toMatch(/permission denied/);
    });
  });

  test('"assumir a conversa" pausa a IA e registra quem assumiu', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      const r = await banco.db.query<{ resultado: { stage: string; automation_paused: boolean; assigned_user_id: string } }>(
        `select public.transition_workspace_conversation('${LOJA_A}', '${CONVERSA_A}', 'claim') as resultado`,
      );
      expect(r.rows[0]?.resultado).toMatchObject({ stage: 'human', automation_paused: true, assigned_user_id: ATENDENTE_A });
    });
  });

  test('ninguém de fora assume conversa de outra empresa', async () => {
    for (const usuario of [DONO_B, INTRUSO, MASTER]) {
      await banco.comoUsuario(usuario, async () => {
        expect(
          await banco.esperarErro(executar(`select public.transition_workspace_conversation('${LOJA_A}', '${CONVERSA_A}', 'claim')`)),
        ).toMatch(/Workspace membership required/);
      });
    }
  });

  test('só a dona cadastra um chip — e ele nasce desligado, sem IA respondendo', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      expect(
        await banco.esperarErro(executar(`select public.register_my_evolution_instance('${LOJA_A}', 'Chip da atendente', 'zap-ia-teste-slot_2')`)),
      ).toMatch(/Workspace owner required/);
    });
    await banco.comoUsuario(DONA_A, async () => {
      const r = await banco.db.query<{ resultado: { status: string; is_enabled: boolean; engine: string } }>(
        `select public.register_my_evolution_instance('${LOJA_A}', 'Chip novo', 'zap-ia-teste-slot_2') as resultado`,
      );
      expect(r.rows[0]?.resultado).toMatchObject({ status: 'disconnected', is_enabled: false, engine: 'evolution' });
    });
  });

  test('só o administrador da plataforma é reconhecido como master', async () => {
    const souMaster = async () => (await banco.db.query<{ sim: boolean }>('select public.is_my_platform_master() as sim')).rows[0]?.sim;
    expect(await banco.comoUsuario(MASTER, souMaster)).toBe(true);
    expect(await banco.comoUsuario(DONA_A, souMaster)).toBe(false);
    expect(await banco.comoUsuario(INTRUSO, souMaster)).toBe(false);
  });

  test('cada pessoa só lê e edita o próprio perfil', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await banco.db.query(`insert into public.profiles (id, display_name) values ('${DONA_A}', 'Dona Maria')`);
      expect(
        await banco.esperarErro(executar(`insert into public.profiles (id, display_name) values ('${DONO_B}', 'Nome trocado')`)),
      ).toMatch(/row-level security/);
    });
  });
});

describe('o servidor', () => {
  test('receber mensagem da Evolution é função só do servidor', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const erro = await banco.esperarErro(
        executar(
          `select public.ingest_evolution_text('zap-ia-teste-slot_1', 'hash', 'evento-1', 'messages.upsert', '5586900000001@s.whatsapp.net', 'Cliente', 'mensagem forjada', now(), false)`,
        ),
      );
      expect(erro).toMatch(/permission denied/);
    });
  });
});
