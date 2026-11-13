import type { ReactNode } from 'react';
import { MARCA_PADRAO, apelidoDoLogin, iniciais } from '@ienvia/shared';
import { Casca } from '@/components/casca/casca';
import { carregarResumoDaIa } from '@/lib/dados/atendente';
import { resumirInstancias } from '@/lib/dados/visao-geral';
import { resumoDeConexao } from '@/lib/formato';
import { menuParaUsuario } from '@/lib/navegacao';
import { rotuloDoPapel, type Sessao } from '@/lib/sessao';

export async function MolduraDoPainel({ sessao, children }: { sessao: Sessao; children: ReactNode }) {
  const workspace = sessao.workspaceAtivo;
  const [instancias, ia] = workspace
    ? await Promise.all([resumirInstancias(workspace.id), carregarResumoDaIa(workspace.id)])
    : [null, null];

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
      workspaceAtivoId={workspace?.id ?? null}
      workspaces={sessao.workspaces.map((w) => ({ id: w.id, nome: w.nome, papel: w.papel }))}
      marca={
        workspace
          ? { nome: workspace.brandName, subtitulo: workspace.brandSubtitle }
          : { nome: MARCA_PADRAO.nomeDaMarca, subtitulo: MARCA_PADRAO.subtituloDaMarca }
      }
      modoSuporte={sessao.modoSuporte}
      conexao={conexao}
      ia={ia}
    >
      {children}
    </Casca>
  );
}
