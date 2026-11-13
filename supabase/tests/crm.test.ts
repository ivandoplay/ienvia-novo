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
  SUSPENSO_A,
  bancoComCenario,
} from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await bancoComCenario();
});

const chamar = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
  const { rows } = await banco.db.query<{ r: T }>(sql, params);
  return rows[0]!.r;
};

async function emTransacao(fn: () => Promise<void>): Promise<void> {
  await banco.db.exec('begin');
  try {
    await fn();
  } finally {
    await banco.db.exec('rollback');
  }
}

async function comoUsuario<T>(usuarioId: string, fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('set local role authenticated');
  await banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [usuarioId]);
  await banco.db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
  try {
    return await fn();
  } finally {
    await banco.db.exec('reset role').catch(() => undefined);
  }
}

async function comoServico<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('set local role service_role');
  await banco.db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
  try {
    return await fn();
  } finally {
    await banco.db.exec('reset role').catch(() => undefined);
  }
}

describe('CRM completo — isolamento e permissões das novas tabelas', () => {
  test('visitantes e usuários sem permissão não leem nem escrevem direto nas tabelas do CRM', async () => {
    for (const tabela of ['crm_tags', 'contact_tags', 'conversation_notes', 'quick_replies', 'scheduled_messages']) {
      await banco.comoAnonimo(async () => {
        const erro = await banco.esperarErro(() => banco.db.query(`select * from public.${tabela}`));
        expect(erro).toMatch(/permission denied/);
      });
      await banco.comoUsuario(DONA_A, async () => {
        const erro = await banco.esperarErro(() => banco.db.query(`delete from public.${tabela}`));
        expect(erro).toMatch(/permission denied/);
      });
    }

    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(() => banco.db.query('select public.claim_due_scheduled_messages(10)'))).toMatch(/permission denied/);
      expect(
        await banco.esperarErro(() =>
          banco.db.query(`select public.finish_scheduled_message('${LOJA_A}', gen_random_uuid(), 'sent')`),
        ),
      ).toMatch(/permission denied/);
    });
  });

  test('cada empresa só enxerga os próprios catálogos, etiquetas e notas', async () => {
    await emTransacao(async () => {
      const tagA = await comoUsuario(DONA_A, () =>
        chamar<{ id: string }>(`select public.save_my_crm_tag($1, null, 'VIP', '#10b981') as r`, [LOJA_A]),
      );
      const tagB = await comoUsuario(DONO_B, () =>
        chamar<{ id: string }>(`select public.save_my_crm_tag($1, null, 'Atacado', '#3b82f6') as r`, [LOJA_B]),
      );

      await comoUsuario(ATENDENTE_A, () =>
        chamar(`select public.toggle_my_contact_tag($1, $2, $3, true) as r`, [LOJA_A, CONTATO_A, tagA.id]),
      );
      await comoUsuario(ATENDENTE_A, () =>
        chamar(`select public.add_my_conversation_note($1, $2, 'Cliente quer entrega rápida') as r`, [LOJA_A, CONVERSA_A]),
      );
      await comoUsuario(DONA_A, () =>
        chamar(`select public.save_my_quick_reply($1, null, '/pix', 'Chave PIX', 'Nossa chave é pix@loja.com') as r`, [LOJA_A]),
      );

      const catA = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ tags: Array<{ id: string }>; quick_replies: Array<{ shortcut: string }> }>(
          `select public.read_my_crm_catalogs($1) as r`,
          [LOJA_A],
        ),
      );
      expect(catA.tags.map((t) => t.id)).toEqual([tagA.id]);
      expect(catA.quick_replies.map((q) => q.shortcut)).toEqual(['pix']);

      const catB = await comoUsuario(DONO_B, () =>
        chamar<{ tags: Array<{ id: string }>; quick_replies: Array<{ shortcut: string }> }>(
          `select public.read_my_crm_catalogs($1) as r`,
          [LOJA_B],
        ),
      );
      expect(catB.tags.map((t) => t.id)).toEqual([tagB.id]);
      expect(catB.quick_replies).toEqual([]);

      for (const intruso of [DONO_B, INTRUSO, MASTER, SUSPENSO_A]) {
        await comoUsuario(intruso, async () => {
          expect(await banco.esperarErro(() => chamar(`select public.read_my_crm_catalogs($1) as r`, [LOJA_A]))).toMatch(
            /Workspace membership required/,
          );
          expect(
            await banco.esperarErro(() =>
              chamar(`select public.add_my_conversation_note($1, $2, 'Invasão') as r`, [LOJA_A, CONVERSA_A]),
            ),
          ).toMatch(/Workspace membership required/);
          expect(
            await banco.esperarErro(() => chamar(`select public.delete_my_contact_and_conversation($1, $2) as r`, [LOJA_A, CONTATO_A])),
          ).toMatch(/Workspace membership required/);
        });
      }
    });
  });
});

