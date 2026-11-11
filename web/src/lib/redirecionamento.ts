/**
 * Depois do login a pessoa volta para a aba que tentou abrir. O destino vem da URL,
 * então só aceitamos caminhos internos do painel — nunca um endereço de outro site.
 */
export const DESTINO_PADRAO = '/visao-geral';

export function destinoSeguro(valor: unknown): string {
  if (typeof valor !== 'string') return DESTINO_PADRAO;
  const caminho = valor.trim();

  const ehInterno =
    caminho.startsWith('/') &&
    !caminho.startsWith('//') &&
    !caminho.includes('\\') &&
    !caminho.includes('://') &&
    !/[\u0000-\u001f]/.test(caminho);
  if (!ehInterno || caminho.length > 200) return DESTINO_PADRAO;

  if (caminho === '/' || caminho === '/login' || caminho.startsWith('/login?') || caminho.startsWith('/api/')) {
    return DESTINO_PADRAO;
  }
  return caminho;
}
