/**
 * Fotos, áudios, vídeos, documentos e figurinhas: receber da Evolution, guardar no depósito,
 * enviar pelo painel, o eco do envio e quem pode ler ou colocar arquivos no depósito.
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

const RESUMO = 'd'.repeat(64);
const CHIP_NA_EVOLUTION = 'ienvia-midia-0001';
const CLIENTE_A = '5586900000001@s.whatsapp.net';
const CHAVE = 'chave-de-envio-de-arquivo-0001';
const MB = 1024 * 1024;

async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role authenticated');
  }
}

const prepararChip = () =>
  comoAdmin(() =>
    banco.db.exec(`
      update public.instances set provider_instance_name = '${CHIP_NA_EVOLUTION}' where id = '${CHIP_A}';
      insert into private.evolution_webhook_auth(workspace_id, instance_id, token_sha256) values ('${LOJA_A}', '${CHIP_A}', '${RESUMO}');
    `),
  );

interface Recebida {
  result: string;
  message_id?: string;
  conversation_id?: string;
  direction?: string;
  adopted?: boolean;
  media?: { object_key: string; status: string } | null;
}

/** O servidor entrega um aviso de mensagem com (ou sem) arquivo, como a rota de avisos faz. */
const receber = (id: string, legenda: string | null, ficha: Record<string, unknown> | null, deMim = false) =>
  comoAdmin(async () => {
    const { rows } = await banco.db.query<{ r: Recebida }>(
      'select public.ingest_evolution_message($1,$2,$3,$4,$5,$6,$7,now(),$8,$9::jsonb) as r',
      [CHIP_NA_EVOLUTION, RESUMO, id, 'MESSAGES_UPSERT', CLIENTE_A, 'Cliente da A', legenda, deMim, ficha === null ? null : JSON.stringify(ficha)],
    );
    return rows[0]!.r;
  });

const FOTO = { kind: 'image', mime: 'image/jpeg', size: 245_000, width: 1280, height: 960 };
const VOZ = { kind: 'audio', mime: 'audio/ogg', size: 18_000, duration: 9, voice: true };

async function ficha(mensagem: string) {
  const { rows } = await banco.db.query(
    `select kind, content_type, byte_size::int as byte_size, file_name, duration_seconds, width, height, is_voice,
            storage_status, attempts, object_key
       from public.message_attachments where message_id = $1`,
    [mensagem],
  );
  return rows[0] as Record<string, unknown> | undefined;
}

const lerConversa = async (id = CONVERSA_A) =>
  (
    await banco.db.query<{ stage: string; unread_count: number; last_message_preview: string | null }>(
      'select stage, unread_count, last_message_preview from public.conversations where id = $1',
      [id],
    )
  ).rows[0]!;

const comecarDownload = (mensagem: string, empresa = LOJA_A) =>
  banco.db
    .query<{ r: Record<string, unknown> }>('select public.begin_media_download($1,$2) as r', [empresa, mensagem])
    .then(({ rows }) => rows[0]!.r);

const terminarDownload = (mensagem: string, resultado: string, tipo: string | null = null, tamanho: number | null = null, resumo: string | null = null) =>
  banco.db
    .query<{ r: Record<string, unknown> }>('select public.complete_media_download($1,$2,$3,$4,$5,$6) as r', [LOJA_A, mensagem, resultado, tipo, tamanho, resumo])
    .then(({ rows }) => rows[0]!.r);

/** Coloca um arquivo no depósito, como o navegador faz antes de pedir o envio. */
const colocarNoDeposito = (caminho: string, tamanho: number, tipo: string) =>
  comoAdmin(() =>
    banco.db.query(`insert into storage.objects (bucket_id, name, metadata) values ('midias', $1, $2::jsonb)`, [
      caminho,
      JSON.stringify({ size: tamanho, mimetype: tipo }),
    ]),
  );

const caminhoDoEnvio = (nome = 'foto.jpg', chave = CHAVE, conversa = CONVERSA_A, empresa = LOJA_A) => `${empresa}/${conversa}/envios/${chave}/${nome}`;

interface Inicio {
  message_id: string;
  status: string;
  already_exists: boolean;
  provider_instance_name?: string;
  recipient?: string;
  object_key?: string;
  kind?: string;
  content_type?: string;
  byte_size?: number;
  file_name?: string | null;
  caption?: string | null;
}

async function comecarEnvio(
  opcoes: { caminho?: string; tipo?: string; nome?: string | null; legenda?: string | null; chave?: string; conversa?: string; empresa?: string } = {},
): Promise<Inicio> {
  const chave = opcoes.chave ?? CHAVE;
  const { rows } = await banco.db.query<{ r: Inicio }>('select public.start_my_media_message($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r', [
    opcoes.empresa ?? LOJA_A,
    opcoes.conversa ?? CONVERSA_A,
    chave,
    opcoes.caminho ?? caminhoDoEnvio('foto.jpg', chave),
    opcoes.tipo ?? 'image',
    opcoes.nome === undefined ? 'Foto da vitrine.jpg' : opcoes.nome,
    opcoes.legenda === undefined ? 'Olha a vitrine nova' : opcoes.legenda,
    null,
    1280,
    960,
  ]);
  return rows[0]!.r;
}

