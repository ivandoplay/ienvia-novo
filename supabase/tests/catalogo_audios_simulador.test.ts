import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import {
  ATENDENTE_A,
  CHIP_A,
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

async function esperandoErro<T>(fn: () => Promise<T>): Promise<unknown> {
  await banco.db.exec('savepoint sp_teste');
  try {
    await fn();
    await banco.db.exec('release savepoint sp_teste');
    throw new Error('Esperava erro, mas a chamada passou.');
  } catch (err) {
    await banco.db.exec('rollback to savepoint sp_teste');
    await banco.db.exec('release savepoint sp_teste');
    return err;
  }
}

async function inserirStorageDummy(objectKey: string, mimetype: string, size = 1234): Promise<void> {
  await comoAdmin(async () => {
    await banco.db.query(
      `insert into storage.objects(bucket_id, name, owner, metadata)
       values ('midias', $1::text, $2::uuid, jsonb_build_object('mimetype', $3::text, 'size', $4::bigint))
       on conflict (bucket_id, name) do nothing`,
      [objectKey, DONA_A, mimetype, size],
    );
  });
}

describe('Fase 6: Catálogo, PIX, Áudios e Simulador no banco', () => {
  test('PIX settings: dono salva, membro lê e visitante/outra empresa não acessam', async () => {
    await emTransacao(async () => {
      const inicial = await comoUsuario(ATENDENTE_A, () =>
        chamar<Record<string, unknown>>('select public.read_my_pix_settings($1) as r', [LOJA_A]),
      );
      expect(inicial.enabled).toBe(false);

      // Membro comum não salva PIX (apenas dono).
      const errMembro = await esperandoErro(() =>
        comoUsuario(ATENDENTE_A, () =>
          chamar('select public.save_my_pix_settings($1, $2::jsonb) as r', [
            LOJA_A,
            JSON.stringify({ enabled: true, key_type: 'email', pix_key: 'pix@loja.com' }),
          ]),
        ),
      );
      expect(String(errMembro)).toMatch(/Workspace owner required/);

      // Dono não pode habilitar sem chave.
      const errSemChave = await esperandoErro(() =>
        comoUsuario(DONA_A, () =>
          chamar('select public.save_my_pix_settings($1, $2::jsonb) as r', [
            LOJA_A,
            JSON.stringify({ enabled: true, key_type: 'email', pix_key: '' }),
          ]),
        ),
      );
      expect(String(errSemChave)).toMatch(/pix_key required/);

      const salvo = await comoUsuario(DONA_A, () =>
        chamar<Record<string, unknown>>('select public.save_my_pix_settings($1, $2::jsonb) as r', [
          LOJA_A,
          JSON.stringify({
            enabled: true,
            key_type: 'celular',
            pix_key: '86999887766',
            receiver_name: 'Loja A Ltda',
            bank_name: 'Nubank',
            city: 'Piracuruca',
          }),
        ]),
      );
      expect(salvo.enabled).toBe(true);
      expect(salvo.pix_key).toBe('86999887766');

      // Outra empresa e intruso são bloqueados.
      const errOutro = await esperandoErro(() =>
        comoUsuario(DONO_B, () => chamar('select public.read_my_pix_settings($1) as r', [LOJA_A])),
      );
      expect(String(errOutro)).toMatch(/Workspace membership required/);
      const errIntruso = await esperandoErro(() =>
        comoUsuario(INTRUSO, () => chamar('select public.read_my_pix_settings($1) as r', [LOJA_A])),
      );
      expect(String(errIntruso)).toMatch(/Workspace membership required/);
      const errSusp = await esperandoErro(() =>
        comoUsuario(SUSPENSO_A, () => chamar('select public.read_my_pix_settings($1) as r', [LOJA_A])),
      );
      expect(String(errSusp)).toMatch(/Workspace membership required/);
    });
  });

  test('Catálogo: upload de storage exige dono, valida até 5 mídias e limpa arquivos ao atualizar/remover', async () => {
    await emTransacao(async () => {
      const itemId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const f1 = `${LOJA_A}/catalogo/${itemId}/11111111-1111-4111-8111-111111111111/foto1.jpg`;
      const f2 = `${LOJA_A}/catalogo/${itemId}/22222222-2222-4222-8222-222222222222/ficha.pdf`;

      // Permissões do bucket midias para pasta catalogo/
      const podeDono = await comoUsuario(DONA_A, () =>
        chamar<boolean>('select private.can_upload_media_object($1) as r', [f1]),
      );
      const podeAtendente = await comoUsuario(ATENDENTE_A, () =>
        chamar<boolean>('select private.can_upload_media_object($1) as r', [f1]),
      );
      const podeOutro = await comoUsuario(DONO_B, () =>
        chamar<boolean>('select private.can_upload_media_object($1) as r', [f1]),
      );
      expect(podeDono).toBe(true);
      expect(podeAtendente).toBe(false);
      expect(podeOutro).toBe(false);

      await inserirStorageDummy(f1, 'image/jpeg', 2048);
      await inserirStorageDummy(f2, 'application/pdf', 4096);

      // Rejeita link HTTP inseguro
      const errLink = await esperandoErro(() =>
        comoUsuario(DONA_A, () =>
          chamar('select public.save_my_catalog_item($1, $2::jsonb) as r', [
            LOJA_A,
            JSON.stringify({ name: 'Corolla', payment_link: 'http://inseguro.com' }),
          ]),
        ),
      );
      expect(String(errLink)).toMatch(/Invalid payment link/);

      const criado = await comoUsuario(DONA_A, () =>
        chamar<{ item: { id: string; files: unknown[] }; removed_object_keys: string[] }>(
          'select public.save_my_catalog_item($1, $2::jsonb) as r',
          [
            LOJA_A,
            JSON.stringify({
              id: itemId,
              name: 'Toyota Corolla 2024',
              category: 'Seminovos',
              price: '129.900,00',
              description: 'Unico dono, revisado',
              payment_link: 'https://loja.exemplo.com/corolla',
              active: true,
              files: [
                { object_key: f1, file_name: 'Foto Frente.jpg', content_type: 'image/jpeg', byte_size: 2048 },
                { object_key: f2, file_name: 'Ficha Técnica.pdf', content_type: 'application/pdf', byte_size: 4096 },
              ],
            }),
          ],
        ),
      );
      expect(criado.item.id).toBe(itemId);
      expect(criado.item.files).toHaveLength(2);
      expect(criado.removed_object_keys).toEqual([]);

      // Atualizar removendo f2 devolve f2 para limpeza
      const atualizado = await comoUsuario(DONA_A, () =>
        chamar<{ item: { files: unknown[] }; removed_object_keys: string[] }>(
          'select public.save_my_catalog_item($1, $2::jsonb) as r',
          [
            LOJA_A,
            JSON.stringify({
              id: itemId,
              name: 'Toyota Corolla 2024',
              files: [{ object_key: f1, file_name: 'Foto Frente.jpg', content_type: 'image/jpeg', byte_size: 2048 }],
            }),
          ],
        ),
      );
      expect(atualizado.item.files).toHaveLength(1);
      expect(atualizado.removed_object_keys).toEqual([f2]);

      const listaB = await comoUsuario(DONO_B, () =>
        chamar<unknown[]>('select public.list_my_catalog_items($1) as r', [LOJA_B]),
      );
      expect(listaB).toEqual([]);

      const apagado = await comoUsuario(DONA_A, () =>
        chamar<{ deleted: boolean; removed_object_keys: string[] }>(
          'select public.delete_my_catalog_item($1, $2) as r',
          [LOJA_A, itemId],
        ),
      );
      expect(apagado).toEqual({ deleted: true, removed_object_keys: [f1] });
    });
  });

  test('Áudios estratégicos, Simulador isolado, Inbox recurso rápido e claim_ai_turn/start_ai_media_message', async () => {
    await emTransacao(async () => {
      const voiceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
      const voicePath = `${LOJA_A}/audios/${voiceId}/33333333-3333-4333-8333-333333333333/abertura.ogg`;
      await inserirStorageDummy(voicePath, 'audio/ogg', 9800);

      const wave = Array.from({ length: 64 }, (_, i) => ((i * 7) % 80) + 15);
      const salvo = await comoUsuario(DONA_A, () =>
        chamar<{ voice: { id: string; waveform: number[] } }>(
          'select public.save_my_voice_item($1, $2::jsonb) as r',
          [
            LOJA_A,
            JSON.stringify({
              id: voiceId,
              name: 'Boas-vindas Lizandro',
              transcription: 'Fala meu amigo, aqui é o Lizandro! Vi sua mensagem agora.',
              when_to_use: 'Primeiro contato do cliente',
              linked_message_code: 'M01',
              ai_enabled: true,
              object_key: voicePath,
              file_name: 'abertura.ogg',
              content_type: 'audio/ogg; codecs=opus',
              byte_size: 9800,
              duration_sec: 12,
              waveform: wave,
            }),
          ],
        ),
      );
      expect(salvo.voice.id).toBe(voiceId);
      expect(salvo.voice.waveform).toHaveLength(64);

      // Simulador isolado por usuário (não polui conversations/messages)
      await comoUsuario(DONA_A, () =>
        chamar('select public.save_my_simulator_session($1, null, $2::jsonb) as r', [
          LOJA_A,
          JSON.stringify([{ id: 'm1', papel: 'user', texto: 'Oi', criadoEm: '2026-11-12T12:00:00Z' }]),
        ]),
      );
      const simDona = await comoUsuario(DONA_A, () =>
        chamar<{ history: unknown[] }>('select public.read_my_simulator_session($1) as r', [LOJA_A]),
      );
      const simAtendente = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ history: unknown[] }>('select public.read_my_simulator_session($1) as r', [LOJA_A]),
      );
      expect(simDona.history).toHaveLength(1);
      expect(simAtendente.history).toEqual([]);

      // Membro da equipe envia áudio estratégico pela Inbox com trava anti-duplicação
      await comoAdmin(async () => {
        await banco.db.query(
          "update public.instances set status = 'connected', provider_instance_name = 'chip-a-teste' where id = $1",
          [CHIP_A],
        );
      });

      const envioInbox = await comoUsuario(ATENDENTE_A, () =>
        chamar<{ message_id: string; kind: string; already_exists: boolean }>(
          'select public.start_my_workspace_resource_message($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r',
          [LOJA_A, CONVERSA_A, 'chave_envio_recurso_01', voicePath, 'audio', 'abertura.ogg', null, 12, true, voiceId],
        ),
      );
      expect(envioInbox.kind).toBe('audio');
      expect(envioInbox.already_exists).toBe(false);

      // Conclui o envio humano (como faz a Inbox após chamar a Evolution) antes do turno da IA.
      await comoUsuario(ATENDENTE_A, () =>
        chamar('select public.finish_my_text_message($1,$2,$3,$4) as r', [
          LOJA_A,
          envioInbox.message_id,
          'sent',
          'wa-recurso-01',
        ]),
      );

      // Reabilita a IA na conversa (simulando "Retomar IA" após o envio humano anterior) mantendo a mensagem enviada no histórico.
      await comoAdmin(async () => {
        await banco.db.query(
          `update public.conversations
           set stage = 'ai', automation_paused = false, ai_paused_until = null, ai_pause_reason = null
           where id = $1`,
          [CONVERSA_A],
        );
        const msgId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
        const turnId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
        await banco.db.query(
          `insert into public.messages(id, workspace_id, conversation_id, instance_id, idempotency_key, direction, source_engine, actor_type, status, body_text, occurred_at)
           values ($1, $2, $3, $4, 'in-trigger-f6', 'inbound', 'evolution', 'contact', 'delivered', 'Pode mandar foto?', now())`,
          [msgId, LOJA_A, CONVERSA_A, CHIP_A],
        );
        await banco.db.query(
          `insert into public.ai_turns(id, workspace_id, conversation_id, instance_id, trigger_message_id, status, due_at)
           values ($1, $2, $3, $4, $5, 'waiting', clock_timestamp() - interval '1 second')`,
          [turnId, LOJA_A, CONVERSA_A, CHIP_A, msgId],
        );
        await banco.db.query(
          `insert into public.ai_agents(workspace_id, is_default, label, business_name, company_summary)
           values ($1, true, 'Principal', 'Loja A', 'Venda de carros')
           on conflict do nothing`,
          [LOJA_A],
        );
      });

      const claimed = await comoServico(() =>
        chamar<{
          result: string;
          resources: {
            pix: Record<string, unknown>;
            catalog: unknown[];
            voices: unknown[];
            sent_voice_ids: string[];
          };
        }>('select public.claim_ai_turn($1, $2, $3) as r', [
          LOJA_A,
          'dddddddd-dddd-4ddd-dddd-dddddddddddd',
          'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        ]),
      );
      expect(claimed.result).toBe('claimed');
      expect(claimed.resources.voices).toHaveLength(1);
      expect(claimed.resources.sent_voice_ids).toEqual([voiceId]);

      const mediaAi = await comoServico(() =>
        chamar<{ result: string; message_id: string }>(
          'select public.start_ai_media_message($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as r',
          [
            LOJA_A,
            'dddddddd-dddd-4ddd-dddd-dddddddddddd',
            1,
            voicePath,
            'audio',
            'audio/ogg',
            9800,
            'abertura.ogg',
            null,
            true,
            12,
            voiceId,
            true,
          ],
        ),
      );
      expect(mediaAi.result).toBe('started');
      expect(mediaAi.message_id).toBeTruthy();

      // Reuso do mesmo object_key em várias mensagens funciona sem colisão e mantém retention_delete_after = null.
      const retencoes = await comoAdmin(async () => {
        const { rows } = await banco.db.query<{ retention_delete_after: unknown }>(
          'select retention_delete_after from public.message_attachments where workspace_id = $1 and object_key = $2 order by created_at',
          [LOJA_A, voicePath],
        );
        return rows;
      });
      expect(retencoes).toEqual([{ retention_delete_after: null }, { retention_delete_after: null }]);
    });
  });
});
