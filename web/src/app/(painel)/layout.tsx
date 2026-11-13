import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { MolduraDoPainel } from '@/components/casca/moldura-do-painel';
import { ConfiguracaoPendente } from '@/components/configuracao-pendente';
import { lerConfigSupabase } from '@/lib/env';
import { obterSessao } from '@/lib/sessao';

/** Moldura de todas as abas de workspace. Só entra quem está logado. */
export default async function LayoutDoPainel({ children }: { children: ReactNode }) {
  if (!lerConfigSupabase()) return <ConfiguracaoPendente />;

  const sessao = await obterSessao();
  if (!sessao) redirect('/login');

  const workspace = sessao.workspaceAtivo;

  return (
    <MolduraDoPainel sessao={sessao}>
      {sessao.falhouAoCarregar ? (
        <FalhaAoCarregar />
      ) : workspace ? (
        children
      ) : (
        <SemWorkspace ehMaster={sessao.ehMaster} temContaDesativada={sessao.temContaDesativada} />
      )}
    </MolduraDoPainel>
  );
}

/** O login valeu, mas o banco não respondeu ao buscar as empresas da pessoa. */
function FalhaAoCarregar() {
  return (
    <div className="apoio">
      <div className="page-header">
        <div>
          <h1>Não foi possível carregar sua conta agora</h1>
          <p>O login funcionou, mas os dados não chegaram. Nada foi alterado. Espere um instante e tente de novo.</p>
        </div>
      </div>
      <div className="apoio-acoes">
        <Link href="/visao-geral" className="btn btn-primary">
          Tentar de novo
        </Link>
      </div>
    </div>
  );
}

/** A conta existe, mas não tem um workspace ativo ligado agora. */
function SemWorkspace({ ehMaster, temContaDesativada }: { ehMaster: boolean; temContaDesativada: boolean }) {
  if (temContaDesativada && !ehMaster) {
    return (
      <div className="apoio">
        <div className="page-header">
          <div>
            <h1>Esta conta está desativada</h1>
            <p>
              O acesso a este workspace foi pausado temporariamente pelo administrador da plataforma. Entre em contato
              com o suporte para reativar.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (ehMaster) {
    return (
      <div className="apoio">
        <div className="page-header">
          <div>
            <h1>Nenhum workspace selecionado</h1>
            <p>
              Você está conectado como administrador da plataforma. Abra a área Clientes SaaS para criar contas,
              ajustar limites ou entrar em Modo Suporte em qualquer cliente.
            </p>
          </div>
        </div>
        <div className="apoio-acoes">
          <Link href="/contas" className="btn btn-primary">
            Abrir Clientes SaaS
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="apoio">
      <div className="page-header">
        <div>
          <h1>Sua conta ainda não tem um workspace</h1>
          <p>
            O login funcionou, mas esta conta não está ligada a nenhuma empresa. Peça ao administrador da plataforma
            para liberar o seu acesso.
          </p>
        </div>
      </div>
    </div>
  );
}