const terminarEnvio = (mensagem: string, resultado: string, idNoWhatsapp: string | null = null) =>
  banco.db
    .query<{ r: { status: string; changed: boolean } }>('select public.finish_my_text_message($1,$2,$3,$4) as r', [LOJA_A, mensagem, resultado, idNoWhatsapp])
    .then(({ rows }) => rows[0]!.r);

const enviadas = async () =>
  (
    await banco.db.query(
      `select m.status, m.body_text, m.provider_message_id, (m.sent_by is not null) as do_painel, a.kind, a.storage_status
         from public.messages m left join public.message_attachments a on a.message_id = m.id
        where m.conversation_id = $1 and m.direction = 'outbound'
        order by (m.sent_by is null), m.provider_message_id nulls first`,
      [CONVERSA_A],
    )
  ).rows;

describe('receber um arquivo', () => {
  test('foto com legenda: a mensagem guarda a legenda, e a ficha do arquivo nasce pendente', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-FOTO-1', '  meu comprovante  ', FOTO);
      expect(recebida).toMatchObject({ result: 'accepted', direction: 'inbound', adopted: false, conversation_id: CONVERSA_A });
      expect(recebida.media).toEqual({
        object_key: `${LOJA_A}/${CONVERSA_A}/${recebida.message_id}/foto`,
        status: 'pending',
      });

      const { rows } = await banco.db.query('select body_text, media_object_key, direction, status from public.messages where id = $1', [recebida.message_id]);
      expect(rows).toEqual([{ body_text: 'meu comprovante', media_object_key: recebida.media?.object_key, direction: 'inbound', status: 'received' }]);
      expect(await ficha(recebida.message_id!)).toMatchObject({
        kind: 'image',
        content_type: 'image/jpeg',
        byte_size: 245_000,
        width: 1280,
        height: 960,
        is_voice: false,
        storage_status: 'pending',
        attempts: 0,
      });
      expect(await lerConversa()).toEqual({ stage: 'waiting_human', unread_count: 3, last_message_preview: '📷 Foto: meu comprovante' });
    });
  });

  test.each([
    ['áudio de voz sem legenda', VOZ, null, '🎤 Áudio', 'audio'],
    ['áudio que não é de voz', { kind: 'audio', mime: 'audio/mpeg', size: 4 * MB, duration: 180 }, null, '🎵 Áudio', 'audio'],
    ['vídeo', { kind: 'video', mime: 'video/mp4', size: 3 * MB, duration: 21 }, 'olha isso', '🎥 Vídeo: olha isso', 'video'],
    ['figurinha', { kind: 'sticker', mime: 'image/webp', size: 30_000 }, null, 'Figurinha', 'figurinha'],
    ['documento com nome', { kind: 'document', mime: 'application/pdf', size: 90_000, file_name: 'Relatório Final.PDF' }, null, '📄 Relatório Final.PDF', 'relat-rio-final.pdf'],
    ['documento sem nome', { kind: 'document', mime: 'application/zip', size: 90_000 }, null, '📄 Documento', 'documento'],
  ])('%s', async (_caso, fichaDoArquivo, legenda, previa, nomeNoDeposito) => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-ARQ-1', legenda, fichaDoArquivo);
      expect(recebida.result).toBe('accepted');
      expect(recebida.media?.object_key).toBe(`${LOJA_A}/${CONVERSA_A}/${recebida.message_id}/${nomeNoDeposito}`);
      expect((await lerConversa()).last_message_preview).toBe(previa);
      const { rows } = await banco.db.query('select body_text from public.messages where id = $1', [recebida.message_id]);
      expect(rows).toEqual([{ body_text: legenda }]);
    });
  });

  test('nome de arquivo estranho não vira caminho estranho no depósito', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-ARQ-2', null, { kind: 'document', mime: 'application/pdf', size: 1, file_name: '../../outra-empresa/segredo.pdf' });
      expect(recebida.media?.object_key).toBe(`${LOJA_A}/${CONVERSA_A}/${recebida.message_id}/outra-empresa-segredo.pdf`);
      // Para a pessoa, o nome aparece como veio.
      expect((await ficha(recebida.message_id!))?.file_name).toBe('../../outra-empresa/segredo.pdf');

      // O nome no depósito sempre começa por letra ou número; se não sobrar nada, vale o nome do tipo.
      const comSublinhado = await receber('WA-ARQ-4', null, { kind: 'document', mime: 'application/pdf', size: 1, file_name: '__.Orçamento (2).pdf' });
      expect(comSublinhado.media?.object_key).toBe(`${LOJA_A}/${CONVERSA_A}/${comSublinhado.message_id}/or-amento-2-.pdf`);
      const soSimbolos = await receber('WA-ARQ-5', null, { kind: 'image', mime: 'image/jpeg', size: 1, file_name: '···' });
      expect(soSimbolos.media?.object_key).toBe(`${LOJA_A}/${CONVERSA_A}/${soSimbolos.message_id}/foto`);
    });
  });

  test('arquivo acima de 25 MB entra na conversa, mas marcado como grande demais para guardar', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-ARQ-3', null, { kind: 'video', mime: 'video/mp4', size: 26 * MB });
      expect(recebida.media?.status).toBe('too_large');
      expect((await ficha(recebida.message_id!))?.storage_status).toBe('too_large');
    });
  });

  test.each([
    ['tipo desconhecido vira documento', { kind: 'hologram', mime: 'image/jpeg' }, { kind: 'document', content_type: 'image/jpeg' }],
    ['sem tipo vira documento', { mime: 'image/jpeg' }, { kind: 'document', content_type: 'image/jpeg' }],
    ['tipo de conteúdo malformado vira o genérico', { kind: 'image', mime: 'isto não é um tipo' }, { kind: 'image', content_type: 'application/octet-stream' }],
    ['tipo de conteúdo com detalhes fica só com o tipo', { kind: 'audio', mime: 'Audio/OGG; codecs=opus', voice: true }, { kind: 'audio', content_type: 'audio/ogg', is_voice: true }],
    ['medidas absurdas são deixadas de lado', { kind: 'image', mime: 'image/png', size: 'muito', width: 0, height: 99999, duration: -3 }, { kind: 'image', byte_size: 0, width: null, height: null, duration_seconds: null }],
  ])('a mensagem do cliente nunca se perde por causa da ficha do arquivo: %s', async (_caso, fichaDoArquivo, esperado) => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-RUIM-1', 'legenda', fichaDoArquivo);
      expect(recebida).toMatchObject({ result: 'accepted', media: { status: 'pending' } });
      expect(await ficha(recebida.message_id!)).toMatchObject(esperado);
    });
  });

  test('ficha que não é um objeto conta como mensagem sem arquivo', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const comTexto = await comoAdmin(async () => {
        const { rows } = await banco.db.query<{ r: Recebida }>(
          `select public.ingest_evolution_message($1,$2,'WA-LISTA-1','MESSAGES_UPSERT',$3,'Cliente','oi',now(),false,'[1,2]'::jsonb) as r`,
          [CHIP_NA_EVOLUTION, RESUMO, CLIENTE_A],
        );
        return rows[0]!.r;
      });
      expect(comTexto).toMatchObject({ result: 'accepted', media: null });
      const semTexto = await comoAdmin(async () => {
        const { rows } = await banco.db.query<{ r: Recebida }>(
          `select public.ingest_evolution_message($1,$2,'WA-LISTA-2','MESSAGES_UPSERT',$3,'Cliente',null,now(),false,'[1,2]'::jsonb) as r`,
          [CHIP_NA_EVOLUTION, RESUMO, CLIENTE_A],
        );
        return rows[0]!.r;
      });
      expect(semTexto.result).toBe('ignored');
    });
  });

  test('a ficha anota até quando o arquivo fica guardado: o prazo da empresa, ou 30 dias', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const dias = async (mensagem: string) =>
        (
          await banco.db.query<{ dias: number }>(
            `select round(extract(epoch from retention_delete_after - now()) / 86400)::int as dias from public.message_attachments where message_id = $1`,
            [mensagem],
          )
        ).rows[0]?.dias;

      await comoAdmin(() => banco.db.exec(`delete from public.workspace_data_policies where workspace_id = '${LOJA_A}'`));
      const padrao = await receber('WA-PRAZO-1', null, FOTO);
      expect(await dias(padrao.message_id!)).toBe(30);

      await comoAdmin(() => banco.db.exec(`insert into public.workspace_data_policies(workspace_id, media_retention_days) values ('${LOJA_A}', 7)`));
      const curto = await receber('WA-PRAZO-2', null, FOTO);
      expect(await dias(curto.message_id!)).toBe(7);
    });
  });

  test('mensagem só de texto continua entrando, pela função nova e pela antiga', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const nova = await receber('WA-TXT-1', 'Oi pela função nova', null);
      expect(nova).toMatchObject({ result: 'accepted', media: null });
      const antiga = await comoAdmin(async () => {
        const { rows } = await banco.db.query<{ r: Recebida }>('select public.ingest_evolution_text($1,$2,$3,$4,$5,$6,$7,now(),$8) as r', [
          CHIP_NA_EVOLUTION,
          RESUMO,
          'WA-TXT-2',
          'MESSAGES_UPSERT',
          CLIENTE_A,
          'Cliente da A',
          'Oi pela função antiga',
          false,
        ]);
        return rows[0]!.r;
      });
      expect(antiga).toMatchObject({ result: 'accepted', media: null });
      expect(await lerConversa()).toMatchObject({ unread_count: 4, last_message_preview: 'Oi pela função antiga' });
      // Sem texto e sem arquivo não há mensagem.
      expect((await receber('WA-TXT-3', '   ', null)).result).toBe('ignored');
    });
  });

  test('o mesmo aviso duas vezes não grava a foto duas vezes', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await receber('WA-FOTO-1', null, FOTO);
      expect((await receber('WA-FOTO-1', null, FOTO)).result).toBe('duplicate');
      const { rows } = await banco.db.query('select count(*)::int as n from public.message_attachments where workspace_id = $1', [LOJA_A]);
      expect(rows).toEqual([{ n: 1 }]);
    });
  });

  test('foto enviada direto pelo celular do chip entra como resposta nossa, com o arquivo pendente', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-CEL-1', 'segue a foto', FOTO, true);
      expect(recebida).toMatchObject({ result: 'accepted', direction: 'outbound', adopted: false });
      expect(recebida.media?.status).toBe('pending');
      expect(await enviadas()).toEqual([
        { status: 'sent', body_text: 'segue a foto', provider_message_id: 'WA-CEL-1', do_painel: false, kind: 'image', storage_status: 'pending' },
      ]);
      expect(await lerConversa()).toEqual({ stage: 'waiting_customer', unread_count: 0, last_message_preview: '📷 Foto: segue a foto' });
    });
  });

  test('a conversa aberta traz a ficha do arquivo de cada mensagem', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararChip();
      await receber('WA-VOZ-1', null, VOZ);
      const { rows } = await banco.db.query<{ r: { messages: Array<{ body_text: string | null; attachment: Record<string, unknown> | null }> } }>(
        'select public.read_my_conversation($1,$2,$3) as r',
        [LOJA_A, CONVERSA_A, null],
      );
      expect(rows[0]!.r.messages).toMatchObject([
        { body_text: 'Oi, tem pizza?', attachment: null },
        {
          body_text: null,
          attachment: { kind: 'audio', content_type: 'audio/ogg', byte_size: 18_000, file_name: null, duration_seconds: 9, width: null, height: null, is_voice: true, status: 'pending' },
        },
      ]);
      const anexo = rows[0]!.r.messages[1]!.attachment!;
      expect(Object.keys(anexo).sort()).toEqual(['byte_size', 'content_type', 'duration_seconds', 'file_name', 'height', 'is_voice', 'kind', 'object_key', 'status', 'width']);
      expect(anexo.object_key).toMatch(new RegExp(`^${LOJA_A}/${CONVERSA_A}/[0-9a-f-]{36}/audio$`));
    });
  });

  test('arquivo já apagado pelo prazo de guarda aparece como apagado', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-FOTO-1', null, FOTO);
      await comoAdmin(() => banco.db.exec(`update public.message_attachments set storage_status = 'stored', deletion_status = 'deleted' where message_id = '${recebida.message_id}'`));
      const { rows } = await banco.db.query<{ r: { messages: Array<{ attachment: { status: string } | null }> } }>('select public.read_my_conversation($1,$2,$3) as r', [LOJA_A, CONVERSA_A, null]);
      expect(rows[0]!.r.messages.at(-1)?.attachment?.status).toBe('deleted');
    });
  });
});

