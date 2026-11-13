import { lerConfigSupabase } from '@/lib/env';
import { DEPOSITO, ehCaminhoDeRecurso, nomeParaBaixar } from '@/lib/inbox/arquivos';
import { enderecoDoDepositoParaONavegador } from '@/lib/supabase/deposito';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export const dynamic = 'force-dynamic';

const VALIDADE_EM_SEGUNDOS = 60 * 60;
const REAPROVEITAR_POR_SEGUNDOS = 30 * 60;

const naoEncontrado = () =>
  new Response('Arquivo não encontrado ou sessão expirada.', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function GET(pedido: Request, contexto: { params: Promise<{ caminho: string[] }> }): Promise<Response> {
  const { caminho: partes } = await contexto.params;
  const caminho = Array.isArray(partes) ? partes.join('/') : '';
  if (!ehCaminhoDeRecurso(caminho)) return naoEncontrado();
  if (!lerConfigSupabase()) return new Response('Painel sem configuração.', { status: 503, headers: { 'cache-control': 'no-store' } });

  const baixarComo = nomeParaBaixar(new URL(pedido.url).searchParams.get('baixar'));
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.storage.from(DEPOSITO).createSignedUrl(caminho, VALIDADE_EM_SEGUNDOS);

  if (error || !data?.signedUrl) {
    const esperado = /not found|not_found|does not exist/i.test(error?.message ?? '');
    if (!esperado) console.error('[recursos] não foi possível assinar mídia:', { mensagem: error?.message });
    return naoEncontrado();
  }

  const assinado = baixarComo ? `${data.signedUrl}&download=${encodeURIComponent(baixarComo)}` : data.signedUrl;

  return new Response(null, {
    status: 302,
    headers: {
      location: enderecoDoDepositoParaONavegador(assinado),
      'cache-control': `private, max-age=${REAPROVEITAR_POR_SEGUNDOS}`,
      vary: 'Cookie',
    },
  });
}
