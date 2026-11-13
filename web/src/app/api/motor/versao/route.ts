import { NextResponse } from 'next/server';
import { obterVersaoEAssinatura } from '@/lib/motor/assinatura';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const info = obterVersaoEAssinatura();
  if (!info.disponivel || !info.manifesto) {
    return NextResponse.json({ erro: 'Pacote do motor indisponível neste servidor.' }, { status: 503 });
  }
  if (!info.envelope) {
    return NextResponse.json(
      {
        manifest: info.manifesto,
        algorithm: 'ed25519',
        signature: null,
        signed: false,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }
  return NextResponse.json(
    {
      ...info.envelope,
      signed: true,
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
