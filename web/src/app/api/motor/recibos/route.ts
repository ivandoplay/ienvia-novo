import { NextResponse } from 'next/server';
import { extrairTokenDoMotor, sha256Hex } from '@/lib/motor/autenticacao';
import { criarClienteDeServico } from '@/lib/supabase/servico';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const token = extrairTokenDoMotor(req);
  if (!token) return NextResponse.json({ erro: 'Token ausente.' }, { status: 401 });
  let corpo: { instance_id?: string; receipts?: { id: string; status: number }[] };
  try { corpo = await req.json(); } catch { return NextResponse.json({ erro: 'JSON inválido.' }, { status: 400 }); }
  if (!/^[0-9a-f-]{36}$/i.test(corpo.instance_id || '') || !Array.isArray(corpo.receipts) || corpo.receipts.length > 100 || corpo.receipts.some(r => !r || typeof r.id !== 'string' || !r.id || r.id.length > 200 || ![0,3,4,5].includes(r.status))) {
    return NextResponse.json({ erro: 'Recibos inválidos.' }, { status: 400 });
  }
  const db = criarClienteDeServico();
  if (!db) return NextResponse.json({ erro: 'Serviço indisponível.' }, { status: 503 });
  const auth = await db.rpc('authenticate_local_executor_heartbeat', { p_token_sha256: sha256Hex(token), p_platform: null, p_version: null, p_metadata: {} });
  if (auth.error) return NextResponse.json({ erro: 'Falha de autenticação.' }, { status: 503 });
  const actor = auth.data as { result?: string; executor_id?: string; workspace_id?: string } | null;
  if (actor?.result !== 'ok' || !actor.executor_id || !actor.workspace_id) return NextResponse.json({ erro: 'Aparelho não autorizado.' }, { status: 401 });
  const chip = await db.from('instances').select('id').eq('id', corpo.instance_id!).eq('workspace_id', actor.workspace_id).eq('local_executor_id', actor.executor_id).eq('engine','baileys').neq('status','revoked').maybeSingle();
  if (chip.error) return NextResponse.json({ erro: 'Falha ao consultar chip.' }, { status: 503 });
  if (!chip.data) return NextResponse.json({ erro: 'Chip não vinculado ao aparelho.' }, { status: 403 });
  let atualizados = 0;
  let pendentes = 0;
  for (const recibo of corpo.receipts) {
    // Só aceita IDs originados de comandos deste aparelho e desta instância.
    const comando = await db.from('local_motor_commands').select('message_id').eq('workspace_id',actor.workspace_id).eq('executor_id',actor.executor_id).eq('instance_id',corpo.instance_id!).eq('provider_message_id',recibo.id).limit(1).maybeSingle();
    if (comando.error) return NextResponse.json({ erro: 'Falha ao consultar envio.' }, { status: 503 });
    if (!comando.data?.message_id) { pendentes++; continue; }
    const status = recibo.status >= 4 ? 'read' : recibo.status === 3 ? 'delivered' : 'failed';
    const anteriores = status === 'read' ? ['sending','sent','delivered'] : status === 'delivered' ? ['sending','sent'] : ['sending','sent'];
    const update = await db.from('messages').update({ status }).eq('id',comando.data.message_id).eq('workspace_id',actor.workspace_id).eq('instance_id',corpo.instance_id!).eq('direction','outbound').in('status',anteriores).select('id');
    if (update.error) return NextResponse.json({ erro: 'Falha ao gravar recibo.' }, { status: 503 });
    atualizados += update.data?.length || 0;
  }
  return NextResponse.json({ result: 'ok', updated: atualizados, pending: pendentes });
}
