import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { apelidoDoLogin, iniciais } from '@ienvia/shared';
import { Casca } from '@/components/casca/casca';
import { ConfiguracaoPendente } from '@/components/configuracao-pendente';
import { carregarResumoDaIa } from '@/lib/dados/atendente';
import { resumirInstancias } from '@/lib/dados/visao-geral';
import { lerConfigSupabase } from '@/lib/env';
import { resumoDeConexao } from '@/lib/formato';
import { menuParaUsuario } from '@/lib/navegacao';
import { obterSessao, rotuloDoPapel } from '@/lib/sessao';

/** Moldura de todas as abas do painel. Só entra quem está logado. */
export default async function LayoutDoPainel({ children }: { children: ReactNode }) {
  if (!lerConfigSupabase()) return <ConfiguracaoPendente />;

  const sessao = await obterSessao();
  if (!sessao) redirect('/login');

  const workspace = sessao.workspaceAtivo;
  const [instancias, ia] = workspace ? await Promise.all([resumirInstancias(workspace.id), carregarResumoDaIa(workspace.id)]) : [null, null];
  const conexao = instancias
    ? resumoDeConexao(instancias.conectadas, instancias.total)
    : { texto: 'Sem informação', conectado: false };


  return (
    <Casca
      menu={menuParaUsuario(sessao.ehMaster)}
      usuario={{
        nome: sessao.usuario.nome,
        login: sessao.usuario.login,
        apelido: apelidoDoLogin(sessao.usuario.login),
        iniciais: iniciais(sessao.usuario.nome),
        papel: rotuloDoPapel(sessao),
      }}
      workspace={workspace?.nome ?? 'Nenhum workspace'}
      conexao={conexao}
      ia={ia}
    >
      {sessao.falhouAoCarregar ? <FalhaAoCarregar /> : workspace ? children : <SemWorkspace />}
    </Casca>
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

/** A conta existe, mas ainda não foi ligada a nenhuma empresa. */
function SemWorkspace() {
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
