import type { Metadata } from 'next';
import { carregarDadosCatalogo } from '@/lib/dados/recursos';
import { obterSessao } from '@/lib/sessao';
import { PainelDeCatalogo } from './painel-de-catalogo';

export const metadata: Metadata = {
  title: 'Catálogo & PIX',
};

export default async function PaginaDeCatalogo() {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!workspace) return null;

  const dados = await carregarDadosCatalogo(workspace.id);
  return <PainelDeCatalogo dados={dados} ehDono={workspace.papel === 'owner'} />;
}
