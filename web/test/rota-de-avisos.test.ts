/**
 * A porta de entrada dos avisos da Evolution, conversando com um "banco de mentira" que só
 * anota o que recebeu (e um "depósito de mentira" que só anota o que foi guardado).
 * As regras de verdade do banco são testadas em supabase/tests.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { criarEvolutionFalsa } from '../e2e/apoio/evolution-falsa.mjs';

/**
 * O que a rota deixa para fazer DEPOIS de responder à Evolution (buscar o arquivo de uma mensagem).
 * No Next isso roda sozinho; aqui o teste guarda as tarefas e roda quando quiser.
 */
const depois = vi.hoisted(() => ({ tarefas: [] as Array<() => unknown> }));
vi.mock('next/server', () => ({
  after: (tarefa: () => unknown) => {
    depois.tarefas.push(tarefa);
  },
}));
async function rodarOQueFicouParaDepois() {
  for (const tarefa of depois.tarefas.splice(0)) await tarefa();
}

const { POST } = await import('@/app/api/webhooks/evolution/route');

interface Chamada {
  funcao: string;
  parametros: Record<string, unknown>;
  autorizacao: string | undefined;
}
interface Guardado {
  caminho: string;
  bytes: number;
  conteudo: string | undefined;
  autorizacao: string | undefined;
  porCima: string | undefined;
}

const chamadas: Chamada[] = [];
const guardados: Guardado[] = [];
/** A resposta padrão do banco, e respostas próprias para uma função ou outra. */
let resposta: { status: number; corpo: unknown } = { status: 200, corpo: { result: 'accepted' } };
let respostasPorFuncao: Record<string, { status: number; corpo: unknown }> = {};
let depositoFalha = false;

const banco = http.createServer((req, res) => {
  const partes: Buffer[] = [];
  req.on('data', (parte: Buffer) => partes.push(parte));
  req.on('end', () => {
    const corpo = Buffer.concat(partes);
    const endereco = String(req.url);
    const responder = (status: number, conteudo: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(conteudo));
    };

    if (endereco.startsWith('/storage/v1/object/midias/')) {
      guardados.push({
        caminho: endereco.replace('/storage/v1/object/midias/', ''),
        bytes: corpo.length,
        conteudo: req.headers['content-type'],
        autorizacao: req.headers.authorization,
        porCima: String(req.headers['x-upsert']),
      });
      return depositoFalha
        ? responder(400, { statusCode: '500', error: 'Internal', message: 'falha simulada do depósito' })
        : responder(200, { Key: 'midias/arquivo', Id: 'id-de-teste' });
    }

    const funcao = endereco.replace('/rest/v1/rpc/', '');
    chamadas.push({
      funcao,
      parametros: JSON.parse(corpo.toString('utf8') || '{}') as Record<string, unknown>,
      autorizacao: req.headers.authorization,
    });
    const escolhida = respostasPorFuncao[funcao] ?? resposta;
    responder(escolhida.status, escolhida.corpo);
  });
});

const evolution = criarEvolutionFalsa({ instancias: [{ nome: 'ienvia-teste-01', estado: 'open', telefone: '5585999990010' }] });
let enderecoDaEvolution = '';
const buscasNaEvolution = async () =>
  (await (await fetch(`${enderecoDaEvolution}/controle/buscas`)).json()) as Array<{ instancia: string; id: string; comAMensagemInteira: boolean }>;

const SEGREDO = 'segredo-do-chip';
const RESUMO = createHash('sha256').update(SEGREDO).digest('hex');

const mensagem = {
  event: 'messages.upsert',
  instance: 'ienvia-teste-01',
  data: {
    key: { remoteJid: '5585999990000@s.whatsapp.net', fromMe: false, id: 'MSG-1' },
    pushName: 'Maria',
    message: { conversation: 'Oi!' },
    messageTimestamp: 1794409200,
  },
};

function avisar(corpo: unknown, cabecalhos: Record<string, string> = { authorization: `Bearer ${SEGREDO}` }) {
  return POST(
    new Request('https://painel.teste.invalid/api/webhooks/evolution', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    }),
  );
}