describe('buscar o arquivo na Evolution e guardar no depósito', () => {
  test('reservar a vez diz de onde baixar; terminar marca como guardado e avisa as telas abertas', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-FOTO-1', null, FOTO);
      const antes = await banco.db.query<{ updated_at: string }>('select updated_at from public.conversations where id = $1', [CONVERSA_A]);

      const alvo = await comoAdmin(() => comecarDownload(recebida.message_id!));
      expect(alvo).toEqual({
        claimed: true,
        object_key: recebida.media?.object_key,
        kind: 'image',
        content_type: 'image/jpeg',
        provider_instance_name: CHIP_NA_EVOLUTION,
        provider_message_id: 'WA-FOTO-1',
        remote_jid: CLIENTE_A,
        from_me: false,
      });
      expect(await ficha(recebida.message_id!)).toMatchObject({ storage_status: 'pending', attempts: 1 });

      // Outro pedido ao mesmo tempo não baixa de novo.
      expect(await comoAdmin(() => comecarDownload(recebida.message_id!))).toEqual({ claimed: false, reason: 'in_progress' });

      await comoAdmin(() => banco.db.exec(`update public.conversations set updated_at = now() - interval '1 minute' where id = '${CONVERSA_A}'`));
      expect(await comoAdmin(() => terminarDownload(recebida.message_id!, 'stored', 'image/JPEG', 251_304, 'a'.repeat(64)))).toEqual({ changed: true, status: 'stored' });
      expect(await ficha(recebida.message_id!)).toMatchObject({ storage_status: 'stored', content_type: 'image/jpeg', byte_size: 251_304, attempts: 1 });
      const depois = await banco.db.query<{ updated_at: string }>('select updated_at from public.conversations where id = $1', [CONVERSA_A]);
      expect(new Date(depois.rows[0]!.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(antes.rows[0]!.updated_at).getTime());

      // Já guardado: nada a fazer.
      expect(await comoAdmin(() => comecarDownload(recebida.message_id!))).toEqual({ claimed: false, reason: 'stored' });
      expect(await comoAdmin(() => terminarDownload(recebida.message_id!, 'failed'))).toEqual({ changed: false });
    });
  });

  test('download que falhou pode ser tentado de novo na hora', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-FOTO-1', null, FOTO);
      await comoAdmin(() => comecarDownload(recebida.message_id!));
      expect(await comoAdmin(() => terminarDownload(recebida.message_id!, 'failed'))).toEqual({ changed: true, status: 'failed' });
      expect((await ficha(recebida.message_id!))?.storage_status).toBe('failed');

      expect(await comoAdmin(() => comecarDownload(recebida.message_id!))).toMatchObject({ claimed: true });
      expect(await ficha(recebida.message_id!)).toMatchObject({ storage_status: 'pending', attempts: 2 });
    });
  });

  test('pendente há mais de 90 segundos (o pedido anterior se perdeu) pode ser tentado de novo', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-FOTO-1', null, FOTO);
      await comoAdmin(() => comecarDownload(recebida.message_id!));
      await comoAdmin(() => banco.db.exec(`update public.message_attachments set last_attempt_at = now() - interval '2 minutes'`));
      expect(await comoAdmin(() => comecarDownload(recebida.message_id!))).toMatchObject({ claimed: true });
    });
  });

  test('arquivo que a Evolution entregou acima do limite fica marcado como grande demais', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-FOTO-1', null, FOTO);
      await comoAdmin(() => comecarDownload(recebida.message_id!));
      expect(await comoAdmin(() => banco.esperarErro(() => terminarDownload(recebida.message_id!, 'stored', 'video/mp4', 27 * MB)))).toMatch(/Invalid byte size/);
      expect(await comoAdmin(() => banco.esperarErro(() => terminarDownload(recebida.message_id!, 'sumiu')))).toMatch(/Invalid outcome/);
      expect(await comoAdmin(() => banco.esperarErro(() => terminarDownload(recebida.message_id!, 'stored', 'video/mp4', 10, 'não é um resumo')))).toMatch(/Invalid digest/);
      expect(await comoAdmin(() => terminarDownload(recebida.message_id!, 'too_large'))).toEqual({ changed: true, status: 'too_large' });
      expect(await comoAdmin(() => comecarDownload(recebida.message_id!))).toEqual({ claimed: false, reason: 'too_large' });
    });
  });

  test('chip removido: não há mais de onde baixar', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-FOTO-1', null, FOTO);
      await comoAdmin(() => banco.db.exec(`update public.instances set status = 'revoked' where id = '${CHIP_A}'`));
      expect(await comoAdmin(() => comecarDownload(recebida.message_id!))).toEqual({ claimed: false, reason: 'unavailable' });
      expect(await comoAdmin(() => comecarDownload('11111111-0000-4000-8000-00000000dead'))).toEqual({ claimed: false, reason: 'not_found' });
    });
  });

  test('só o servidor do painel reserva e termina downloads', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      const recebida = await receber('WA-FOTO-1', null, FOTO);
      expect(await banco.esperarErro(() => comecarDownload(recebida.message_id!))).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => terminarDownload(recebida.message_id!, 'stored', 'image/jpeg', 1))).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => banco.db.query('select public.ingest_evolution_message(null,null,null,null,null,null,null,now(),false,null)'))).toMatch(
        /permission denied/,
      );
    });
  });
});

