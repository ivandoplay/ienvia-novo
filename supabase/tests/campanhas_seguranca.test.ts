import { createHash } from 'node:crypto';
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

async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('reset role');
  return fn();
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

describe('Segurança & Campanhas — RLS, isolamento e permissões', () => {
  test('visitantes não leem nem escrevem em nenhuma tabela ou função nova; membros não deletam direto', async () => {
    const tabelas = [
      'security_ignored_numbers',
      'proactive_queue_state',
      'proactive_queue_items',
      'campaign_media_folders',
      'campaign_media_files',
      'campaign_step_deliveries',
    ];
    for (const tabela of tabelas) {
      await banco.comoAnonimo(async () => {
        expect(await banco.esperarErro(() => banco.db.query(`select * from public.${tabela}`))).toMatch(/permission denied/);
      });
      await banco.comoUsuario(DONA_A, async () => {
        expect(await banco.esperarErro(() => banco.db.query(`delete from public.${tabela}`))).toMatch(/permission denied/);
      });
    }

    await banco.comoUsuario(DONA_A, async () => {
      for (const rpc of [
        'select public.claim_due_proactive_items(5)',
        'select public.claim_due_campaign_steps(5)',
        'select public.sweep_stuck_campaign_steps()',
        `select public.apply_evolution_message_status('x','${'0'.repeat(64)}','[]'::jsonb)`,
        `select public.enqueue_workspace_admin_alert('${LOJA_A}','chip_disconnected','oi',null,null,null)`,
      ]) {
        expect(await banco.esperarErro(() => banco.db.query(rpc))).toMatch(/permission denied/);
      }
    });
  });

  test('só a dona altera regras de segurança; atendente lê e gerencia ignorados/campanhas da própria loja; intruso e outra loja são barrados', async () => {
    await emTransacao(async () => {
      const erroAtendente = await comoUsuario(ATENDENTE_A, () =>
        banco.esperarErro(() =>
          banco.db.query('select public.save_my_security_settings($1,$2::jsonb)', [
            LOJA_A,
            JSON.stringify({ antiban_preset: 'conservador' }),
          ]),
        ),
      );
      expect(erroAtendente).toMatch(/Workspace owner required/);

      const leituraAtendente = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ can_edit: boolean; antiban_preset: string }>('select public.read_my_security_settings($1) as r', [LOJA_A]),
      );
      expect(leituraAtendente).toMatchObject({ can_edit: false, antiban_preset: 'equilibrado' });

      const erroIntruso = await comoUsuario(INTRUSO, () =>
        banco.esperarErro(() => banco.db.query('select public.list_my_campaigns($1)', [LOJA_A])),
      );
      expect(erroIntruso).toMatch(/Workspace membership required/);

      const erroSuspenso = await comoUsuario(SUSPENSO_A, () =>
        banco.esperarErro(() => banco.db.query('select public.list_my_ignored_numbers($1)', [LOJA_A])),
      );
      expect(erroSuspenso).toMatch(/Workspace membership required/);

      const folderA = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ id: string }>(`select public.create_my_campaign_media_folder($1,'Fotos Promo','image') as r`, [LOJA_A]),
      );
      const listaB = await comoUsuario(DONO_B, () =>
        chamar<{ folders: unknown[] }>('select public.list_my_campaign_media($1) as r', [LOJA_B]),
      );
      expect(listaB.folders).toHaveLength(0);
      expect(folderA.id).toBeTruthy();
    });
  });
});

