import { describe, expect, test, vi } from 'vitest';
import { atenderNoPorteiro, dispararAgendamentosNoPorteiro, listarDestinos, type AmbienteDoPorteiro } from '../../cloudflare/porteiro/worker';

const ENV_PADRAO: AmbienteDoPorteiro = {
  DESTINO_PRINCIPAL: 'https://proj.supabase.co/functions/v1/evolution-webhook/',
  DESTINOS_RESERVA: 'https://painel.netlify.app/api/webhooks/evolution, https://painel.onrender.com/api/webhooks/evolution/',
};

function pedidoWebhook(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://porteiro.workers.dev/', {
    method: 'POST',
    headers: {
      authorization: 'Bearer segredo-valido',
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

const MENSAGEM_VALIDA = {
  event: 'messages.upsert',
  instance: 'ienvia-chip-1',
  data: {
    key: { id: 'MSG-1', remoteJid: '5586999999999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'oi' },
  },
};

describe('porteiro Cloudflare', () => {
  test('lista destino principal e reservas sem duplicar e removendo barra final', () => {
    expect(listarDestinos(ENV_PADRAO)).toEqual([
      { nome: 'principal', url: 'https://proj.supabase.co/functions/v1/evolution-webhook' },
      { nome: 'reserva-1', url: 'https://painel.netlify.app/api/webhooks/evolution' },
      { nome: 'reserva-2', url: 'https://painel.onrender.com/api/webhooks/evolution' },
    ]);
  });

  test('GET devolve status 200 sem expor URLs completas', async () => {
    const res = await atenderNoPorteiro(new Request('https://porteiro.workers.dev/', { method: 'GET' }), ENV_PADRAO);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, servico: 'ienvia-porteiro', destinos: ['principal', 'reserva-1', 'reserva-2'] });
  });

  test('rejeita requisição sem Bearer ou com JSON inválido sem chamar nenhum destino', async () => {
    const buscar = vi.fn<typeof fetch>();
    const semAuth = await atenderNoPorteiro(
      new Request('https://porteiro.workers.dev/', { method: 'POST', body: '{}' }),
      ENV_PADRAO,
      buscar,
    );
    expect(semAuth.status).toBe(401);

    const jsonRuim = await atenderNoPorteiro(pedidoWebhook('{nao-eh-json'), ENV_PADRAO, buscar);
    expect(jsonRuim.status).toBe(400);
    expect(buscar).not.toHaveBeenCalled();
  });

  test('filtra na borda eventos ignorados pelo Ienvia sem gastar cota do destino', async () => {
    const buscar = vi.fn<typeof fetch>();
    const res = await atenderNoPorteiro(
      pedidoWebhook({ event: 'presence.update', instance: 'ienvia-chip-1', data: { id: '1' } }),
      ENV_PADRAO,
      buscar,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resultado: 'ignorado', filtradoNoPorteiro: true });
    expect(buscar).not.toHaveBeenCalled();
  });

  test('encaminha MESSAGES_UPSERT, SEND_MESSAGE e CONNECTION_UPDATE ao principal e devolve a resposta', async () => {
    for (const evento of ['messages.upsert', 'SEND_MESSAGE', 'connection.update']) {
      const buscar = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, resultado: 'accepted' }), { status: 200 }),
      );
      const res = await atenderNoPorteiro(
        pedidoWebhook({ ...MENSAGEM_VALIDA, event: evento }),
        ENV_PADRAO,
        buscar,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ienvia-destino')).toBe('principal');
      expect(buscar).toHaveBeenCalledTimes(1);
      expect(buscar.mock.calls[0]?.[0]).toBe('https://proj.supabase.co/functions/v1/evolution-webhook');
    }
  });

  test('faz failover automático para Netlify e depois Render se o principal falhar (5xx/429/402/erro)', async () => {
    const buscar = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('cota', { status: 402 }))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, resultado: 'accepted' }), { status: 200 }));

    const res = await atenderNoPorteiro(pedidoWebhook(MENSAGEM_VALIDA), ENV_PADRAO, buscar);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ienvia-destino')).toBe('reserva-2');
    expect(buscar.mock.calls.map((c) => c[0])).toEqual([
      'https://proj.supabase.co/functions/v1/evolution-webhook',
      'https://painel.netlify.app/api/webhooks/evolution',
      'https://painel.onrender.com/api/webhooks/evolution',
    ]);
  });

  test('não faz failover quando o destino principal recusa o segredo (401)', async () => {
    const buscar = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, erro: 'não autorizado' }), { status: 401 }));

    const res = await atenderNoPorteiro(pedidoWebhook(MENSAGEM_VALIDA), ENV_PADRAO, buscar);
    expect(res.status).toBe(401);
    expect(buscar).toHaveBeenCalledTimes(1);
  });

  test('devolve 503 quando todos os destinos falham temporariamente', async () => {
    const buscar = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('erro', { status: 503 }))
      .mockResolvedValueOnce(new Response('limite', { status: 429 }))
      .mockRejectedValueOnce(new Error('offline'));

    const res = await atenderNoPorteiro(pedidoWebhook(MENSAGEM_VALIDA), ENV_PADRAO, buscar);
    expect(res.status).toBe(503);
    expect(buscar).toHaveBeenCalledTimes(3);
  });

  test('dispara agendamentos via x-ienvia-cron e faz failover se o principal falhar', async () => {
    const semSegredo = await dispararAgendamentosNoPorteiro(ENV_PADRAO);
    expect(semSegredo).toBe(false);

    const buscar = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('erro', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, processadas: 1 }), { status: 200 }));

    const ok = await dispararAgendamentosNoPorteiro({ ...ENV_PADRAO, CRON_SECRET: 'segredo-cron' }, buscar);
    expect(ok).toBe(true);
    expect(buscar).toHaveBeenCalledTimes(2);
    expect((buscar.mock.calls[1]?.[1]?.headers as Record<string, string>)['x-ienvia-cron']).toBe('segredo-cron');
  });
});
