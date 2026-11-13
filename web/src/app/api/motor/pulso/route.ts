import { NextResponse } from 'next/server';
import { normalizarPlataforma } from '@ienvia/shared';
import { extrairTokenDoMotor, sha256Hex } from '@/lib/motor/autenticacao';
import { criarClienteDeServico } from '@/lib/supabase/servico';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const token = extrairTokenDoMotor(req);
  if (!token) return NextResponse.json({ erro: 'Token do motor ausente.' }, { status: 401 });

  let corpo: { platform?: string; version?: string; metadata?: Record<string, unknown> } = {};
  try {
    corpo = (await req.json()) as typeof corpo;
  } catch {
    corpo = {};
  }

  const supabase = criarClienteDeServico();
  if (!supabase) return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });

  const { data, error } = await supabase.rpc('authenticate_local_executor_heartbeat', {
    p_token_sha256: sha256Hex(token),
    p_platform: corpo.platform ? normalizarPlataforma(corpo.platform) : null,
    p_version: typeof corpo.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(corpo.version.trim())
      ? corpo.version.trim()
      : null,
    p_metadata: corpo.metadata && typeof corpo.metadata === 'object' ? corpo.metadata : {},
  });

  if (error) {
    console.error('[motor/pulso] erro:', error);
    return NextResponse.json({ erro: 'Erro interno no heartbeat.' }, { status: 500 });
  }

  const res = data as { result?: string } | null;
  if (!res || res.result !== 'ok') {
    return NextResponse.json({ erro: 'Aparelho não autorizado ou revogado.' }, { status: 401 });
  }
  return NextResponse.json(res);
}