describe('enviar um arquivo pelo painel', () => {
  test('o arquivo precisa já estar no depósito, na pasta deste envio', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      expect(await banco.esperarErro(() => comecarEnvio())).toMatch(/media_not_uploaded/);

      await colocarNoDeposito(caminhoDoEnvio(), 300_000, 'image/jpeg');
      // Caminho de outra chave, de outra conversa, de outra empresa ou fora da pasta de envios: recusado.
      for (const caminho of [
        caminhoDoEnvio('foto.jpg', 'outra-chave-de-envio-0002'),
        caminhoDoEnvio('foto.jpg', CHAVE, CONVERSA_B),
        caminhoDoEnvio('foto.jpg', CHAVE, CONVERSA_A, LOJA_B),
        `${LOJA_A}/${CONVERSA_A}/recebidos/${CHAVE}/foto.jpg`,
        `${LOJA_A}/${CONVERSA_A}/envios/${CHAVE}/pasta/foto.jpg`,
        `${LOJA_A}/${CONVERSA_A}/envios/${CHAVE}/`,
        `${LOJA_A}/${CONVERSA_A}/envios/${CHAVE}/..`,
      ]) {
        expect(await banco.esperarErro(() => comecarEnvio({ caminho }))).toMatch(/Invalid media path/);
      }
    });
  });

  test('cria a mensagem como "enviando", com a ficha tirada do que está no depósito', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await prepararChip();
      // O que o navegador declarou não conta: tamanho e tipo vêm do depósito.
      await colocarNoDeposito(caminhoDoEnvio(), 300_000, 'image/jpeg; charset=binary');
      const inicio = await comecarEnvio();
      expect(inicio).toEqual({
        message_id: inicio.message_id,
        status: 'sending',
        already_exists: false,
        provider_instance_name: CHIP_NA_EVOLUTION,
        recipient: CLIENTE_A,
        object_key: caminhoDoEnvio(),
        kind: 'image',
        content_type: 'image/jpeg',
        byte_size: 300_000,
        file_name: 'Foto da vitrine.jpg',
        caption: 'Olha a vitrine nova',
      });
      expect(await ficha(inicio.message_id)).toMatchObject({ kind: 'image', content_type: 'image/jpeg', byte_size: 300_000, width: 1280, height: 960, storage_status: 'stored', is_voice: false });
      const { rows } = await banco.db.query('select status, body_text, media_object_key, sent_by from public.messages where id = $1', [inicio.message_id]);
      expect(rows).toEqual([{ status: 'sending', body_text: 'Olha a vitrine nova', media_object_key: caminhoDoEnvio(), sent_by: ATENDENTE_A }]);
      // Ainda não saiu: a conversa não mudou.
      expect(await lerConversa()).toEqual({ stage: 'waiting_human', unread_count: 2, last_message_preview: null });

      // Pedido repetido não cria a segunda.
      expect(await comecarEnvio()).toEqual({ message_id: inicio.message_id, status: 'sending', already_exists: true });

      expect(await terminarEnvio(inicio.message_id, 'sent', 'WA-ENV-1')).toMatchObject({ status: 'sent', changed: true });
      expect(await lerConversa()).toEqual({ stage: 'waiting_customer', unread_count: 0, last_message_preview: '📷 Foto: Olha a vitrine nova' });
    });
  });

  test('limites de tamanho: 16 MB para foto, vídeo e áudio; 25 MB para documento', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio('video.mp4', 'chave-de-envio-video-0001'), 17 * MB, 'video/mp4');
      expect(await banco.esperarErro(() => comecarEnvio({ chave: 'chave-de-envio-video-0001', caminho: caminhoDoEnvio('video.mp4', 'chave-de-envio-video-0001'), tipo: 'video' }))).toMatch(
        /media_too_large/,
      );
      await colocarNoDeposito(caminhoDoEnvio('contrato.pdf', 'chave-de-envio-docum-0001'), 20 * MB, 'application/pdf');
      const documento = await comecarEnvio({ chave: 'chave-de-envio-docum-0001', caminho: caminhoDoEnvio('contrato.pdf', 'chave-de-envio-docum-0001'), tipo: 'document', nome: 'Contrato.pdf', legenda: null });
      expect(documento).toMatchObject({ kind: 'document', byte_size: 20 * MB, caption: null });
      await terminarEnvio(documento.message_id, 'sent');
      expect((await lerConversa()).last_message_preview).toBe('📄 Contrato.pdf');
    });
  });

  test('arquivo vazio não é enviado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio('vazio.pdf'), 0, 'application/pdf');
      expect(await banco.esperarErro(() => comecarEnvio({ caminho: caminhoDoEnvio('vazio.pdf'), tipo: 'document', nome: 'vazio.pdf', legenda: null }))).toMatch(/media_empty/);
    });
  });

  test.each([
    ['foto', 'image', 'image/svg+xml'],
    ['foto', 'image', 'application/pdf'],
    ['vídeo', 'video', 'video/quicktime'],
    ['áudio', 'audio', 'video/mp4'],
  ])('o tipo escolhido tem de combinar com o arquivo: %s não pode ser %s', async (_nome, tipo, conteudo) => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio('arquivo.bin'), 5000, conteudo);
      expect(await banco.esperarErro(() => comecarEnvio({ caminho: caminhoDoEnvio('arquivo.bin'), tipo, legenda: null }))).toMatch(/media_type_mismatch/);
      // Como documento, qualquer arquivo vai.
      expect(await comecarEnvio({ caminho: caminhoDoEnvio('arquivo.bin'), tipo: 'document', legenda: null })).toMatchObject({ kind: 'document', content_type: conteudo });
    });
  });

  test('a ficha do envio também anota até quando o arquivo fica guardado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio(), 300_000, 'image/jpeg');
      const inicio = await comecarEnvio();
      const { rows } = await banco.db.query<{ dias: number }>(
        `select round(extract(epoch from retention_delete_after - now()) / 86400)::int as dias from public.message_attachments where message_id = $1`,
        [inicio.message_id],
      );
      expect(rows[0]?.dias).toBeGreaterThanOrEqual(1);
    });
  });

  test('áudio sai como mensagem de voz e não leva legenda', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio('recado.mp3'), 400_000, 'audio/mpeg');
      expect(await banco.esperarErro(() => comecarEnvio({ caminho: caminhoDoEnvio('recado.mp3'), tipo: 'audio', legenda: 'ouça' }))).toMatch(/Invalid caption/);
      const audio = await comecarEnvio({ caminho: caminhoDoEnvio('recado.mp3'), tipo: 'audio', legenda: null, nome: 'recado.mp3' });
      expect(await ficha(audio.message_id)).toMatchObject({ kind: 'audio', is_voice: true, content_type: 'audio/mpeg' });
    });
  });

  test('as mesmas travas do texto: conversa resolvida, chip desconectado, tipo inválido', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio(), 300_000, 'image/jpeg');
      expect(await banco.esperarErro(() => comecarEnvio({ tipo: 'sticker' }))).toMatch(/Invalid media kind/);
      expect(await banco.esperarErro(() => comecarEnvio({ legenda: 'x'.repeat(1025) }))).toMatch(/Invalid caption/);

      await comoAdmin(() => banco.db.exec(`update public.instances set status = 'disconnected' where id = '${CHIP_A}'`));
      expect(await banco.esperarErro(() => comecarEnvio())).toMatch(/instance_not_connected/);
      await comoAdmin(() => banco.db.exec(`update public.instances set status = 'connected' where id = '${CHIP_A}'`));

      await banco.db.query('select public.transition_workspace_conversation($1,$2,$3)', [LOJA_A, CONVERSA_A, 'resolve']);
      expect(await banco.esperarErro(() => comecarEnvio())).toMatch(/conversation_closed/);
    });
  });

  test.each([
    ['o dono de outra loja', DONO_B],
    ['quem não participa de nenhuma empresa', INTRUSO],
    ['o funcionário suspenso', SUSPENSO_A],
  ])('%s não envia arquivo pela Loja A', async (_quem, usuario) => {
    await banco.comoUsuario(usuario, async () => {
      expect(await banco.esperarErro(() => comecarEnvio())).toMatch(/Workspace membership required/);
    });
  });
});

