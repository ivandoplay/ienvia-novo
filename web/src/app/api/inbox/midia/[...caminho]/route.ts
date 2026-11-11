import { lerConfigSupabase } from '@/lib/env';
import { DEPOSITO, ehCaminhoDeArquivo, nomeParaBaixar } from '@/lib/inbox/arquivos';
import { enderecoDoDepositoParaONavegador } from '@/lib/supabase/deposito';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Mostra (ou baixa) um arquivo da Inbox: /api/inbox/midia/<empresa>/<conversa>/<mensagem>/<nome>.
 *
 * O arquivo fica num depósito fechado. Esta rota pede ao depósito, COM A SESSÃO DE QUEM ESTÁ LOGADO,
 * um endereço assinado que vale por pouco tempo, e manda o navegador para ele. Quem decide se a pessoa
 * pode ver é o depósito: só passa quem participa da empresa dona do arquivo. Para todos os outros
 * (sem login, de outra empresa) a resposta é a mesma de um arquivo que não existe.
 *
 * Esta rota não passa pelo proxy (src/proxy.ts), pelo mesmo motivo de /api/inbox/versao.
 */
export const dynamic = 'force-dynamic';

/** Por quanto tempo o endereço assinado vale. */
const VALIDADE_EM_SEGUNDOS = 60 * 60;
/**
 * Por quanto tempo o navegador pode reaproveitar o redirecionamento (menos que a validade, com folga).
 * Sem isso, cada vez que a conversa é reaberta todas as fotos seriam baixadas de novo.
 */
const REAPROVEITAR_POR_SEGUNDOS = 30 * 60;

const naoEncontrado = () =>
  new Response('Arquivo não encontrado. Ele pode ter sido apagado, ou a sua sessão terminou: entre de novo e abra a conversa.', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function GET(pedido: Request, contexto: { params: Promise<{ caminho: string[] }> }): Promise<Response> {
  const { caminho: partes } = await contexto.params;
  const caminho = Array.isArray(partes) ? partes.join('/') : '';
  if (!ehCaminhoDeArquivo(caminho)) return naoEncontrado();
  if (!lerConfigSupabase()) return new Response('Painel sem configuração.', { status: 503, headers: { 'cache-control': 'no-store' } });

  const baixarComo = nomeParaBaixar(new URL(pedido.url).searchParams.get('baixar'));
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.storage.from(DEPOSITO).createSignedUrl(caminho, VALIDADE_EM_SEGUNDOS);

  if (error || !data?.signedUrl) {
    // "Não existe" e "você não pode ver" chegam iguais do depósito, de propósito.
    const esperado = /not found|not_found|does not exist/i.test(error?.message ?? '');
    if (!esperado) console.error('[inbox] não foi possível assinar o endereço de um arquivo:', { mensagem: error?.message });
    return naoEncontrado();
  }

  // "download=<nome>" faz o depósito mandar o arquivo para baixar, já com o nome que a pessoa conhece.
  // (O nome é juntado aqui, e não pela biblioteca do Supabase, que estraga nomes com acento.)
  const assinado = baixarComo ? `${data.signedUrl}&download=${encodeURIComponent(baixarComo)}` : data.signedUrl;

  return new Response(null, {
    status: 302,
    headers: {
      location: enderecoDoDepositoParaONavegador(assinado),
      // Só o navegador desta pessoa guarda, e só enquanto os cookies dela forem os mesmos.
      'cache-control': `private, max-age=${REAPROVEITAR_POR_SEGUNDOS}`,
      vary: 'Cookie',
    },
  });
}
