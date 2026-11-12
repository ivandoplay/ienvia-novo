import type { Metadata } from 'next';
import { lerBaseDeTreinamento, lerBasesDeTreinamento } from '@/lib/dados/treinamento';
import { obterSessao } from '@/lib/sessao';
import { PainelDeTreinamento } from './painel-de-treinamento';

export const metadata: Metadata = { title: 'Treinamento' };

/**
 * Treinamento: o que a IA sabe sobre o negócio e como ela deve atender.
 * `?base=<id>` escolhe qual base de treinamento está aberta; sem isso, abre a padrão.
 */
export default async function PaginaDeTreinamento({ searchParams }: PageProps<'/treinamento'>) {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  // Sem login ou sem workspace, a moldura do painel já mostrou a tela certa.
  if (!workspace) return null;

  const { base: pedida } = await searchParams;
  const { lista, falhou } = await lerBasesDeTreinamento(workspace.id);
  if (!lista) return <PainelDeTreinamento key="sem-lista" lista={null} base={null} falhouAoCarregar={falhou} />;

  const escolhida = lista.bases.find((item) => item.id === pedida) ?? lista.bases.find((item) => item.padrao) ?? lista.bases[0] ?? null;
  const aberta = escolhida ? await lerBaseDeTreinamento(workspace.id, escolhida.id) : { base: null, falhou: false };

  // A chave faz a tela recomeçar do zero ao trocar de base (nada do rascunho de uma vaza para a outra).
  return <PainelDeTreinamento key={aberta.base?.id ?? 'sem-base'} lista={lista} base={aberta.base} falhouAoCarregar={aberta.falhou} />;
}
