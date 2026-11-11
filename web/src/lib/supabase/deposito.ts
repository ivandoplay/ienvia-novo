import 'server-only';

/**
 * O depósito de arquivos (Supabase Storage), visto pelo NAVEGADOR.
 *
 * Os arquivos da Inbox nunca passam pelo servidor do painel no caminho de ida e volta do navegador:
 * o servidor só assina um endereço de uso único e curto, e o navegador fala direto com o depósito.
 *
 * Em produção esse endereço é o do próprio Supabase. Só em desenvolvimento existe um desvio
 * (IENVIA_DEPOSITO_PELO_PAINEL=1): os endereços passam pelo próprio painel, em /_deposito/..., para
 * prévias em que o navegador não alcança o Supabase diretamente (ver next.config.ts).
 */
export function enderecoDoDepositoParaONavegador(enderecoAssinado: string, ambiente: NodeJS.ProcessEnv = process.env): string {
  if (ambiente.NODE_ENV === 'production' || ambiente.IENVIA_DEPOSITO_PELO_PAINEL !== '1') return enderecoAssinado;
  const base = `${ambiente.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '')}/storage/v1/`;
  return enderecoAssinado.startsWith(base) ? `/_deposito/${enderecoAssinado.slice(base.length)}` : enderecoAssinado;
}
