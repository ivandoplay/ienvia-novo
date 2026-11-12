/**
 * Montagem do Dossiê Completo enviado ao WhatsApp administrativo quando a conversa
 * entra em modo manual (repasse da IA, pausa silenciosa, envio incerto, falha ou segurança).
 *
 * Código puro (sem banco, sem rede e sem `node:*`): roda igual no Next.js e na Edge Function.
 */
import { lerRecado, type MensagemDoHistorico } from '@/lib/atendente/regras';
import type { EventoDeAlertaDoAdmin } from '@/lib/ia/regras';
import { dataPorExtenso, nomeDoContatoLimpo } from '@/lib/ia/instrucoes';

export type TipoDoDossie = EventoDeAlertaDoAdmin | 'test';

export interface DadosDoDossie {
  tipo: TipoDoDossie;
  agora: Date;
  fuso?: string;
  nomeDoContato?: string | null;
  telefoneDoContato?: string | null;
  emailDoContato?: string | null;
  recipientJid?: string | null;
  nomeDoChip?: string | null;
  telefoneDoChip?: string | null;
  /** Recado estruturado da IA (`Cenário: … | Gatilho: … | Próxima jogada: …`) ou motivo do sistema. */
  recado?: string | null;
  /** Detalhe técnico complementar (ex.: `rate_limit`, `unreadable_media`, `asked`). */
  detalhe?: string | null;
  /** Histórico recente da conversa para resumir contexto e últimas falas do cliente. */
  mensagens?: readonly MensagemDoHistorico[];
  incluirMensagens?: boolean;
}

const TITULO_DO_TIPO: Record<TipoDoDossie, { icone: string; titulo: string; motivo: string }> = {
  handoff: {
    icone: '🚨',
    titulo: 'DOSSIÊ DE ATENDIMENTO — MODO MANUAL ATIVADO',
    motivo: 'A IA passou a conversa para atendimento humano (repasse)',
  },
  silent_handoff: {
    icone: '🤫',
    titulo: 'DOSSIÊ DE ATENDIMENTO — PAUSA SILENCIOSA',
    motivo: 'A IA entrou em pausa silenciosa sem responder ao cliente',
  },
  uncertain_send: {
    icone: '⚠️',
    titulo: 'DOSSIÊ DE ATENDIMENTO — ENVIO SEM CONFIRMAÇÃO',
    motivo: 'Não foi possível confirmar se a resposta saiu no WhatsApp',
  },
  error: {
    icone: '❌',
    titulo: 'DOSSIÊ DE ATENDIMENTO — FALHA NA IA',
    motivo: 'A IA não conseguiu responder e passou a conversa para você',
  },
  safety: {
    icone: '🛡️',
    titulo: 'DOSSIÊ DE ATENDIMENTO — PARADA DE SEGURANÇA',
    motivo: 'Muitas mensagens em pouco tempo; IA parada por proteção',
  },
  test: {
    icone: '🧪',
    titulo: 'TESTE DE DOSSIÊ ADMINISTRATIVO — IENVIA',
    motivo: 'Simulação disparada manualmente nas configurações do Motor de IA',
  },
};

function limparTexto(valor: string | null | undefined, limite = 280): string {
  const limpo = (valor ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return '';
  return Array.from(limpo).length <= limite ? limpo : `${Array.from(limpo).slice(0, limite - 1).join('')}…`;
}

/** Formata "+5586999999999" ou "5586999999999@s.whatsapp.net" de modo legível. */
export function formatarTelefoneParaDossie(telefone?: string | null, jid?: string | null): string {
  const bruto = (telefone ?? '').trim() || (jid ?? '').replace(/@.+$/, '');
  const digitos = bruto.replace(/\D/g, '');
  if (!digitos) return 'Não identificado';
  if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) {
    const ddd = digitos.slice(2, 4);
    const resto = digitos.slice(4);
    const meio = resto.length === 9 ? `${resto.slice(0, 5)}-${resto.slice(5)}` : `${resto.slice(0, 4)}-${resto.slice(4)}`;
    return `+55 (${ddd}) ${meio}`;
  }
  return `+${digitos}`;
}

function textoDaMensagem(m: MensagemDoHistorico): string {
  const partes: string[] = [];
  if (m.arquivo) {
    const rotulo =
      m.arquivo.tipo === 'audio'
        ? '[áudio]'
        : m.arquivo.tipo === 'image'
          ? '[imagem]'
          : m.arquivo.tipo === 'video'
            ? '[vídeo]'
            : m.arquivo.tipo === 'sticker'
              ? '[figurinha]'
              : `[arquivo${m.arquivo.nome ? `: ${m.arquivo.nome}` : ''}]`;
    partes.push(rotulo);
  }
  if (m.texto) partes.push(m.texto);
  return limparTexto(partes.join(' '), 220);
}

function resumirConversa(mensagens: readonly MensagemDoHistorico[]): { falasCliente: string[]; resumo: string } {
  const falasCliente = mensagens
    .filter((m) => m.recebida)
    .map(textoDaMensagem)
    .filter(Boolean);

  if (falasCliente.length === 0) {
    return {
      falasCliente: [],
      resumo: 'Sem mensagens de texto registradas ainda no histórico desta conversa.',
    };
  }

  const primeira = falasCliente[0]!;
  const ultima = falasCliente.at(-1)!;
  const totalMensagens = mensagens.length;
  const resumo =
    falasCliente.length === 1
      ? `Cliente enviou 1 mensagem (${totalMensagens} no histórico): "${ultima}".`
      : `Conversa com ${falasCliente.length} falas do cliente (${totalMensagens} mensagens ao todo). Começou com: "${limparTexto(primeira, 110)}" e por último disse: "${limparTexto(ultima, 130)}".`;

  return { falasCliente: falasCliente.slice(-4), resumo };
}

