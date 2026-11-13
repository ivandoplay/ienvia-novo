import { NextResponse } from 'next/server';
import { extrairTokenDoMotor, sha256Hex } from '@/lib/motor/autenticacao';
import { criarClienteDeServico } from '@/lib/supabase/servico';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const token = extrairTokenDoMotor(req);
  if (!token) return NextResponse.json({ erro: 'Token do motor ausente.' }, { status: 401 });

  const supabase = criarClienteDeServico();
  if (!supabase) return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });

  const { data, error } = await supabase.rpc('claim_local_motor_commands', {
    p_token_sha256: sha256Hex(token),
    p_limit: 10,
  });

  if (error) {
    console.error('[motor/comandos GET] erro:', error);
    return NextResponse.json({ erro: 'Falha ao consultar fila de comandos.' }, { status: 500 });
  }

  const res = data as { result?: string; commands?: unknown[] } | null;
  if (!res || res.result !== 'ok') {
    return NextResponse.json({ erro: 'Aparelho não autorizado ou revogado.' }, { status: 401 });
  }
  return NextResponse.json(res);
}

export async function POST(req: Request) {
  const token = extrairTokenDoMotor(req);
  if (!token) return NextResponse.json({ erro: 'Token do motor ausente.' }, { status: 401 });

  let corpo: { command_id?: string; outcome?: string; provider_message_id?: string | null; error_detail?: string | null } = {};
  try {
    corpo = (await req.json()) as typeof corpo;
  } catch {
    return NextResponse.json({ erro: 'JSON inválido.' }, { status: 400 });
  }

  if (!corpo.command_id || !['sent', 'succeeded', 'failed', 'uncertain'].includes(String(corpo.outcome))) {
    return NextResponse.json({ erro: 'Parâmetros inválidos.' }, { status: 400 });
  }

  const supabase = criarClienteDeServico();
  if (!supabase) return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });

  const { data, error } = await supabase.rpc('complete_local_motor_command', {
    p_token_sha256: sha256Hex(token),
    p_command_id: corpo.command_id,
    p_outcome: corpo.outcome,
    p_provider_message_id: corpo.provider_message_id ?? null,
    p_error_detail: corpo.error_detail ?? null,
  });

  if (error) {
    console.error('[motor/comandos POST] erro:', error);
    return NextResponse.json({ erro: 'Falha ao confirmar comando.' }, { status: 500 });
  }

  const res = data as { result?: string } | null;
  if (res?.result === 'unauthorized') {
    return NextResponse.json({ erro: 'Aparelho não autorizado ou revogado.' }, { status: 401 });
  }
  return NextResponse.json(res ?? { result: 'ok' });
}
