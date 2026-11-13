import { NextResponse } from 'next/server';
import { extrairTokenDoMotor, sha256Hex } from '@/lib/motor/autenticacao';
import { criarClienteDeServico } from '@/lib/supabase/servico';

export const runtime = 'nodejs';
const DEPOSITO = 'midias';
const LIMITE_BYTES = 26_214_400; // 25 MB

interface AutorizacaoMidia {
  result: 'ok' | 'unauthorized' | 'not_found';
  workspace_id?: string;
  message_id?: string;
  object_key?: string;
  content_type?: string;
  file_name?: string | null;
}

/**
 * Download de mídia a enviar pelo Motor local (direção outbound).
 */
export async function GET(req: Request) {
  const token = extrairTokenDoMotor(req);
  if (!token) return NextResponse.json({ erro: 'Token do motor ausente.' }, { status: 401 });

  const messageId = new URL(req.url).searchParams.get('message_id') ?? '';
  if (!messageId) return NextResponse.json({ erro: 'Informe message_id.' }, { status: 400 });

  const supabase = criarClienteDeServico();
  if (!supabase) return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });

  const { data, error } = await supabase.rpc('authorize_local_motor_media', {
    p_token_sha256: sha256Hex(token),
    p_message_id: messageId,
    p_mode: 'outbound_download',
  });
  if (error) return NextResponse.json({ erro: 'Erro ao autorizar mídia.' }, { status: 500 });

  const auth = data as AutorizacaoMidia | null;
  if (!auth || auth.result === 'unauthorized') return NextResponse.json({ erro: 'Não autorizado.' }, { status: 401 });
  if (auth.result !== 'ok' || !auth.object_key) return NextResponse.json({ erro: 'Mídia não encontrada.' }, { status: 404 });

  const { data: blob, error: dlError } = await supabase.storage.from(DEPOSITO).download(auth.object_key);
  if (dlError || !blob) {
    return NextResponse.json({ erro: 'Arquivo indisponível no depósito.' }, { status: 404 });
  }

  return new NextResponse(blob, {
    status: 200,
    headers: {
      'content-type': auth.content_type || 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Upload de mídia recebida pelo Motor local (direção inbound) direto para o depósito privado `midias`.
 */
export async function POST(req: Request) {
  const token = extrairTokenDoMotor(req);
  if (!token) return NextResponse.json({ erro: 'Token do motor ausente.' }, { status: 401 });

  const messageId = new URL(req.url).searchParams.get('message_id') ?? '';
  if (!messageId) return NextResponse.json({ erro: 'Informe message_id.' }, { status: 400 });

  const supabase = criarClienteDeServico();
  if (!supabase) return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });

  const { data, error } = await supabase.rpc('authorize_local_motor_media', {
    p_token_sha256: sha256Hex(token),
    p_message_id: messageId,
    p_mode: 'inbound_upload',
  });
  if (error) return NextResponse.json({ erro: 'Erro ao autorizar upload de mídia.' }, { status: 500 });

  const auth = data as AutorizacaoMidia | null;
  if (!auth || auth.result === 'unauthorized') return NextResponse.json({ erro: 'Não autorizado.' }, { status: 401 });
  if (auth.result !== 'ok' || !auth.workspace_id || !auth.object_key) {
    return NextResponse.json({ erro: 'Mídia não encontrada.' }, { status: 404 });
  }

  const buffer = Buffer.from(await req.arrayBuffer());
  if (buffer.length === 0) return NextResponse.json({ erro: 'Arquivo vazio.' }, { status: 400 });
  if (buffer.length > LIMITE_BYTES) {
    await supabase.rpc('complete_media_download', {
      p_workspace_id: auth.workspace_id,
      p_message_id: messageId,
      p_outcome: 'too_large',
      p_content_type: auth.content_type ?? 'application/octet-stream',
      p_byte_size: buffer.length,
      p_sha256_hex: null,
    });
    return NextResponse.json({ erro: 'Arquivo excede o limite de 25 MB.' }, { status: 413 });
  }

  const contentType = req.headers.get('content-type')?.split(';')[0]?.trim() || auth.content_type || 'application/octet-stream';
  const digest = sha256Hex(buffer);

  const up = await supabase.storage.from(DEPOSITO).upload(auth.object_key, buffer, {
    contentType,
    upsert: true,
  });

  if (up.error) {
    await supabase.rpc('complete_media_download', {
      p_workspace_id: auth.workspace_id,
      p_message_id: messageId,
      p_outcome: 'failed',
      p_content_type: contentType,
      p_byte_size: buffer.length,
      p_sha256_hex: null,
    });
    return NextResponse.json({ erro: 'Falha ao guardar arquivo no depósito.' }, { status: 500 });
  }

  await supabase.rpc('complete_media_download', {
    p_workspace_id: auth.workspace_id,
    p_message_id: messageId,
    p_outcome: 'stored',
    p_content_type: contentType,
    p_byte_size: buffer.length,
    p_sha256_hex: digest,
  });

  return NextResponse.json({ ok: true, object_key: auth.object_key, sha256: digest, byte_size: buffer.length });
}
