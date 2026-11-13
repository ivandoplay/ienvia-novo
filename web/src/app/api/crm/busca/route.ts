import { NextResponse } from 'next/server';
import { buscarGlobalNoWorkspace } from '@/lib/dados/inbox';
import { lerBusca } from '@/lib/inbox/regras';
import { obterSessao } from '@/lib/sessao';

export const dynamic = 'force-dynamic';

export async function GET(pedido: Request) {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!workspace) {
    return NextResponse.json({ conversas: [], contatos: [], notas: [] }, { status: 401 });
  }

  const url = new URL(pedido.url);
  const termo = lerBusca(url.searchParams.get('q'));
  if (!termo) {
    return NextResponse.json({ conversas: [], contatos: [], notas: [] });
  }

  const resultado = await buscarGlobalNoWorkspace(workspace.id, termo);
  return NextResponse.json(resultado);
}
