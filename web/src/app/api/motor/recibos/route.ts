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
  const { data, error } = await db.rpc('apply_local_motor_receipts', {
    p_token_sha256: sha256Hex(token), p_instance_id: corpo.instance_id!, p_receipts: corpo.receipts,
  });
  if (error) return NextResponse.json({ erro: 'Falha ao gravar confirmações.' }, { status: 503 });
  const result = data as { result?: string; confirmed?: string[]; pending?: number } | null;
  if (result?.result === 'unauthorized') return NextResponse.json({ erro: 'Aparelho ou chip não autorizado.' }, { status: 401 });
  if (result?.result !== 'ok') return NextResponse.json({ erro: 'Resposta de confirmação inválida.' }, { status: 503 });
  return NextResponse.json(result);
}
