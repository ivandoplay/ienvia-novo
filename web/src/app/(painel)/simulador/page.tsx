import type { Metadata } from 'next';
import { carregarDadosSimulador } from '@/lib/dados/recursos';
import { obterSessao } from '@/lib/sessao';
import { PainelDoSimulador } from './painel-do-simulador';

export const metadata: Metadata = {
  title: 'Simulador',
};

export const maxDuration = 60;

export default async function PaginaDoSimulador() {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!workspace) return null;

  const dados = await carregarDadosSimulador(workspace.id);
  return <PainelDoSimulador dados={dados} />;
}