describe('Segurança Anti-Bloqueio, Horário de Atendimento e Ignorados', () => {
  test('contatos ignorados normalizam 8/9 dígitos do Brasil e bloqueiam IA sem mexer em read_my_ai_settings', async () => {
    await emTransacao(async () => {
      await comoAdmin(() => banco.db.query(`update public.instances set provider_instance_name = 'evo-ign' where id = $1`, [CHIP_A]));
      const aiAntes = await comoUsuario(DONA_A, () => chamar<Record<string, unknown>>('select public.read_my_ai_settings($1) as r', [LOJA_A]));

      await comoUsuario(DONA_A, () =>
        chamar('select public.save_my_security_settings($1,$2::jsonb) as r', [
          LOJA_A,
          JSON.stringify({
            antiban_preset: 'conservador',
            min_typing_ms: 2500,
            max_typing_ms: 6000,
            max_replies_per_minute_per_contact: 4,
            proactive_min_delay_sec: 60,
            proactive_max_delay_sec: 150,
            daily_proactive_limit: 15,
            schedule_mode: 'always',
          }),
        ]),
      );

      const aiDepois = await comoUsuario(DONA_A, () => chamar<Record<string, unknown>>('select public.read_my_ai_settings($1) as r', [LOJA_A]));
      expect(Object.keys(aiDepois).sort()).toEqual(Object.keys(aiAntes).sort());

      // Contato A tem telefone +5586900000001; vamos ignorar sem o 9 ((86) 0000-0001 => 558600000001) e checar bloqueio da IA.
      const lista = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ manual: Array<{ id: string; phone_digits: string }>; contacts: Array<{ contact_id: string }> }>(
          `select public.add_my_ignored_number($1,'Fornecedor Teste','(86) 0000-0001','Não responder') as r`,
          [LOJA_A],
        ),
      );
      expect(lista.manual).toHaveLength(1);
      expect(lista.manual[0]!.phone_digits).toBe('558600000001');
      expect(lista.contacts.some((c) => c.contact_id === CONTATO_A)).toBe(true);

      const block = await comoAdmin(() =>
        chamar<string | null>('select private.ai_block_reason($1,$2) as r', [LOJA_A, CONVERSA_A]),
      );
      expect(block).toBe('contact_ignored');

      await comoUsuario(ATENDENTE_A, () =>
        chamar('select public.remove_my_ignored_number($1,$2,null) as r', [LOJA_A, lista.manual[0]!.id]),
      );
      const blockDepois = await comoAdmin(() =>
        chamar<string | null>('select private.ai_block_reason($1,$2) as r', [LOJA_A, CONVERSA_A]),
      );
      expect(blockDepois).toBeNull();
    });
  });

  test('fora do horário bloqueia IA e envia resposta automática única no período de 6h', async () => {
    await emTransacao(async () => {
      // Coloca chip com IA ligada + agente padrão para testar agendamento.
      await comoServico(async () => {
        const res = await banco.db.query<{ id: string }>(
          `insert into public.ai_agents(workspace_id, label, is_default, business_name, assistant_name)
           values ($1,'Atendente Teste',true,'Loja A','Ana') returning id`,
          [LOJA_A],
        );
        await banco.db.query(`update public.instances set is_enabled = true, ai_agent_id = $2 where id = $1`, [CHIP_A, res.rows[0]!.id]);
        await banco.db.query(
          `insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint, updated_by)
           values ($1,'gemini',$2,'...1234',null)
           on conflict (workspace_id, provider) do nothing`,
          [LOJA_A, `v1.${'i'.repeat(16)}.${'t'.repeat(22)}.${'a'.repeat(24)}`],
        );
      });

      // Janela sem nenhum dia ativo => sempre fora do horário.
      await comoUsuario(DONA_A, () =>
        chamar('select public.save_my_security_settings($1,$2::jsonb) as r', [
          LOJA_A,
          JSON.stringify({
            schedule_mode: 'business_hours_only',
            schedule_work_days: [],
            off_hours_reply_message: 'Estamos fechados agora, retornamos às 08h.',
          }),
        ]),
      );

      await comoServico(async () => {
        const segredo = createHash('sha256').update('segredo-offhours').digest('hex');
        await banco.db.query(
          `insert into private.evolution_webhook_auth(workspace_id, instance_id, token_sha256)
           values ($1,$2,$3) on conflict (instance_id) do update set token_sha256 = excluded.token_sha256`,
          [LOJA_A, CHIP_A, segredo],
        );
        await banco.db.query(`update public.instances set provider_instance_name = 'evo-offhours' where id = $1`, [CHIP_A]);

        const first = await chamar<{
          ai?: { scheduled: boolean; reason: string; off_hours_reply?: { body_text: string; message_id: string } };
        }>(
          `select public.ingest_evolution_text('evo-offhours',$1,'ev-off-1','MESSAGES_UPSERT','5586999990001@s.whatsapp.net','Cliente','Oi',now(),false) as r`,
          [segredo],
        );
        expect(first.ai?.scheduled).toBe(false);
        expect(first.ai?.reason).toBe('outside_hours');
        expect(first.ai?.off_hours_reply?.body_text).toBe('Estamos fechados agora, retornamos às 08h.');

        // Segunda mensagem dentro de 6h não repete o aviso de ausência.
        const second = await chamar<{
          ai?: { scheduled: boolean; reason: string; off_hours_reply?: unknown };
        }>(
          `select public.ingest_evolution_text('evo-offhours',$1,'ev-off-2','MESSAGES_UPSERT','5586999990001@s.whatsapp.net','Cliente','Tem alguém?',now(),false) as r`,
          [segredo],
        );
        expect(second.ai?.scheduled).toBe(false);
        expect(second.ai?.reason).toBe('outside_hours');
        expect(second.ai?.off_hours_reply).toBeUndefined();
      });
    });
  });
});

