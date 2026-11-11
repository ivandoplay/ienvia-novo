import { lerConfigSupabase } from '@/lib/env';
import { ehIdentificador } from '@/lib/instancias/regras';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * "Mudou alguma coisa na Inbox?" A tela aberta pergunta isto a cada poucos segundos e só recarrega
 * quando a resposta muda. É de propósito a consulta mais barata do painel: uma única ida ao banco.
 *
 * Esta rota não passa pelo proxy (src/proxy.ts). Quem confere a pessoa é o próprio banco: o pedido
 * vai com a sessão dela e a função read_my_inbox_version só responde a quem participa da empresa.
 */
export const dynamic = 'force-dynamic';

const responder = (status: number, corpo: Record<string, unknown>) =>
  Response.json(corpo, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(pedido: Request): Promise<Response> {
  const workspaceId = new URL(pedido.url).searchParams.get('w');
  if (!ehIdentificador(workspaceId)) return responder(400, { erro: 'pedido inválido' });
  if (!lerConfigSupabase()) return responder(503, { erro: 'painel sem configuração' });

  const supabase = await criarClienteServidor();
  const { data, error, status } = await supabase.rpc('read_my_inbox_version', { p_workspace_id: workspaceId });

  if (error) {
    // Sem sessão (ou com a sessão vencida) o banco nem deixa executar a função.
    const semSessao = status === 401 || status === 403 || error.code === '42501';
    if (!semSessao) console.error('[inbox] não foi possível ler a versão:', { status, codigo: error.code, mensagem: error.message });
    return semSessao ? responder(401, { erro: 'Faça login para continuar.' }) : responder(500, { erro: 'não foi possível conferir' });
  }
  return responder(200, { versao: typeof data === 'string' ? data : '' });
}
