import type { Metadata } from 'next';
import { carregarDadosDeSeguranca } from '@/lib/dados/seguranca';
import { obterSessao } from '@/lib/sessao';
import { PainelDeSeguranca, type SecaoSeguranca } from './painel-de-seguranca';

export const metadata: Metadata = {
  title: 'Segurança',
};

const SECOES_VALIDAS = new Set<SecaoSeguranca>(['antiban', 'horario', 'fila', 'ignorados']);

export default async function PaginaDeSeguranca({
  searchParams,
}: {
  searchParams: Promise<{ secao?: string }>;
}) {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!workspace) return null;

  const params = await searchParams;
  const secaoParam = params.secao as SecaoSeguranca | undefined;
  const secaoInicial: SecaoSeguranca = secaoParam && SECOES_VALIDAS.has(secaoParam) ? secaoParam : 'antiban';

  const dados = await carregarDadosDeSeguranca(workspace.id);
  return <PainelDeSeguranca dados={dados} secaoInicial={secaoInicial} />;
}