describe('Fila Segura (abordagem ativa anti-bloqueio)', () => {
  test('suprime ignorados/duplicados, executa Evolution e pausa para humano em caso incerto sem reenviar', async () => {
    await emTransacao(async () => {
      await comoServico(() =>
        banco.db.query(`update public.instances set purpose = 'both', provider_instance_name = 'evo-fila-a' where id = $1`, [CHIP_A]),
      );

      await comoUsuario(ATENDENTE_A, () =>
        chamar(`select public.add_my_ignored_number($1,'Ignorado','5586988881111','') as r`, [LOJA_A]),
      );

      const start = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ eligible: number; suppressed: number }>(
          'select public.start_my_proactive_queue($1,$2,$3,$4,$5::jsonb) as r',
          [
            LOJA_A,
            'single',
            CHIP_A,
            'Oi {{primeiro_nome}}, tudo bem?',
            JSON.stringify([
              { name: 'Ana Maria', phone: '86999112233' },
              { name: 'Ana Duplicada', phone: '558699112233' },
              { name: 'Ignorado', phone: '5586988881111' },
            ]),
          ],
        ),
      );
      expect(start).toEqual({ eligible: 1, suppressed: 2 });

      const claimed = await comoServico(() =>
        chamar<Array<{ item_id: string; body_text: string; engine: string }>>('select public.claim_due_proactive_items(5) as r'),
      );
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.engine).toBe('evolution');
      expect(claimed[0]!.body_text).toBe('Oi Ana, tudo bem?');

      // Marca como incerto => fila pausa automaticamente e impede Retomar até resolução humana.
      const finish = await comoServico(() =>
        chamar<{ alert_uncertain: boolean }>(
          `select public.finish_proactive_item($1,$2,'uncertain',null,'timeout') as r`,
          [LOJA_A, claimed[0]!.item_id],
        ),
      );
      expect(finish.alert_uncertain).toBe(true);

      const errResume = await comoUsuario(ATENDENTE_A, () =>
        banco.esperarErro(() => banco.db.query('select public.resume_my_proactive_queue($1)', [LOJA_A])),
      );
      expect(errResume).toMatch(/uncertain_send_pending/);

      const afterResolve = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ state: { status: string }; counts: { sent: number } }>(
          'select public.resolve_my_proactive_uncertain($1,$2,true) as r',
          [LOJA_A, claimed[0]!.item_id],
        ),
      );
      expect(afterResolve.counts.sent).toBe(1);
    });
  });
});

