import { NextResponse } from 'next/server';
import { gerarPacoteDoMotor } from '@/lib/motor/pacote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const pacote = gerarPacoteDoMotor();
  if (!pacote) {
    return NextResponse.json({ erro: 'Pacote do motor não encontrado.' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(pacote.buffer), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="ienvia-motor-v${pacote.version}.zip"`,
      'content-length': String(pacote.size),
      'x-motor-version': pacote.version,
      'x-motor-sha256': pacote.sha256,
      'cache-control': 'no-store',
    },
  });
}
