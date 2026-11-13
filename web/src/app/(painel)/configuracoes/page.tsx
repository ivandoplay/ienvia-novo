import type { Metadata } from 'next';
import { carregarConfiguracoes } from '@/lib/dados/configuracoes';
import { obterSessao } from '@/lib/sessao';
import { PainelDeConfiguracoes } from './painel-de-configuracoes';

export const metadata: Metadata = {
  title: 'Geral',
};

export default async function PaginaDeConfiguracoes() {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!sessao || !workspace) return null;

  const dados = await carregarConfiguracoes(workspace.id, sessao.usuario.id);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Geral</h1>
          <p>Nome e marca do sistema, sua senha de acesso, política de limpeza LGPD e exportação dos seus dados.</p>
        </div>
      </div>

      {dados.falhou ? (
        <div className="f7-alert f7-alert--erro">
          Não foi possível ler todas as configurações agora. Atualize a página para tentar novamente.
        </div>
      ) : null}

      <PainelDeConfiguracoes
        key={workspace.id}
        dados={dados}
        papel={workspace.papel}
        loginUsuario={sessao.usuario.login}
        workspaces={sessao.workspaces}
        emModoSuporte={Boolean(sessao.modoSuporte)}
      />
    </div>
  );
}
