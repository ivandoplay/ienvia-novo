import type { Metadata } from 'next';
import { listarChips } from '@/lib/dados/instancias';
import { enderecoPublico, lerConfigEvolution } from '@/lib/env';
import { obterSessao } from '@/lib/sessao';
import { PainelDeChips } from './painel-de-chips';

export const metadata: Metadata = { title: 'Instâncias' };

/** Instâncias: os chips de WhatsApp da conta — conectar, apelidar, escolher a função e remover. */
export default async function PaginaDeInstancias() {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  // Sem login ou sem workspace, a moldura do painel já mostrou a tela certa.
  if (!workspace) return null;

  const { chips, falhou } = await listarChips(workspace.id);

  return (
    <PainelDeChips
      chips={chips}
      limite={workspace.limiteDeChips}
      podeEditar={workspace.papel === 'owner'}
      evolutionConfigurada={lerConfigEvolution() !== null}
      temEnderecoPublico={enderecoPublico() !== null}
      falhouAoCarregar={falhou}
    />
  );
}
