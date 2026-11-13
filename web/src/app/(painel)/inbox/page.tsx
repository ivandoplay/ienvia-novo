import type { Metadata } from 'next';
import {
  carregarCatalogosDoCrm,
  carregarConversa,
  carregarDiretorioDeContatos,
  carregarInbox,
  carregarKanban,
  lerCanalDaInbox,
  lerVersaoDaInbox,
  listarChipsDaInbox,
} from '@/lib/dados/inbox';
import { carregarRecursosDaInbox } from '@/lib/dados/recursos';
import { lerConfigEvolution, lerConfigSupabase } from '@/lib/env';
import {
  lerAbaDoCrm,
  lerBusca,
  lerEtapaDoKanban,
  lerFiltroDeNegocio,
  lerLimite,
  lerLimiteDeMensagens,
  lerUuidOpcional,
  lerVisao,
} from '@/lib/inbox/regras';
import { ehIdentificador } from '@/lib/instancias/regras';
import { obterSessao } from '@/lib/sessao';
import { PainelDaInbox } from './painel-da-inbox';

export const metadata: Metadata = { title: 'Inbox' };

/** Um envio espera a resposta da Evolution por até 25 segundos; o servidor precisa aguentar esse tempo. */
export const maxDuration = 60;

type Parametros = Record<string, string | string[] | undefined>;

const primeiro = (valor: string | string[] | undefined): string | undefined => (Array.isArray(valor) ? valor[0] : valor);

/**
 * Inbox & CRM completo: Conversas (WhatsApp), Contatos (Agenda) e Kanban (Funil de Vendas).
 * Tudo fica sincronizado na URL (?aba=, ?ver=, ?chip=, ?etiqueta=, ?negocio=, ?busca=, ?c=).
 */
export default async function PaginaDaInbox({ searchParams }: { searchParams: Promise<Parametros> }) {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  if (!workspace) return null;

  const parametros = await searchParams;
  const chip = primeiro(parametros.chip);
  const conversa = primeiro(parametros.c);
  const conversaId = ehIdentificador(conversa) ? conversa : null;
  const abaSolicitada = lerAbaDoCrm(primeiro(parametros.aba));
  // Abrir ?c= diretamente mostra sempre a conversa.
  const aba = conversaId ? 'conversas' : abaSolicitada;

  const filtros = {
    visao: lerVisao(primeiro(parametros.ver)),
    chipId: ehIdentificador(chip) ? chip : null,
    busca: lerBusca(primeiro(parametros.busca)),
    limite: lerLimite(primeiro(parametros.limite)),
    etiquetaId: lerUuidOpcional(primeiro(parametros.etiqueta)),
    negocio: lerFiltroDeNegocio(primeiro(parametros.negocio)),
    etapaCrm: lerEtapaDoKanban(primeiro(parametros.etapa)),
  };
  const limiteDeMensagens = lerLimiteDeMensagens(primeiro(parametros.m));

  const agora = new Date();
  const [versao, canalRealtime] = await Promise.all([lerVersaoDaInbox(workspace.id), lerCanalDaInbox(workspace.id)]);

  const [chips, catalogos, recursos, lista, aberta, contatosDir, kanban] = await Promise.all([
    listarChipsDaInbox(workspace.id),
    carregarCatalogosDoCrm(workspace.id),
    carregarRecursosDaInbox(workspace.id),
    aba === 'conversas'
      ? carregarInbox(workspace.id, filtros, agora)
      : Promise.resolve({ conversas: [], temMais: false, contagens: null, falhou: false }),
    aba === 'conversas' && conversaId ? carregarConversa(workspace.id, conversaId, limiteDeMensagens, agora) : Promise.resolve(null),
    aba === 'contatos'
      ? carregarDiretorioDeContatos(workspace.id, { busca: filtros.busca, etiquetaId: filtros.etiquetaId }, agora)
      : Promise.resolve({ contatos: [], total: 0, falhou: false }),
    aba === 'kanban'
      ? carregarKanban(workspace.id, { chipId: filtros.chipId, etiquetaId: filtros.etiquetaId, busca: filtros.busca }, agora)
      : Promise.resolve({ cartoes: [], falhou: false }),
  ]);

  return (
    <PainelDaInbox
      workspaceId={workspace.id}
      versao={versao}
      canalRealtime={canalRealtime}
      supabasePublico={lerConfigSupabase()}
      aba={aba}
      filtros={filtros}
      lista={lista}
      chips={chips}
      catalogos={catalogos}
      recursos={recursos}
      contatosDir={contatosDir}
      kanban={kanban}
      conversaId={conversaId}
      aberta={aberta}
      limiteDeMensagens={limiteDeMensagens}
      ehDono={workspace.papel === 'owner'}
      evolutionConfigurada={lerConfigEvolution() !== null}
    />
  );
}
