/**
 * A porta de entrada dos avisos da Evolution, conversando com um "banco de mentira" que só
 * anota o que recebeu. As regras de verdade do banco são testadas em supabase/tests.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { POST } from '@/app/api/webhooks/evolution/route';

interface Chamada {
  funcao: string;
  parametros: Record<string, unknown>;
  autorizacao: string | undefined;
}

const chamadas: Chamada[] = [];
let resposta: { status: number; corpo: unknown } = { status: 200, corpo: { result: 'accepted' } };

const banco = http.createServer((req, res) => {
  let texto = '';
  req.on('data', (parte) => (texto += parte));
  req.on('end', () => {
    chamadas.push({
      funcao: String(req.url).replace('/rest/v1/rpc/', ''),
      parametros: JSON.parse(texto || '{}') as Record<string, unknown>,
      autorizacao: req.headers.authorization,
    });
    res.writeHead(resposta.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(resposta.corpo));
  });
});

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
});

afterAll(async () => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  banco.closeAllConnections();
  await new Promise((pronto) => banco.close(pronto));
});

beforeEach(() => {
  chamadas.length = 0;
  resposta = { status: 200, corpo: { result: 'accepted' } };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(banco.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-do-servidor-de-teste';
});

describe('aviso de mensagem', () => {
  test('manda para o banco o resumo do segredo (nunca o segredo) e os dados da mensagem', async () => {
    const r = await avisar(mensagem);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resultado: 'accepted' });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.funcao).toBe('ingest_evolution_text');
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
    });
    expect(JSON.stringify(chamadas[0]?.parametros)).not.toContain(SEGREDO);
  });

  test('mensagem repetida continua respondendo "ok" (a Evolution não precisa reenviar)', async () => {
    resposta = { status: 200, corpo: { result: 'duplicate' } };
    const r = await avisar(mensagem);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resultado: 'duplicate' });
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
