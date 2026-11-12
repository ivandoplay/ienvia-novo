/**
 * Sonda simples para provedores de hospedagem (Render, Netlify e monitoramento) confirmarem
 * que o painel está no ar, sem consultar o banco nem expor configurações.
 */
export async function GET(): Promise<Response> {
  return Response.json({ ok: true, servico: 'ienvia-painel' });
}