describe('CRM completo — etapas, valores R$, fixar, etiquetas, busca e Kanban', () => {
  test('negociação R$, etapa Kanban, fixar no topo, nota interna e filtro por etiqueta', async () => {
    await emTransacao(async () => {
      const versaoAntes = await comoUsuario(DONA_A, () =>
        chamar<string>(`select public.read_my_inbox_version($1) as r`, [LOJA_A]),
      );

      const tag = await comoUsuario(DONA_A, () =>
        chamar<{ id: string }>(`select public.save_my_crm_tag($1, null, 'Orçamento quente', '#f59e0b') as r`, [LOJA_A]),
      );
      await comoUsuario(DONA_A, () =>
        chamar(`select public.toggle_my_contact_tag($1, $2, $3, true) as r`, [LOJA_A, CONTATO_A, tag.id]),
      );

      await comoUsuario(ATENDENTE_A, () =>
        chamar(`select public.update_my_conversation_crm($1, $2, $3::jsonb) as r`, [
          LOJA_A,
          CONVERSA_A,
          JSON.stringify({
            crm_stage: 'proposta',
            deal_value: 2490.5,
            deal_status: 'won',
            is_pinned: true,
            follow_up_at: '2026-11-20T12:00:00Z',
          }),
        ]),
      );

      await comoUsuario(ATENDENTE_A, () =>
        chamar(`select public.add_my_conversation_note($1, $2, 'Fechamento confirmado por telefone') as r`, [LOJA_A, CONVERSA_A]),
      );

      const versaoDepois = await comoUsuario(DONA_A, () =>
        chamar<string>(`select public.read_my_inbox_version($1) as r`, [LOJA_A]),
      );
      expect(versaoDepois).not.toBe(versaoAntes);

      const conversa = await comoUsuario(DONA_A, () =>
        chamar<{
          conversation: {
            crm_stage: string;
            deal_value: number;
            deal_status: string;
            is_pinned: boolean;
            contact: { tags: Array<{ name: string }> };
          };
          notes: Array<{ body_text: string }>;
        }>(`select public.read_my_conversation($1, $2, 50) as r`, [LOJA_A, CONVERSA_A]),
      );

      expect(conversa.conversation.crm_stage).toBe('proposta');
      expect(Number(conversa.conversation.deal_value)).toBe(2490.5);
      expect(conversa.conversation.deal_status).toBe('won');
      expect(conversa.conversation.is_pinned).toBe(true);
      expect(conversa.conversation.contact.tags.map((t) => t.name)).toEqual(['Orçamento quente']);
      expect(conversa.notes.map((n) => n.body_text)).toEqual(['Fechamento confirmado por telefone']);

      const filtradaTag = await comoUsuario(DONA_A, () =>
        chamar<{ conversations: Array<{ id: string }> }>(
          `select public.read_my_crm_inbox($1, 'open', null, null, '{}', 40, $2, 'won', 'proposta') as r`,
          [LOJA_A, tag.id],
        ),
      );
      expect(filtradaTag.conversations.map((c) => c.id)).toEqual([CONVERSA_A]);

      const kanban = await comoUsuario(DONA_A, () =>
        chamar<{ cards: Array<{ id: string; crm_stage: string }> }>(`select public.read_my_kanban($1) as r`, [LOJA_A]),
      );
      expect(kanban.cards).toHaveLength(1);
      expect(kanban.cards[0]).toMatchObject({ id: CONVERSA_A, crm_stage: 'proposta' });

      const buscaGlobal = await comoUsuario(DONA_A, () =>
        chamar<{ conversations: Array<{ id: string }>; contacts: Array<{ id: string }> }>(
          `select public.global_search_my_workspace($1, 'Cliente da A', '{}') as r`,
          [LOJA_A],
        ),
      );
      expect(buscaGlobal.conversations.map((c) => c.id)).toEqual([CONVERSA_A]);
      expect(buscaGlobal.contacts.map((c) => c.id)).toEqual([CONTATO_A]);
    });
  });

  test('contato manual salvo na agenda é reaproveitado ao iniciar conversa manual no WhatsApp', async () => {
    await emTransacao(async () => {
      const salvo = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ id: string }>(`select public.save_my_contact($1, null, $2::jsonb) as r`, [
          LOJA_A,
          JSON.stringify({
            display_name: 'Carlos Ferreira',
            phone: '(86) 99988-7766',
            company: 'Auto Center',
            city: 'Teresina - PI',
            lead_source: 'Indicação',
            notes: 'Interessado no plano anual',
          }),
        ]),
      );

      const aberta = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ conversation_id: string; contact_id: string; created: boolean }>(
          `select public.start_or_open_my_conversation($1, $2, '86999887766', 'Carlos') as r`,
          [LOJA_A, CHIP_A],
        ),
      );
      expect(aberta.contact_id).toBe(salvo.id);
      expect(aberta.created).toBe(true);

      const reaberta = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ conversation_id: string; contact_id: string; created: boolean }>(
          `select public.start_or_open_my_conversation($1, $2, '+55 86 99988-7766') as r`,
          [LOJA_A, CHIP_A],
        ),
      );
      expect(reaberta.conversation_id).toBe(aberta.conversation_id);
      expect(reaberta.created).toBe(false);

      const dir = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ contacts: Array<{ id: string; company: string }>; total: number }>(
          `select public.read_my_contacts_directory($1, 'Auto Center', '{}', 'all', 50, 0) as r`,
          [LOJA_A],
        ),
      );
      expect(dir.total).toBe(1);
      expect(dir.contacts[0]).toMatchObject({ id: salvo.id, company: 'Auto Center' });
    });
  });
});

