/**
 * O menu do painel, num lugar só.
 * A barra lateral, a barra inferior do celular e as telas "em construção" leem daqui.
 * Para uma aba nova aparecer no menu, basta acrescentá-la nesta lista.
 */
import type { NomeIcone } from '@/components/ui/icone';

export interface ItemMenu {
  /** Endereço da aba, começando com "/". */
  rota: string;
  rotulo: string;
  icone: NomeIcone;
  /** O que a aba faz (aparece na dica do menu e na tela "em construção"). */
  descricao: string;
  /** Fase do plano (docs/PLANO.md) em que a aba fica pronta. */
  fase: number;
  /** A aba só aparece para o administrador da plataforma (master). */
  somenteMaster?: boolean;
}

export interface SecaoMenu {
  id: string;
  rotulo: string;
  icone: NomeIcone;
  itens: ItemMenu[];
}

export interface GrupoMenu {
  rotulo: string;
  /** Itens soltos, direto no grupo. */
  itens: ItemMenu[];
  /** Subgrupos que abrem e fecham. */
  secoes: SecaoMenu[];
}

export const MENU: GrupoMenu[] = [
  {
    rotulo: 'Workspace',
    secoes: [],
    itens: [
      {
        rota: '/visao-geral',
        rotulo: 'Visão geral',
        icone: 'visaoGeral',
        descricao: 'Tudo o que está acontecendo na sua operação, num lugar só.',
        fase: 0,
      },
      {
        rota: '/inbox',
        rotulo: 'Inbox',
        icone: 'inbox',
        descricao: 'Caixa de entrada do WhatsApp: conversas, contatos, Kanban, ficha do cliente e o histórico de cada chip.',
        fase: 1,
      },
      {
        rota: '/campanhas',
        rotulo: 'Campanhas',
        icone: 'campanhas',
        descricao: 'Disparo de mensagens em lote, com prévia, intervalos e acompanhamento de cada envio.',
        fase: 5,
      },
    ],
  },
  {
    rotulo: 'Inteligência artificial',
    itens: [],
    secoes: [
      {
        id: 'ia',
        rotulo: 'IA e automação',
        icone: 'secaoIa',
        itens: [
          {
            rota: '/treinamento',
            rotulo: 'Treinamento',
            icone: 'treinamento',
            descricao: 'Ensine o atendente: identidade do negócio, regras, perguntas frequentes, arquivos de consulta e modelos prontos por ramo.',
            fase: 2,
          },
          {
            rota: '/catalogo',
            rotulo: 'Catálogo & PIX',
            icone: 'catalogo',
            descricao: 'Produtos com fotos e a chave PIX que o atendente pode enviar na conversa.',
            fase: 6,
          },
          {
            rota: '/audios',
            rotulo: 'Áudios',
            icone: 'audios',
            descricao: 'Áudios gravados na sua voz, enviados como mensagem de voz do WhatsApp.',
            fase: 6,
          },
          {
            rota: '/simulador',
            rotulo: 'Simulador',
            icone: 'simulador',
            descricao: 'Teste as respostas da IA antes de ligar o atendimento de verdade.',
            fase: 6,
          },
          {
            rota: '/inteligencia-artificial',
            rotulo: 'Motor de IA',
            icone: 'motorIa',
            descricao: 'Chaves do Gemini, do OpenRouter e da NVIDIA, modelos e o que fazer quando um deles falha.',
            fase: 2,
          },
        ],
      },
      {
        id: 'canais',
        rotulo: 'Canais e conexões',
        icone: 'secaoCanais',
        itens: [
          {
            rota: '/instancias',
            rotulo: 'Instâncias',
            icone: 'instancias',
            descricao: 'Conecte cada chip por QR Code ou código, dê um apelido e escolha o que ele faz.',
            fase: 1,
          },
          {
            rota: '/conexoes',
            rotulo: 'Conexões / Motor',
            icone: 'conexoes',
            descricao: 'O motor local que roda no seu aparelho: versão instalada, atualização e download.',
            fase: 4,
          },
        ],
      },
    ],
  },
  {
    rotulo: 'Administração',
    itens: [],
    secoes: [
      {
        id: 'gestao',
        rotulo: 'Configurações',
        icone: 'secaoGestao',
        itens: [
          {
            rota: '/configuracoes',
            rotulo: 'Geral',
            icone: 'configuracoes',
            descricao: 'Nome e marca do sistema, cópia de segurança e dados da conta.',
            fase: 7,
          },
          {
            rota: '/seguranca',
            rotulo: 'Segurança',
            icone: 'seguranca',
            descricao: 'Proteção anti-bloqueio, horário de atendimento, alertas no seu WhatsApp e contatos ignorados.',
            fase: 5,
          },
          {
            rota: '/contas',
            rotulo: 'Clientes SaaS',
            icone: 'contas',
            descricao: 'Criar e administrar as contas dos seus clientes, limites de chips e modo suporte.',
            fase: 7,
            somenteMaster: true,
          },
        ],
      },
    ],
  },
];

/**
 * Atalhos da barra inferior do celular (o quinto botão, "Mais", abre o menu completo).
 * Cada atalho fica aceso quando a pessoa está em qualquer aba do seu grupo.
 */
export const ATALHOS_CELULAR: Array<{ rota: string; rotulo: string; icone: NomeIcone; rotasDoGrupo: string[] }> = [
  { rota: '/visao-geral', rotulo: 'Início', icone: 'visaoGeral', rotasDoGrupo: ['/visao-geral'] },
  { rota: '/inbox', rotulo: 'Inbox', icone: 'inbox', rotasDoGrupo: ['/inbox'] },
  {
    rota: '/treinamento',
    rotulo: 'Atendente',
    icone: 'treinamento',
    rotasDoGrupo: ['/treinamento', '/catalogo', '/audios', '/simulador'],
  },
  {
    rota: '/inteligencia-artificial',
    rotulo: 'Ajustes',
    icone: 'engrenagem',
    rotasDoGrupo: ['/inteligencia-artificial', '/seguranca', '/configuracoes'],
  },
];

/** Todas as abas, em ordem de menu. */
export function listarItensDoMenu(): ItemMenu[] {
  return MENU.flatMap((grupo) => [...grupo.itens, ...grupo.secoes.flatMap((secao) => secao.itens)]);
}

export function buscarItemPorRota(rota: string): ItemMenu | undefined {
  return listarItensDoMenu().find((item) => item.rota === rota);
}

/** Uma rota está ativa quando é a página atual ou uma subpágina dela. */
export function rotaEstaAtiva(rotaDoItem: string, caminhoAtual: string): boolean {
  return caminhoAtual === rotaDoItem || caminhoAtual.startsWith(`${rotaDoItem}/`);
}

/** Menu filtrado pelo que a pessoa pode ver. Grupos e seções vazios somem. */
export function menuParaUsuario(ehMaster: boolean): GrupoMenu[] {
  const visivel = (item: ItemMenu) => !item.somenteMaster || ehMaster;
  return MENU.map((grupo) => ({
    ...grupo,
    itens: grupo.itens.filter(visivel),
    secoes: grupo.secoes
      .map((secao) => ({ ...secao, itens: secao.itens.filter(visivel) }))
      .filter((secao) => secao.itens.length > 0),
  })).filter((grupo) => grupo.itens.length > 0 || grupo.secoes.length > 0);
}