describe('o eco de um arquivo enviado pelo painel', () => {
  test('o painel já anotou o identificador: o eco não cria nada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio(), 300_000, 'image/jpeg');
      const inicio = await comecarEnvio();
      await terminarEnvio(inicio.message_id, 'sent', 'WA-ENV-1');
      expect((await receber('WA-ENV-1', 'Olha a vitrine nova', FOTO, true)).result).toBe('duplicate');
      expect(await enviadas()).toHaveLength(1);
    });
  });

  test('envio sem confirmação: o eco (mesmo tipo e mesma legenda) confirma a mesma mensagem, sem baixar nada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio(), 300_000, 'image/jpeg');
      const inicio = await comecarEnvio();
      await terminarEnvio(inicio.message_id, 'uncertain');

      const eco = await receber('WA-ENV-1', 'Olha a vitrine nova', FOTO, true);
      expect(eco).toMatchObject({ result: 'accepted', adopted: true, message_id: inicio.message_id, media: null });
      expect(await enviadas()).toEqual([
        { status: 'sent', body_text: 'Olha a vitrine nova', provider_message_id: 'WA-ENV-1', do_painel: true, kind: 'image', storage_status: 'stored' },
      ]);
      expect(await lerConversa()).toMatchObject({ stage: 'waiting_customer', last_message_preview: '📷 Foto: Olha a vitrine nova' });
    });
  });

  test('eco de outro tipo, ou com outra legenda, não é confundido com o envio do painel', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio(), 300_000, 'image/jpeg');
      const inicio = await comecarEnvio();
      await terminarEnvio(inicio.message_id, 'uncertain');

      expect(await receber('WA-CEL-1', 'Olha a vitrine nova', VOZ, true)).toMatchObject({ adopted: false });
      expect(await receber('WA-CEL-2', 'outra legenda', FOTO, true)).toMatchObject({ adopted: false });
      // Um texto igual à legenda também não é o eco da foto.
      expect(await receber('WA-CEL-3', 'Olha a vitrine nova', null, true)).toMatchObject({ adopted: false });
      expect(await enviadas()).toMatchObject([
        { status: 'awaiting_human_confirmation', do_painel: true, kind: 'image' },
        { status: 'sent', provider_message_id: 'WA-CEL-1', do_painel: false, kind: 'audio', storage_status: 'pending' },
        { status: 'sent', provider_message_id: 'WA-CEL-2', do_painel: false, kind: 'image', storage_status: 'pending' },
        { status: 'sent', provider_message_id: 'WA-CEL-3', do_painel: false, kind: null },
      ]);
    });
  });

  test('eco guardado como mensagem do celular (a legenda veio diferente) é juntado quando o painel termina o envio', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await prepararChip();
      await colocarNoDeposito(caminhoDoEnvio(), 300_000, 'image/jpeg');
      const inicio = await comecarEnvio();
      expect(await receber('WA-ENV-1', 'Olha a vitrine nova (editada)', FOTO, true)).toMatchObject({ adopted: false });
      expect(await enviadas()).toHaveLength(2);

      expect(await terminarEnvio(inicio.message_id, 'sent', 'WA-ENV-1')).toMatchObject({ status: 'sent', changed: true });
      expect(await enviadas()).toEqual([
        { status: 'sent', body_text: 'Olha a vitrine nova', provider_message_id: 'WA-ENV-1', do_painel: true, kind: 'image', storage_status: 'stored' },
      ]);
      const { rows } = await banco.db.query('select count(*)::int as n from public.message_attachments where workspace_id = $1', [LOJA_A]);
      expect(rows).toEqual([{ n: 1 }]);
    });
  });
});

