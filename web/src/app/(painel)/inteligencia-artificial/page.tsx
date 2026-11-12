import type { Metadata } from 'next';
import { lerMotorDeIa } from '@/lib/dados/ia';
import { listarChips } from '@/lib/dados/instancias';
import { lerChaveDoCofre } from '@/lib/ia/cofre';
import { obterSessao } from '@/lib/sessao';
import { PainelDoMotor } from './painel-do-motor';

export const metadata: Metadata = { title: 'Motor de IA' };

/** Motor de IA: qual inteligência responde, com quais chaves, e como ela se comporta nas conversas. */
export default async function PaginaDoMotorDeIa() {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  // Sem login ou sem workspace, a moldura do painel já mostrou a tela certa.
  if (!workspace) return null;

  const [{ motor, falhou }, { chips }] = await Promise.all([lerMotorDeIa(workspace.id), listarChips(workspace.id)]);
  return (
    <PainelDoMotor
      motor={motor}
      falhouAoCarregar={falhou}
      cofreConfigurado={lerChaveDoCofre() !== null}
      chipsConectados={chips.filter((c) => c.estado === 'connected').map((c) => ({ id: c.id, apelido: c.apelido, telefone: c.telefone }))}
    />
  );
}
