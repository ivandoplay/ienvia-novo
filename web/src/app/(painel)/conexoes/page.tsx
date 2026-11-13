import type { Metadata } from 'next';
import { carregarConexoesDoMotor } from '@/lib/dados/motor';
import { obterSessao } from '@/lib/sessao';
import { PainelDeConexoes } from './painel-de-conexoes';

export const metadata: Metadata = { title: 'Conexões / Motor' };

export default async function PaginaDeConexoes() {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!workspace) return null;

  const dados = await carregarConexoesDoMotor(workspace.id);
  return <PainelDeConexoes dados={dados} podeEditar={workspace.papel === 'owner'} />;
}
