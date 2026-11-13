import type { Metadata } from 'next';
import { carregarContasSaas } from '@/lib/dados/contas';
import { obterSessao } from '@/lib/sessao';
import { PainelDeContas } from './painel-de-contas';

export const metadata: Metadata = {
  title: 'Clientes SaaS',
};

export default async function PaginaDeContas() {
  const sessao = await obterSessao();
  if (!sessao?.ehMaster) return null;

  const dados = await carregarContasSaas();

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Clientes SaaS</h1>
          <p>
            Cadastre empresas, defina limites de chips, ative ou desative contas e acesse o Modo Suporte com trilha de
            auditoria.
          </p>
        </div>
      </div>

      {dados.falhou ? (
        <div className="f7-alert f7-alert--erro">
          Não foi possível carregar a lista de clientes agora. Atualize a página para tentar novamente.
        </div>
      ) : null}

      <PainelDeContas
        contasIniciais={dados.contas}
        auditoriaInicial={dados.auditoria}
        modoSuporte={sessao.modoSuporte}
      />
    </div>
  );
}