beforeAll(async () => {
  await new Promise<void>((pronto) => banco.listen(0, '127.0.0.1', pronto));
  await new Promise<void>((pronto) => evolution.listen(0, '127.0.0.1', pronto));
  enderecoDaEvolution = `http://127.0.0.1:${(evolution.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.EVOLUTION_API_URL;
  delete process.env.EVOLUTION_API_KEY;
  banco.closeAllConnections();
  evolution.closeAllConnections();
  await new Promise((pronto) => banco.close(pronto));
  await new Promise((pronto) => evolution.close(pronto));
});

beforeEach(async () => {
  chamadas.length = 0;
  guardados.length = 0;
  depois.tarefas.length = 0;
  depositoFalha = false;
  resposta = { status: 200, corpo: { result: 'accepted' } };
  respostasPorFuncao = {};
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(banco.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-do-servidor-de-teste';
  process.env.EVOLUTION_API_URL = enderecoDaEvolution;
  process.env.EVOLUTION_API_KEY = 'chave-da-evolution-de-teste';
  await fetch(`${enderecoDaEvolution}/controle/buscas`, { method: 'DELETE' });
});

describe('aviso de mensagem', () => {
  test('manda para o banco o resumo do segredo (nunca o segredo) e os dados da mensagem', async () => {
    const r = await avisar(mensagem);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resultado: 'accepted' });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.funcao).toBe('ingest_evolution_message');
    expect(chamadas[0]?.autorizacao).toBe('Bearer chave-do-servidor-de-teste');
    expect(chamadas[0]?.parametros).toEqual({
      p_instance_name: 'ienvia-teste-01',
      p_token_sha256: RESUMO,
      p_event_id: 'MSG-1',
      p_event_type: 'MESSAGES_UPSERT',
      p_sender_jid: '5585999990000@s.whatsapp.net',
      p_push_name: 'Maria',
      p_body_text: 'Oi!',
      p_occurred_at: '2026-11-11T15:00:00.000Z',
      p_from_me: false,
      p_media: null,
    });
    expect(JSON.stringify(chamadas[0]?.parametros)).not.toContain(SEGREDO);
    // Mensagem só de texto não deixa nada para depois.
    expect(depois.tarefas).toHaveLength(0);
  });

  test('mensagem repetida continua respondendo "ok" (a Evolution não precisa reenviar)', async () => {
    resposta = { status: 200, corpo: { result: 'duplicate' } };
    const r = await avisar(mensagem);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resultado: 'duplicate' });
  });
});

describe('aviso de mensagem enviada (o eco do que saiu pela Evolution)', () => {
  test('entra pela mesma porta, marcado como "de mim" e endereçado ao contato', async () => {
    const r = await avisar({
      event: 'send.message',
      instance: 'ienvia-teste-01',
      data: {
        key: { remoteJid: '5585999990000@s.whatsapp.net', fromMe: true, id: '3EB0AAAABBBBCCCCDDDD' },
        pushName: 'Você',
        status: 'PENDING',
        message: { conversation: 'Temos sim!' },
        messageType: 'conversation',
        messageTimestamp: 1794409200,
      },
    });
    expect(r.status).toBe(200);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.funcao).toBe('ingest_evolution_message');
    expect(chamadas[0]?.parametros).toMatchObject({
      p_event_id: '3EB0AAAABBBBCCCCDDDD',
      p_event_type: 'MESSAGES_UPSERT',
      p_sender_jid: '5585999990000@s.whatsapp.net',
      p_body_text: 'Temos sim!',
      p_from_me: true,
    });
  });
});

describe('aviso de mensagem com arquivo', () => {
  const LOJA = '11111111-1111-4111-8111-111111111111';
  const MENSAGEM = '22222222-2222-4222-8222-222222222222';
  const CAMINHO = `${LOJA}/33333333-3333-4333-8333-333333333333/${MENSAGEM}/foto`;

  const foto = (id = 'MSG-FOTO') => ({
    event: 'messages.upsert',
    instance: 'ienvia-teste-01',
    data: {
      key: { remoteJid: '5585999990000@s.whatsapp.net', fromMe: false, id },
      pushName: 'Maria',
      message: {
        imageMessage: {
          caption: 'meu comprovante',
          mimetype: 'image/jpeg',
          fileLength: '245000',
          width: 1280,
          height: 720,
          mediaKey: { 0: 1, 1: 2, 2: 3 },
          directPath: '/v/t62/abc',
          jpegThumbnail: { 0: 255, 1: 216 },
        },
      },
      messageType: 'imageMessage',
      messageTimestamp: 1794409200,
    },
  });

  const gravadaComArquivoPendente = () => {
    respostasPorFuncao = {
      ingest_evolution_message: {
        status: 200,
        corpo: { result: 'accepted', workspace_id: LOJA, message_id: MENSAGEM, media: { object_key: CAMINHO, status: 'pending' } },
      },
      begin_media_download: {
        status: 200,
        corpo: {
          claimed: true,
          object_key: CAMINHO,
          kind: 'image',
          content_type: 'image/jpeg',
          provider_instance_name: 'ienvia-teste-01',
          provider_message_id: 'MSG-FOTO',
          remote_jid: '5585999990000@s.whatsapp.net',
          from_me: false,
        },
      },
      complete_media_download: { status: 200, corpo: { changed: true, status: 'stored' } },
    };
  };

  test('a mensagem é gravada com a ficha do arquivo e a Evolution recebe o "ok" na hora; o arquivo vem depois', async () => {
    gravadaComArquivoPendente();
    const r = await avisar(foto());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resultado: 'accepted' });

    // Até aqui, só a gravação da mensagem: a legenda é o texto, e a ficha do arquivo vai junto.
    expect(chamadas.map((chamada) => chamada.funcao)).toEqual(['ingest_evolution_message']);
    expect(chamadas[0]?.parametros).toMatchObject({
      p_event_id: 'MSG-FOTO',
      p_body_text: 'meu comprovante',
      p_media: { kind: 'image', mime: 'image/jpeg', size: 245000, file_name: null, duration: null, width: 1280, height: 720, voice: false },
    });
    expect(guardados).toHaveLength(0);
    expect(depois.tarefas).toHaveLength(1);

    await rodarOQueFicouParaDepois();

    // Depois: reserva a busca, pede o arquivo à Evolution com o aviso inteiro, guarda no depósito e anota.
    expect(chamadas.map((chamada) => chamada.funcao)).toEqual(['ingest_evolution_message', 'begin_media_download', 'complete_media_download']);
    expect(chamadas[1]?.parametros).toEqual({ p_workspace_id: LOJA, p_message_id: MENSAGEM });
    expect(await buscasNaEvolution()).toEqual([{ instancia: 'ienvia-teste-01', id: 'MSG-FOTO', comAMensagemInteira: true }]);

    expect(guardados).toHaveLength(1);
    expect(guardados[0]).toMatchObject({
      caminho: CAMINHO,
      // O tipo que a Evolution informou junto com o arquivo vale mais que o do aviso.
      conteudo: 'image/png',
      autorizacao: 'Bearer chave-do-servidor-de-teste',
      porCima: 'true',
    });
    expect(guardados[0]?.bytes).toBeGreaterThan(1000);

    expect(chamadas[2]?.parametros).toEqual({
      p_workspace_id: LOJA,
      p_message_id: MENSAGEM,
      p_outcome: 'stored',
      p_content_type: 'image/png',
      p_byte_size: guardados[0]?.bytes,
      p_sha256_hex: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('a Evolution não entrega o arquivo: fica anotado que falhou (a conversa oferece "buscar de novo") e nada é guardado', async () => {
    gravadaComArquivoPendente();
    expect((await avisar(foto('MSG-SEM-ARQUIVO'))).status).toBe(200);
    await rodarOQueFicouParaDepois();

    expect(guardados).toHaveLength(0);
    expect(chamadas.at(-1)).toMatchObject({ funcao: 'complete_media_download', parametros: { p_outcome: 'failed', p_content_type: null, p_byte_size: null, p_sha256_hex: null } });
  });

  test('o depósito não guarda: também fica anotado que falhou', async () => {
    gravadaComArquivoPendente();
    depositoFalha = true;
    await avisar(foto());
    await rodarOQueFicouParaDepois();

    expect(guardados).toHaveLength(1);
    expect(chamadas.at(-1)).toMatchObject({ funcao: 'complete_media_download', parametros: { p_outcome: 'failed' } });
  });

  test('outro pedido já está buscando o mesmo arquivo: este não busca de novo', async () => {
    gravadaComArquivoPendente();
    respostasPorFuncao.begin_media_download = { status: 200, corpo: { claimed: false, reason: 'in_progress' } };
    await avisar(foto());
    await rodarOQueFicouParaDepois();

    expect(chamadas.map((chamada) => chamada.funcao)).toEqual(['ingest_evolution_message', 'begin_media_download']);
    expect(await buscasNaEvolution()).toEqual([]);
    expect(guardados).toHaveLength(0);
  });

  test.each([
    ['arquivo grande demais para guardar', { result: 'accepted', workspace_id: LOJA, message_id: MENSAGEM, media: { object_key: CAMINHO, status: 'too_large' } }],
    ['eco de um envio do painel (o arquivo já está guardado)', { result: 'accepted', workspace_id: LOJA, message_id: MENSAGEM, adopted: true, media: null }],
    ['aviso repetido', { result: 'duplicate' }],
    ['aviso que o banco ignorou', { result: 'ignored' }],
  ])('%s: nada fica para depois', async (_caso, gravado) => {
    respostasPorFuncao = { ingest_evolution_message: { status: 200, corpo: gravado } };
    expect((await avisar(foto())).status).toBe(200);
    expect(depois.tarefas).toHaveLength(0);
    expect(chamadas).toHaveLength(1);
  });

  test('um aviso com miniatura pesada (bem mais de 1 MB) é aceito; só é recusado o que passa do limite da hospedagem', async () => {
    gravadaComArquivoPendente();
    const pesado = foto();
    (pesado.data.message.imageMessage as Record<string, unknown>).jpegThumbnail = 'x'.repeat(1_500_000);
    expect((await avisar(pesado)).status).toBe(200);
    // A miniatura não volta para a Evolution na hora de buscar o arquivo.
    await rodarOQueFicouParaDepois();
    expect(guardados).toHaveLength(1);

    (pesado.data.message.imageMessage as Record<string, unknown>).jpegThumbnail = 'x'.repeat(4_100_000);
    expect((await avisar(pesado)).status).toBe(413);
  });
});

describe('aviso de conexão', () => {
  test('chip conectado: o banco recebe o estado e o número', async () => {
    resposta = { status: 200, corpo: { result: 'applied', status: 'connected' } };
    const r = await avisar({
      event: 'connection.update',
      instance: 'ienvia-teste-01',
      data: { state: 'open', wuid: '5585988887777@s.whatsapp.net' },
    });
    expect(r.status).toBe(200);
    expect(chamadas[0]).toMatchObject({
      funcao: 'apply_evolution_connection_update',
      parametros: { p_instance_name: 'ienvia-teste-01', p_token_sha256: RESUMO, p_provider_state: 'open', p_connected_phone: '+5585988887777' },
    });
  });
});

describe('quem não é a Evolution não grava nada', () => {
  test('sem segredo: recusado antes de chegar ao banco', async () => {
    expect((await avisar(mensagem, {})).status).toBe(401);
    expect((await avisar(mensagem, { authorization: 'Basic abc' })).status).toBe(401);
    expect(chamadas).toHaveLength(0);
  });

  test('segredo que o banco não reconhece: recusado', async () => {
    resposta = { status: 200, corpo: { result: 'unauthorized' } };
    const r = await avisar(mensagem, { authorization: 'Bearer segredo-errado' });
    expect(r.status).toBe(401);
    expect(chamadas[0]?.parametros.p_token_sha256).not.toBe(RESUMO);
  });
});

describe('avisos estranhos ou em má hora', () => {
  test('evento que o painel não usa responde "ok" sem chamar o banco', async () => {
    const r = await avisar({ event: 'presence.update', instance: 'ienvia-teste-01', data: {} });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resultado: 'ignorado' });
    expect(chamadas).toHaveLength(0);
  });

  test('corpo ilegível é erro de quem mandou', async () => {
    expect((await avisar('{isto não é json')).status).toBe(400);
  });

  test('se o banco falha, responde erro (para ficar registrado) e não finge que gravou', async () => {
    resposta = { status: 500, corpo: { code: 'XX000', message: 'falha simulada' } };
    expect((await avisar(mensagem)).status).toBe(500);
  });

  test('painel sem a chave do servidor avisa que não está pronto', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect((await avisar(mensagem)).status).toBe(503);
    expect(chamadas).toHaveLength(0);
  });
});
