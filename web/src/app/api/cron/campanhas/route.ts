import { createHash, timingSafeEqual } from 'node:crypto';
import { executarCampanhasEFilaSegura } from '@/lib/campanhas/executor';
import { criarClienteDeServico } from '@/lib/supabase/servico';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function segredoConfere(recebido: string | null, esperado: string | undefined): boolean {
  if (!recebido || !esperado?.trim()) return false;
  const a = createHash('sha256').update(recebido.trim()).digest();
  const b = createHash('sha256').update(esperado.trim()).digest();
  return timingSafeEqual(a, b);
}

export async function POST(pedido: Request) {
  const chegouEm = Date.now();
  const segredoRecebido =
    pedido.headers.get('x-ienvia-cron') ??
    /^Bearer\s+(\S+)$/i.exec(pedido.headers.get('authorization') ?? '')?.[1] ??
    null;

  if (!segredoConfere(segredoRecebido, process.env.CRON_SECRET)) {
    return Response.json({ ok: false, erro: 'não autorizado' }, { status: 401 });
  }

  const supabase = criarClienteDeServico();
  if (!supabase) {
    return Response.json({ ok: false, erro: 'painel sem configuração de serviço' }, { status: 503 });
  }

  const resumo = await executarCampanhasEFilaSegura(supabase, chegouEm, 48_000);
  return Response.json({ ok: true, ...resumo });
}