describe('CRM completo — Ignorar IA, Agendamentos, Lote e Exclusão auditada', () => {
  test('marcar Ignorar IA cancela vez pendente e bloqueia futuras respostas da IA', async () => {
    await emTransacao(async () => {
      await banco.db.query(`update public.instances set provider_instance_name = 'evo-a' where id = '${CHIP_A}'`);
      await banco.db.query(
        `insert into public.ai_agents(workspace_id, is_default, label, business_name) values ('${LOJA_A}', true, 'Atendente', 'Loja A')`,
      );
      await banco.db.query(
        `insert into public.ai_turns(workspace_id, conversation_id, instance_id, trigger_message_id, status, due_at)
         select '${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', id, 'waiting', now() + interval '5 seconds'
         from public.messages where conversation_id = '${CONVERSA_A}' limit 1`,
      );

      await comoUsuario(DONA_A, () =>
        chamar(`select public.update_my_contact_flags($1, $2, true, null) as r`, [LOJA_A, CONTATO_A]),
      );

      const { rows: turns } = await banco.db.query<{ status: string; outcome_detail: string }>(
        `select status, outcome_detail from public.ai_turns where conversation_id = '${CONVERSA_A}'`,
      );
      expect(turns).toEqual([{ status: 'skipped', outcome_detail: 'contact_ignored' }]);

      const motivo = await chamar<string | null>(`select private.ai_block_reason($1, $2) as r`, [LOJA_A, CONVERSA_A]);
      expect(motivo).toBe('contact_ignored');
    });
  });

  test('agendamento de mensagem: valida horário, entrega uma vez só via service_role e nunca duplica', async () => {
    await emTransacao(async () => {
      const passado = new Date(Date.now() - 10 * 60_000).toISOString();
      await comoUsuario(ATENDENTE_A, async () => {
        expect(
          await banco.esperarErro(() =>
            chamar(`select public.schedule_my_message($1, $2, 'Bom dia', $3::timestamptz) as r`, [LOJA_A, CONVERSA_A, passado]),
          ),
        ).toMatch(/invalid_schedule_time/);
      });

      const vencidoAgora = new Date(Date.now() - 5_000).toISOString();
      const criado = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ id: string; status: string }>(
          `select public.schedule_my_message($1, $2, 'Lembrete do seu atendimento', $3::timestamptz) as r`,
          [LOJA_A, CONVERSA_A, vencidoAgora],
        ),
      );
      expect(criado.status).toBe('pending');

      await banco.db.query(`update public.instances set provider_instance_name = 'evo-a' where id = '${CHIP_A}'`);
      const reivindicados = await comoServico(() =>
        chamar<Array<{ scheduled_id: string; message_id: string; provider_instance_name: string }>>(
          `select public.claim_due_scheduled_messages(10) as r`,
        ),
      );
      expect(reivindicados).toHaveLength(1);
      expect(reivindicados[0]!.scheduled_id).toBe(criado.id);
      expect(reivindicados[0]!.provider_instance_name).toBe('evo-a');

      const segundaTentativa = await comoServico(() =>
        chamar<unknown[]>(`select public.claim_due_scheduled_messages(10) as r`),
      );
      expect(segundaTentativa).toEqual([]);

      await comoServico(() =>
        banco.db.query(
          `select public.finish_scheduled_message($1, $2, 'sent', 'wamid-sched-1', null)`,
          [LOJA_A, criado.id],
        ),
      );
      const { rows } = await banco.db.query<{ status: string }>(
        `select status from public.scheduled_messages where id = $1`,
        [criado.id],
      );
      expect(rows[0]!.status).toBe('sent');
    });
  });

  test('ações em massa e exclusão de contato+conversa com trilha de auditoria', async () => {
    await emTransacao(async () => {
      const aberta = await comoUsuario(DONA_A, () =>
        chamar<{ conversation_id: string; contact_id: string }>(
          `select public.start_or_open_my_conversation($1, $2, '86977776666', 'Lead Temporário') as r`,
          [LOJA_A, CHIP_A],
        ),
      );
      const lote = await comoUsuario(DONA_A, () =>
        chamar<{ updated: number }>(`select public.bulk_update_my_conversations($1, $2::uuid[], 'set_crm_stage', $3::jsonb) as r`, [
          LOJA_A,
          [aberta.conversation_id, CONVERSA_B],
          JSON.stringify({ crm_stage: 'qualificando' }),
        ]),
      );
      expect(lote.updated).toBe(1);

      const apagado = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ deleted: boolean; conversations_deleted: number }>(
          `select public.delete_my_contact_and_conversation($1, $2) as r`,
          [LOJA_A, aberta.contact_id],
        ),
      );
      expect(apagado.deleted).toBe(true);
      expect(apagado.conversations_deleted).toBe(1);

      const { rows: audit } = await banco.db.query<{ actor_user_id: string; action: string }>(
        `select actor_user_id::text, action from private.audit_events
         where workspace_id = $1 and action = 'contact_and_conversation_deleted' and target_id = $2`,
        [LOJA_A, aberta.contact_id],
      );
      expect(audit).toEqual([{ actor_user_id: ATENDENTE_A, action: 'contact_and_conversation_deleted' }]);
    });
  });
});
