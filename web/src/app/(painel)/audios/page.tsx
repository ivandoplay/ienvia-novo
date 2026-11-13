import type { Metadata } from 'next';
import { carregarDadosAudios } from '@/lib/dados/recursos';
import { obterSessao } from '@/lib/sessao';
import { PainelDeAudios } from './painel-de-audios';

export const metadata: Metadata = {
  title: 'Biblioteca de Áudios',
};

export default async function PaginaDeAudios() {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!workspace) return null;

  const dados = await carregarDadosAudios(workspace.id);
  return <PainelDeAudios dados={dados} ehDono={workspace.papel === 'owner'} />;
}
