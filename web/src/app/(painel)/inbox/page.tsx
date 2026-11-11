import type { Metadata } from 'next';
import { carregarConversa, carregarInbox, lerVersaoDaInbox, listarChipsDaInbox } from '@/lib/dados/inbox';
import { lerConfigEvolution } from '@/lib/env';
import { lerBusca, lerLimite, lerLimiteDeMensagens, lerVisao } from '@/lib/inbox/regras';
import { ehIdentificador } from '@/lib/instancias/regras';
import { obterSessao } from '@/lib/sessao';
import { PainelDaInbox } from './painel-da-inbox';

export const metadata: Metadata = { title: 'Inbox' };

/** Um envio espera a resposta da Evolution por até 25 segundos; o servidor precisa aguentar esse tempo. */
export const maxDuration = 60;

type Parametros = Record<string, string | string[] | undefined>;

const primeiro = (valor: string | string[] | undefined): string | undefined => (Array.isArray(valor) ? valor[0] : valor);

/**
 * Inbox: as conversas do WhatsApp, a conversa aberta e os dados do contato.
 * Tudo o que está na tela mora no endereço (?ver=, ?chip=, ?busca=, ?c=), então o botão "voltar"
 * do navegador funciona e um endereço copiado abre exatamente a mesma coisa.
 */
export default async function PaginaDaInbox({ searchParams }: { searchParams: Promise<Parametros> }) {
  const sessao = await obterSessao();
  const workspace = sessao?.workspaceAtivo;
  // Sem login ou sem workspace, a moldura do painel já mostrou a tela certa.
  if (!workspace) return null;

  const parametros = await searchParams;
  const chip = primeiro(parametros.chip);
  const conversa = primeiro(parametros.c);
  const filtros = {
    visao: lerVisao(primeiro(parametros.ver)),
    chipId: ehIdentificador(chip) ? chip : null,
    busca: lerBusca(primeiro(parametros.busca)),
    limite: lerLimite(primeiro(parametros.limite)),
  };
  const conversaId = ehIdentificador(conversa) ? conversa : null;
  const limiteDeMensagens = lerLimiteDeMensagens(primeiro(parametros.m));

  const agora = new Date();
  // A versão é lida ANTES dos dados: assim o que vai para a tela nunca é mais velho do que a versão
  // que a tela guarda (se fosse, uma mensagem nova poderia passar despercebida).
  const versao = await lerVersaoDaInbox(workspace.id);
  const [lista, chips, aberta] = await Promise.all([
    carregarInbox(workspace.id, filtros, agora),
    listarChipsDaInbox(workspace.id),
    conversaId ? carregarConversa(workspace.id, conversaId, limiteDeMensagens, agora) : null,
  ]);

  return (
    <PainelDaInbox
      workspaceId={workspace.id}
      versao={versao}
      filtros={filtros}
      lista={lista}
      chips={chips}
      conversaId={conversaId}
      aberta={aberta}
      limiteDeMensagens={limiteDeMensagens}
      ehDono={workspace.papel === 'owner'}
      evolutionConfigurada={lerConfigEvolution() !== null}
    />
  );
}