function proximaJogadaPadrao(tipo: TipoDoDossie, gatilho: string): string {
  if (tipo === 'test') return 'Se este aviso chegou no seu WhatsApp, o envio de dossiês está funcionando normalmente.';
  if (tipo === 'uncertain_send') return 'Abrir o WhatsApp do chip para conferir se a última resposta chegou ao cliente antes de responder.';
  if (tipo === 'error') return 'Responder manualmente ao cliente na Inbox e conferir a chave/modelo configurado no Motor de IA.';
  if (tipo === 'safety') return 'Verificar se há automação ou envio repetido do outro lado antes de devolver a conversa para a IA.';
  if (tipo === 'silent_handoff') return 'Ler a última mensagem/mídia do cliente na Inbox e assumir a resposta pessoalmente.';

  const g = gatilho.toLowerCase();
  if (/\b(robo|ia|automatic|humano|pessoa)\b/.test(g)) {
    return 'Assumir com naturalidade cumprimentando pelo nome e continuar o atendimento pessoalmente.';
  }
  if (/\b(valor|preco|mensal|orcamento|plano|condic|verba)\b/.test(g)) {
    return 'Cumprimentar pelo nome, validar o momento atual do cliente e apresentar escopo e condições.';
  }
  if (/\b(comprovante|pix|pag|fech|contrat)\b/.test(g)) {
    return 'Conferir os dados/comprovante recebidos e confirmar os próximos passos de contratação.';
  }
  return 'Cumprimentar pelo nome, retomar exatamente a dúvida do gatilho e conduzir para o próximo passo.';
}

/** Constrói o texto completo (pronto para WhatsApp, com até ~4000 caracteres). */
export function montarDossieParaAdmin(dados: DadosDoDossie): string {
  const cab = TITULO_DO_TIPO[dados.tipo];
  const fuso = dados.fuso || 'America/Fortaleza';
  const nomeCliente = nomeDoContatoLimpo(dados.nomeDoContato);
  const telefoneCliente = formatarTelefoneParaDossie(dados.telefoneDoContato, dados.recipientJid);
  const chipTexto = [
    limparTexto(dados.nomeDoChip, 60) || 'Chip do atendimento',
    dados.telefoneDoChip ? `(${formatarTelefoneParaDossie(dados.telefoneDoChip)})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const recadoLido = lerRecado(dados.recado);
  const { falasCliente, resumo } = resumirConversa(dados.mensagens ?? []);

  const gatilho =
    limparTexto(recadoLido?.gatilho, 240) ||
    limparTexto(recadoLido?.livre, 240) ||
    limparTexto(falasCliente.at(-1), 240) ||
    limparTexto(dados.detalhe, 160) ||
    cab.motivo;

  const cenario =
    limparTexto(recadoLido?.cenario, 240) ||
    (dados.tipo === 'test'
      ? 'Lead de demonstração simulando uma solicitação comercial'
      : limparTexto(falasCliente[0], 180) || 'Atendimento em andamento no WhatsApp');

  const proximaJogada = limparTexto(recadoLido?.proximaJogada, 260) || proximaJogadaPadrao(dados.tipo, gatilho);

  const linhas: string[] = [
    `${cab.icone} *${cab.titulo}*`,
    '',
    `*Motivo:* ${cab.motivo}`,
    `*Gatilho que ativou:* ${gatilho}`,
    `*Quando:* ${dataPorExtenso(dados.agora, fuso)}`,
    '',
    '👤 *DADOS DO CLIENTE*',
    `• *Nome:* ${nomeCliente}`,
    `• *WhatsApp:* ${telefoneCliente}`,
  ];

  if (limparTexto(dados.emailDoContato, 120)) {
    linhas.push(`• *E-mail:* ${limparTexto(dados.emailDoContato, 120)}`);
  }
  linhas.push(`• *Chip de origem:* ${chipTexto}`);

  linhas.push('', '🧠 *RESUMO E CONDUÇÃO*');
  linhas.push(`• *Cenário:* ${cenario}`);
  linhas.push(`• *Resumo da conversa:* ${resumo}`);
  linhas.push(`• *Próxima jogada:* ${proximaJogada}`);

  if (dados.incluirMensagens !== false && falasCliente.length > 0) {
    linhas.push('', '💬 *ÚLTIMAS MENSAGENS DO CLIENTE*');
    for (const [idx, fala] of falasCliente.entries()) {
      linhas.push(`${idx + 1}. "${fala}"`);
    }
  }

  linhas.push(
    '',
    dados.tipo === 'test'
      ? '_Teste de configuração concluído: nenhuma conversa real foi alterada._'
      : '⚡ _A IA foi pausada nesta conversa para você assumir._',
  );

  const texto = linhas.join('\n');
  return texto.length <= 4000 ? texto : `${texto.slice(0, 3960).trim()}\n…`;
}
