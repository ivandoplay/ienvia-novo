import { Buffer } from 'node:buffer';
import process from 'node:process';
import { processarAvisoEvolution } from '../../../web/src/lib/evolution/processar-aviso.ts';

if (!('process' in globalThis)) {
  (globalThis as Record<string, unknown>).process = process;
}
if (!('Buffer' in globalThis)) {
  (globalThis as Record<string, unknown>).Buffer = Buffer;
}

interface RuntimeDeBorda {
  waitUntil(tarefa: Promise<unknown>): void;
}

declare const EdgeRuntime: RuntimeDeBorda | undefined;

Deno.serve(async (pedido: Request) => {
  if (pedido.method === 'GET') {
    return Response.json({ ok: true, servico: 'evolution-webhook' });
  }
  if (pedido.method !== 'POST') {
    return Response.json({ ok: false, erro: 'método não suportado' }, { status: 405 });
  }
  return processarAvisoEvolution(pedido, {
    agendar: (tarefa) => {
      const promessa = tarefa().catch((erro) => {
        console.error('[evolution-webhook edge] falha na tarefa em segundo plano:', erro);
      });
      if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime.waitUntil === 'function') {
        EdgeRuntime.waitUntil(promessa);
      }
    },
  });
});
