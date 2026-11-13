import { NextResponse } from 'next/server';
import { normalizarCodigoPareamentoAparelho, normalizarPlataforma } from '@ienvia/shared';
import { gerarTokenDeAparelho, sha256Hex } from '@/lib/motor/autenticacao';
import { criarClienteDeServico } from '@/lib/supabase/servico';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let corpo: { code?: string; platform?: string; version?: string; metadata?: Record<string, unknown> } = {};
  try {
    corpo = (await req.json()) as typeof corpo;
  } catch {
    return NextResponse.json({ erro: 'Corpo JSON inválido.' }, { status: 400 });
  }

  const codigo = normalizarCodigoPareamentoAparelho(corpo.code);
  if (!codigo) {
    return NextResponse.json({ erro: 'Código de pareamento inválido. Use o formato IENV-XXXX-XXXX.' }, { status: 400 });
  }

  const supabase = criarClienteDeServico();
  if (!supabase) {
    return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });
  }

  const deviceToken = gerarTokenDeAparelho();
  const codeSha256 = sha256Hex(codigo);
  const tokenSha256 = sha256Hex(deviceToken);
  const platform = normalizarPlataforma(corpo.platform);
  const version = typeof corpo.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(corpo.version.trim())
    ? corpo.version.trim()
    : null;

  const { data, error } = await supabase.rpc('pair_local_executor_by_code', {
    p_code_sha256: codeSha256,
    p_token_sha256: tokenSha256,
    p_platform: platform,
    p_version: version,
    p_metadata: corpo.metadata && typeof corpo.metadata === 'object' ? corpo.metadata : {},
  });

  if (error) {
    console.error('[motor/parear] falha no banco:', error);
    return NextResponse.json({ erro: 'Não foi possível concluir o pareamento agora.' }, { status: 500 });
  }

  const res = data as {
    result?: string;
    executor_id?: string;
    workspace_id?: string;
    display_name?: string;
    platform?: string;
    motor_version?: string | null;
  } | null;

  if (!res || res.result !== 'paired') {
    return NextResponse.json({ erro: 'Código inválido ou expirado. Gere um novo código no painel.' }, { status: 401 });
  }

  return NextResponse.json({
    executor_id: res.executor_id,
    workspace_id: res.workspace_id,
    display_name: res.display_name,
    platform: res.platform,
    motor_version: res.motor_version,
    device_token: deviceToken,
  });
}
