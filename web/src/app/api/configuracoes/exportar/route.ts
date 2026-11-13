import { sanitizarObjetoParaExportacao } from '@ienvia/shared/contas';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export const dynamic = 'force-dynamic';

function slugArquivo(nome: string): string {
  const base = nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'workspace';
}

export async function GET() {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) {
    return Response.json({ erro: 'Faça login para exportar os dados.' }, { status: 401 });
  }
  if (sessao.workspaceAtivo.papel !== 'owner') {
    return Response.json({ erro: 'Somente o proprietário da conta pode exportar todos os dados.' }, { status: 403 });
  }

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('export_my_workspace_snapshot', {
    p_workspace_id: sessao.workspaceAtivo.id,
  });

  if (error || !data) {
    console.error('[exportação] falha ao gerar cópia do workspace:', error);
    return Response.json({ erro: 'Não foi possível gerar a cópia dos dados agora.' }, { status: 500 });
  }

  const sanitizado = sanitizarObjetoParaExportacao(data);
  const dia = new Date().toISOString().slice(0, 10);
  const nomeArquivo = `ienvia-dados-${slugArquivo(sessao.workspaceAtivo.nome)}-${dia}.json`;

  return new Response(JSON.stringify(sanitizado, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${nomeArquivo}"`,
      'cache-control': 'no-store',
    },
  });
}
