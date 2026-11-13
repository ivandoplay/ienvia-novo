import type { Metadata } from 'next';
import { carregarDadosDasCampanhas } from '@/lib/dados/campanhas';
import { obterSessao } from '@/lib/sessao';
import { PainelDeCampanhas } from './painel-de-campanhas';

export const metadata: Metadata = {
  title: 'Campanhas',
};

export default async function PaginaDeCampanhas() {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!workspace) return null;

  const dados = await carregarDadosDasCampanhas(workspace.id);
  return <PainelDeCampanhas dados={dados} />;
}