describe('quem pode ler e colocar arquivos no depósito', () => {
  const DA_LOJA_A = `${LOJA_A}/${CONVERSA_A}/11111111-0000-4000-8000-0000000000f1/foto.jpg`;
  const DA_LOJA_B = `${LOJA_B}/${CONVERSA_B}/22222222-0000-4000-8000-0000000000f1/foto.jpg`;

  const semear = () =>
    comoAdmin(() =>
      banco.db.exec(`
        insert into storage.buckets (id, name) values ('outro', 'outro') on conflict do nothing;
        insert into storage.objects (bucket_id, name) values
          ('midias', '${DA_LOJA_A}'), ('midias', '${DA_LOJA_B}'), ('midias', 'solto.jpg'), ('outro', '${DA_LOJA_A}');
      `),
    );
  const visiveis = async () => (await banco.db.query<{ bucket_id: string; name: string }>('select bucket_id, name from storage.objects order by name, bucket_id')).rows;
  const colocar = (caminho: string, deposito = 'midias') => banco.db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [deposito, caminho]);

  test('o depósito é fechado e tem limite de 25 MB por arquivo', async () => {
    const { rows } = await banco.db.query('select public, file_size_limit::int as limite from storage.buckets where id = $1', ['midias']);
    expect(rows).toEqual([{ public: false, limite: 25 * MB }]);
  });

  test('cada pessoa só enxerga os arquivos da própria empresa, e só no depósito de mídias', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await semear();
      expect(await visiveis()).toEqual([{ bucket_id: 'midias', name: DA_LOJA_A }]);
    });
    await banco.comoUsuario(DONO_B, async () => {
      await semear();
      expect(await visiveis()).toEqual([{ bucket_id: 'midias', name: DA_LOJA_B }]);
    });
  });

  test.each([
    ['quem não participa de nenhuma empresa', INTRUSO],
    ['o funcionário suspenso', SUSPENSO_A],
  ])('%s não enxerga arquivo nenhum', async (_quem, usuario) => {
    await banco.comoUsuario(usuario, async () => {
      await semear();
      expect(await visiveis()).toEqual([]);
    });
  });

  test('visitante sem login não enxerga arquivo nenhum', async () => {
    await banco.comoAnonimo(async () => {
      expect(await visiveis()).toEqual([]);
      expect(await banco.esperarErro(() => colocar(caminhoDoEnvio()))).toMatch(/row-level security/);
    });
  });

  test('só dá para colocar arquivo na pasta de envios de uma conversa da própria empresa', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      await colocar(caminhoDoEnvio('Foto_1.jpg'));

      for (const [caso, caminho, deposito] of [
        ['conversa de outra empresa', caminhoDoEnvio('foto.jpg', CHAVE, CONVERSA_B, LOJA_B), 'midias'],
        ['pasta da própria empresa com conversa de outra', caminhoDoEnvio('foto.jpg', CHAVE, CONVERSA_B, LOJA_A), 'midias'],
        ['fora da pasta de envios', `${LOJA_A}/${CONVERSA_A}/11111111-0000-4000-8000-0000000000f1/foto.jpg`, 'midias'],
        ['subpasta dentro do envio', `${LOJA_A}/${CONVERSA_A}/envios/${CHAVE}/a/b.jpg`, 'midias'],
        ['nome com caracteres estranhos', `${LOJA_A}/${CONVERSA_A}/envios/${CHAVE}/fo to.jpg`, 'midias'],
        ['nome que é só pontos', `${LOJA_A}/${CONVERSA_A}/envios/${CHAVE}/..`, 'midias'],
        ['nome começando com ponto', `${LOJA_A}/${CONVERSA_A}/envios/${CHAVE}/.oculto`, 'midias'],
        ['chave curta demais', `${LOJA_A}/${CONVERSA_A}/envios/curta/foto.jpg`, 'midias'],
        ['arquivo solto', 'solto.jpg', 'midias'],
        ['outro depósito', caminhoDoEnvio('outra.jpg'), 'outro'],
      ] as const) {
        if (deposito === 'outro') await comoAdmin(() => banco.db.exec(`insert into storage.buckets (id, name) values ('outro', 'outro') on conflict do nothing`));
        expect(await banco.esperarErro(() => colocar(caminho, deposito)), caso).toMatch(/row-level security/);
      }
    });
  });

  test('ninguém troca nem apaga arquivo pelo navegador', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await semear();
      const trocado = await banco.db.query(`update storage.objects set name = name || '.x' where bucket_id = 'midias'`);
      expect(trocado.affectedRows).toBe(0);
      const apagado = await banco.db.query(`delete from storage.objects where bucket_id = 'midias'`);
      expect(apagado.affectedRows).toBe(0);
      expect(await visiveis()).toEqual([{ bucket_id: 'midias', name: DA_LOJA_A }]);
    });
  });

  test('funcionário suspenso não coloca arquivo', async () => {
    await banco.comoUsuario(SUSPENSO_A, async () => {
      expect(await banco.esperarErro(() => colocar(caminhoDoEnvio()))).toMatch(/row-level security/);
    });
  });
});
