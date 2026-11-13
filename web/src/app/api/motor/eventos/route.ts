import { after, NextResponse } from 'next/server';
import { atenderSobras, atenderVez, orcamentoDoAtendente } from '@/lib/atendente/atendente';
import { extrairTokenDoMotor, sha256Hex } from '@/lib/motor/autenticacao';
import { criarClienteDeServico } from '@/lib/supabase/servico';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const chegouEm = Date.now();
  const token = extrairTokenDoMotor(req);
  if (!token) return NextResponse.json({ erro: 'Token do motor ausente.' }, { status: 401 });

  let corpo: {
    instance_id?: string;
    event_id?: string;
    sender_jid?: string;
    push_name?: string;
    body_text?: string;
    occurred_at?: string;
    from_me?: boolean;
    media?: Record<string, unknown> | null;
  } = {};
  try {
    corpo = (await req.json()) as typeof corpo;
  } catch {
    return NextResponse.json({ erro: 'JSON inválido.' }, { status: 400 });
  }

  if (!corpo.instance_id || !corpo.event_id || !corpo.sender_jid) {
    return NextResponse.json({ erro: 'Evento incompleto.' }, { status: 400 });
  }

  const supabase = criarClienteDeServico();
  if (!supabase) return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });

  const { data, error } = await supabase.rpc('ingest_local_message', {
    p_token_sha256: sha256Hex(token),
    p_instance_id: corpo.instance_id,
    p_event_id: corpo.event_id,
    p_sender_jid: corpo.sender_jid,
    p_push_name: corpo.push_name ?? '',
    p_body_text: corpo.body_text ?? '',
    p_occurred_at: corpo.occurred_at ?? new Date().toISOString(),
    p_from_me: Boolean(corpo.from_me),
    p_media: corpo.media ?? null,
  });

  if (error) {
    console.error('[motor/eventos] erro ao gravar mensagem:', error);
    return NextResponse.json({ erro: 'Erro ao gravar evento local.' }, { status: 500 });
  }

  const gravado = data as {
    result?: string;
    workspace_id?: string;
    message_id?: string;
    media?: { object_key?: string; status?: string } | null;
    ai?: { scheduled?: boolean; turn_id?: string; wait_ms?: number } | null;
  } | null;

  if (!gravado || gravado.result === 'unauthorized') {
    return NextResponse.json({ erro: 'Aparelho não autorizado ou chip desvinculado.' }, { status: 401 });
  }

  if (gravado.result === 'accepted' && gravado.workspace_id && gravado.ai?.scheduled && gravado.ai.turn_id && gravado.message_id) {
    const workspaceId = gravado.workspace_id;
    const vez = { vezId: gravado.ai.turn_id, gatilhoId: gravado.message_id };
    const esperaMs = typeof gravado.ai.wait_ms === 'number' && gravado.ai.wait_ms > 0 ? gravado.ai.wait_ms : 0;
    const ambiente = { supabase, prazo: chegouEm + orcamentoDoAtendente() };
    after(async () => {
      await atenderVez(ambiente, { workspaceId, ...vez, esperaMs });
      await atenderSobras(ambiente, workspaceId);
    });
  }

  return NextResponse.json(gravado);
}
