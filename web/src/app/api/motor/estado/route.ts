import { after, NextResponse } from 'next/server';
import { enviarAlertaViaRpc, textoAlertaDesconexao } from '@/lib/atendente/alertas';
import { extrairTokenDoMotor, sha256Hex } from '@/lib/motor/autenticacao';
import { criarClienteDeServico } from '@/lib/supabase/servico';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const token = extrairTokenDoMotor(req);
  if (!token) return NextResponse.json({ erro: 'Token do motor ausente.' }, { status: 401 });

  let corpo: {
    instance_id?: string;
    status?: string;
    connected_phone?: string | null;
    pairing_qr?: string | null;
    pairing_code?: string | null;
  } = {};
  try {
    corpo = (await req.json()) as typeof corpo;
  } catch {
    return NextResponse.json({ erro: 'JSON inválido.' }, { status: 400 });
  }

  if (!corpo.instance_id || !['disconnected', 'connecting', 'connected', 'error'].includes(String(corpo.status))) {
    return NextResponse.json({ erro: 'Parâmetros de estado inválidos.' }, { status: 400 });
  }

  const supabase = criarClienteDeServico();
  if (!supabase) return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });

  const { data, error } = await supabase.rpc('report_local_instance_state', {
    p_token_sha256: sha256Hex(token),
    p_instance_id: corpo.instance_id,
    p_status: corpo.status,
    p_connected_phone: corpo.connected_phone ?? null,
    p_pairing_qr: corpo.pairing_qr ?? null,
    p_pairing_code: corpo.pairing_code ?? null,
  });

  if (error) {
    console.error('[motor/estado] erro:', error);
    return NextResponse.json({ erro: 'Falha ao atualizar estado do chip.' }, { status: 500 });
  }

  const res = data as {
    result?: string;
    id?: string;
    workspace_id?: string;
    display_name?: string;
    alert_disconnected?: boolean;
  } | null;
  if (res?.result === 'unauthorized') return NextResponse.json({ erro: 'Aparelho não autorizado.' }, { status: 401 });
  if (res?.result === 'instance_not_found') return NextResponse.json({ erro: 'Chip não encontrado neste aparelho.' }, { status: 404 });

  if (res?.alert_disconnected && res.workspace_id) {
    const wsId = res.workspace_id;
    const chipNome = res.display_name ?? null;
    const chipId = res.id ?? null;
    after(async () => {
      await enviarAlertaViaRpc({
        supabase,
        workspaceId: wsId,
        kind: 'chip_disconnected',
        bodyText: textoAlertaDesconexao(chipNome, 'Motor Local'),
        preferredInstanceId: chipId,
      });
    });
  }

  return NextResponse.json(res ?? { result: 'ok' });
}