describe('Pastas de Mídia, Campanhas Multi-Bloco, Baileys + Evolution e Rastreio', () => {
  test('exige prévia antes de confirmar, envia blocos em Baileys com is_voice e atualiza entregue/lido/respondido', async () => {
    await emTransacao(async () => {
      // Cria pasta de áudio e pasta de imagem e registra arquivo (checando upload storage policy).
      const folderAudio = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ id: string }>(`select public.create_my_campaign_media_folder($1,'Áudios Oferta','audio') as r`, [LOJA_A]),
      );
      const fileId = '11111111-1111-4111-8111-111111111111';
      const objKey = `${LOJA_A}/campanhas/${folderAudio.id}/${fileId}/audio_01.ogg`;

      const podeSubir = await comoUsuario(ATENDENTE_A, () =>
        chamar<boolean>('select private.can_upload_media_object($1) as r', [objKey]),
      );
      expect(podeSubir).toBe(true);

      const naoPodeOutro = await comoUsuario(DONO_B, () =>
        chamar<boolean>('select private.can_upload_media_object($1) as r', [objKey]),
      );
      expect(naoPodeOutro).toBe(false);

      await comoUsuario(ATENDENTE_A, () =>
        chamar(
          'select public.register_my_campaign_media_file($1,$2,$3,$4,$5,$6,$7) as r',
          [LOJA_A, folderAudio.id, fileId, objKey, 'audio_01.ogg', 'audio/ogg; codecs=opus', 4096],
        ),
      );

      // Pareia motor local e cria chip Baileys usando as RPCs reais da Fase 4.
      const codeSha = createHash('sha256').update('code-phase5-test').digest('hex');
      const localToken = 'motor-local-phase5-token';
      const localSha = createHash('sha256').update(localToken).digest('hex');
      await comoServico(() =>
        banco.db.query(`update public.workspaces set max_instances = 5 where id = $1`, [LOJA_A]),
      );
      const pareamento = await comoUsuario(DONA_A, () =>
        chamar<{ id: string }>(`select public.create_my_local_executor_pairing($1,'Motor Loja A',$2) as r`, [LOJA_A, codeSha]),
      );
      await comoServico(() =>
        chamar(`select public.pair_local_executor_by_code($1,$2,'linux','6.0.0','{}'::jsonb) as r`, [codeSha, localSha]),
      );
      const createdLocal = await comoUsuario(DONA_A, () =>
        chamar<{ id: string }>(`select public.create_my_local_instance($1,'Chip Baileys Campanha','campaigns',$2) as r`, [
          LOJA_A,
          pareamento.id,
        ]),
      );
      const chipBaileys = createdLocal.id;
      await comoServico(() =>
        chamar(`select public.report_local_instance_state($1,$2,'connected','+5586981112233',null,null) as r`, [
          localSha,
          chipBaileys,
        ]),
      );

      const blocks = [
        { type: 'text', mode: 'manual', texts: ['Oi {{primeiro_nome}}, temos novidade!'] },
        { type: 'audio', folder_id: folderAudio.id, mode: 'round_robin', is_voice: false },
      ];
      const cadence = {
        intervalMinSec: 20,
        intervalMaxSec: 30,
        stepIntervalSec: 3,
        batchMin: 5,
        batchMax: 10,
        batchPauseMinSec: 60,
        batchPauseMaxSec: 90,
        dailyLimitPerChip: 50,
        restrictHours: false,
        windowStart: '08:00',
        windowEnd: '19:00',
        workDays: [1, 2, 3, 4, 5, 6],
        timezone: 'America/Fortaleza',
      };

      const draft = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ campaign: { id: string; status: string }; stats: { eligible: number } }>(
          'select public.save_my_campaign_draft($1,null,$2,$3,$4::uuid[],$5::jsonb,$6::jsonb,$7::jsonb,null) as r',
          [
            LOJA_A,
            'Campanha Outubro',
            'fixed',
            [chipBaileys],
            JSON.stringify(blocks),
            JSON.stringify(cadence),
            JSON.stringify([{ name: 'Carlos Alberto', phone: '5586994445566', fields: { cidade: 'Piracuruca' } }]),
          ],
        ),
      );
      expect(draft.campaign.status).toBe('draft');
      expect(draft.stats.eligible).toBe(1);

      // Sem prévia não confirma.
      const errNoPreview = await comoUsuario(ATENDENTE_A, () =>
        banco.esperarErro(() => banco.db.query('select public.confirm_my_campaign($1,$2,null)', [LOJA_A, draft.campaign.id])),
      );
      expect(errNoPreview).toMatch(/preview_required_before_confirm/);

      await comoUsuario(ATENDENTE_A, () =>
        chamar('select public.prepare_my_campaign_preview($1,$2) as r', [LOJA_A, draft.campaign.id]),
      );
      await comoUsuario(ATENDENTE_A, () =>
        chamar('select public.confirm_my_campaign($1,$2,null) as r', [LOJA_A, draft.campaign.id]),
      );

      // Passo 0 (texto) via Baileys
      const step0 = await comoServico(() =>
        chamar<Array<{ delivery_id: string; step_index: number }>>('select public.claim_due_campaign_steps(5) as r'),
      );
      expect(step0).toHaveLength(1);
      expect(step0[0]!.step_index).toBe(0);

      const disp0 = await comoServico(() =>
        chamar<{ result: string; command_id: string }>(
          `select public.dispatch_claimed_campaign_step($1,$2,'Oi Carlos, temos novidade!',null,false) as r`,
          [LOJA_A, step0[0]!.delivery_id],
        ),
      );
      expect(disp0.result).toBe('queued_local');

      await comoServico(() =>
        chamar(
          `select public.complete_local_motor_command($1,$2,'sent','bai-msg-01',null) as r`,
          [localSha, disp0.command_id],
        ),
      );

      // Libera próximo passo imediatamente e testa áudio com is_voice = false (arquivo normal, sem PTT)
      await comoServico(() =>
        banco.db.query(`update public.campaigns set next_action_at = now() - interval '1 second' where id = $1`, [draft.campaign.id]),
      );

      const step1 = await comoServico(() =>
        chamar<Array<{ delivery_id: string; step_index: number }>>('select public.claim_due_campaign_steps(5) as r'),
      );
      expect(step1).toHaveLength(1);
      expect(step1[0]!.step_index).toBe(1);

      const disp1 = await comoServico(() =>
        chamar<{ result: string; command_id: string }>(
          `select public.dispatch_claimed_campaign_step($1,$2,null,$3,false) as r`,
          [LOJA_A, step1[0]!.delivery_id, fileId],
        ),
      );
      expect(disp1.result).toBe('queued_local');

      const claimedCmds = await comoServico(() =>
        chamar<{ commands: Array<{ id: string; command_type: string; attachment: { is_voice: boolean } }> }>(
          'select public.claim_local_motor_commands($1,5) as r',
          [localSha],
        ),
      );
      expect(claimedCmds.commands).toHaveLength(1);
      expect(claimedCmds.commands[0]!.command_type).toBe('send_media');
      expect(claimedCmds.commands[0]!.attachment.is_voice).toBe(false);

      await comoServico(() =>
        chamar(
          `select public.complete_local_motor_command($1,$2,'sent','bai-msg-02',null) as r`,
          [localSha, disp1.command_id],
        ),
      );

      const campFinal = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ campaign: { status: string }; stats: { sent: number; replied: number } }>(
          'select public.read_my_campaign($1,$2) as r',
          [LOJA_A, draft.campaign.id],
        ),
      );
      expect(campFinal.campaign.status).toBe('completed');
      expect(campFinal.stats.sent).toBe(1);

      // Agora cliente responde pelo Baileys => replied aumenta automaticamente!
      await comoServico(() =>
        chamar(
          `select public.ingest_local_message($1,$2,'in-reply-1','5586994445566@s.whatsapp.net','Carlos','Quero sim!',now(),false,null) as r`,
          [localSha, chipBaileys],
        ),
      );

      const campReplied = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ stats: { replied: number } }>('select public.read_my_campaign($1,$2) as r', [LOJA_A, draft.campaign.id]),
      );
      expect(campReplied.stats.replied).toBe(1);
    });
  });

  test('rastreio Evolution MESSAGES_UPDATE marca delivered/read e alerta de desconexão envia sem criar conversa na Inbox', async () => {
    await emTransacao(async () => {
      const segredo = createHash('sha256').update('segredo-camp-track').digest('hex');
      await comoServico(async () => {
        await banco.db.query(
          `insert into private.evolution_webhook_auth(workspace_id, instance_id, token_sha256)
           values ($1,$2,$3) on conflict (instance_id) do update set token_sha256 = excluded.token_sha256`,
          [LOJA_A, CHIP_A, segredo],
        );
        await banco.db.query(`update public.instances set purpose = 'both', provider_instance_name = 'evo-track' where id = $1`, [CHIP_A]);
      });

      const draft = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ campaign: { id: string } }>(
          'select public.save_my_campaign_draft($1,null,$2,$3,$4::uuid[],$5::jsonb,$6::jsonb,$7::jsonb,null) as r',
          [
            LOJA_A,
            'Track Evolution',
            'fixed',
            [CHIP_A],
            JSON.stringify([{ type: 'text', mode: 'manual', texts: ['Olá {{nome}}'] }]),
            JSON.stringify({}),
            JSON.stringify([{ name: 'João', phone: '5586995556677', fields: {} }]),
          ],
        ),
      );
      await comoUsuario(ATENDENTE_A, () =>
        chamar('select public.prepare_my_campaign_preview($1,$2) as r', [LOJA_A, draft.campaign.id]),
      );
      await comoUsuario(ATENDENTE_A, () =>
        chamar('select public.confirm_my_campaign($1,$2,null) as r', [LOJA_A, draft.campaign.id]),
      );

      const steps = await comoServico(() => chamar<Array<{ delivery_id: string }>>('select public.claim_due_campaign_steps(5) as r'));
      await comoServico(() =>
        chamar(`select public.dispatch_claimed_campaign_step($1,$2,'Olá João',null,false) as r`, [LOJA_A, steps[0]!.delivery_id]),
      );
      await comoServico(() =>
        chamar(`select public.finish_campaign_step_delivery($1,$2,'sent','evo-msg-track-1',null) as r`, [LOJA_A, steps[0]!.delivery_id]),
      );

      await comoServico(() =>
        chamar(`select public.apply_evolution_message_status('evo-track',$1,$2::jsonb) as r`, [
          segredo,
          JSON.stringify([{ provider_message_id: 'evo-msg-track-1', status: 'read' }]),
        ]),
      );

      const tracked = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ stats: { delivered: number; read: number } }>('select public.read_my_campaign($1,$2) as r', [LOJA_A, draft.campaign.id]),
      );
      expect(tracked.stats.delivered).toBe(1);
      expect(tracked.stats.read).toBe(1);

      // Configura alerta admin para chip_disconnected e aciona desconexão.
      await comoUsuario(DONA_A, () =>
        chamar('select public.save_my_security_settings($1,$2::jsonb) as r', [
          LOJA_A,
          JSON.stringify({
            admin_alert_enabled: true,
            admin_alert_whatsapp: '5586997778888',
            admin_alert_events: ['chip_disconnected', 'campaign_uncertain'],
          }),
        ]),
      );

      const connUpd = await comoServico(() =>
        chamar<{ alert_disconnected: boolean }>(
          `select public.apply_evolution_connection_update('evo-track',$1,'close',null) as r`,
          [segredo],
        ),
      );
      expect(connUpd.alert_disconnected).toBe(true);
    });
  });
});
