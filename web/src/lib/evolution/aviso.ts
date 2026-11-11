/**
 * Entende os avisos (webhooks) que a Evolution manda para o painel.
 * Código puro: recebe o corpo do aviso e devolve só o que interessa, já conferido.
 */
import { telefoneDoJid } from '@/lib/instancias/regras';

export type AvisoDaEvolution =
  | { tipo: 'conexao'; instancia: string; estado: string; telefone: string | null }
  | {
      tipo: 'mensagem';
      instancia: string;
      /** Identificador da mensagem no WhatsApp (serve para não gravar a mesma duas vezes). */
      idDoEvento: string;
      /** Quem mandou, no formato 5585999990000@s.whatsapp.net. */
      remetente: string;
      nome: string | null;
      texto: string;
      /** Quando a mensagem foi enviada (ISO 8601). */
      quando: string;
      /** `true` quando a mensagem saiu do próprio chip (enviada pelo celular ou pelo painel). */
      deMim: boolean;
    }
  | { tipo: 'ignorado'; motivo: string };

type Objeto = Record<string, unknown>;

const ehObjeto = (valor: unknown): valor is Objeto => typeof valor === 'object' && valor !== null && !Array.isArray(valor);
const texto = (valor: unknown): string | null => (typeof valor === 'string' && valor.trim() ? valor.trim() : null);

const TEXTO_MAXIMO = 8000;
const JID_DE_PESSOA = /^([1-9][0-9]{5,19})(?::[0-9]+)?@s\.whatsapp\.net$/;

/** "messages.upsert" → "MESSAGES_UPSERT" (a Evolution usa os dois jeitos conforme a versão). */
function nomeDoEvento(evento: unknown): string {
  return String(evento ?? '')
    .trim()
    .toUpperCase()
    .replace(/[.-]/g, '_');
}

/**
 * Quem mandou a mensagem. Em conversas novas o WhatsApp às vezes manda um código interno (@lid)
 * no lugar do número; nesses casos o número vem num campo alternativo.
 */
function remetenteDaMensagem(chave: Objeto, dados: Objeto): string | null {
  const candidatos = [chave.remoteJid, chave.remoteJidAlt, chave.senderPn, dados.senderPn, dados.remoteJidAlt];
  for (const candidato of candidatos) {
    const encontrado = typeof candidato === 'string' ? JID_DE_PESSOA.exec(candidato.trim()) : null;
    if (encontrado) return `${encontrado[1]}@s.whatsapp.net`;
  }
  return null;
}

/** Desembrulha mensagens temporárias e de "ver uma vez", que vêm uma dentro da outra. */
function desembrulhar(mensagem: Objeto): Objeto {
  let atual = mensagem;
  for (let nivel = 0; nivel < 4; nivel += 1) {
    const interna = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']
      .map((chave) => atual[chave])
      .find((valor): valor is Objeto => ehObjeto(valor) && ehObjeto(valor.message));
    if (!interna) break;
    atual = interna.message as Objeto;
  }
  return atual;
}

const MIDIAS: Array<[campo: string, rotulo: string]> = [
  ['imageMessage', '📷 Imagem'],
  ['videoMessage', '🎬 Vídeo'],
  ['audioMessage', '🎤 Áudio'],
  ['documentMessage', '📎 Documento'],
  ['stickerMessage', 'Figurinha'],
  ['locationMessage', '📍 Localização'],
  ['liveLocationMessage', '📍 Localização em tempo real'],
  ['contactMessage', '👤 Contato'],
  ['contactsArrayMessage', '👤 Contatos'],
];

/**
 * O texto da mensagem. Enquanto o painel não mostra fotos e áudios, eles entram como uma
 * etiqueta ("📷 Imagem"), com a legenda quando houver, para a conversa não ficar com buracos.
 */
function textoDaMensagem(mensagemBruta: unknown): string | null {
  if (!ehObjeto(mensagemBruta)) return null;
  const mensagem = desembrulhar(mensagemBruta);

  const simples = texto(mensagem.conversation);
  if (simples) return simples;
  const estendido = ehObjeto(mensagem.extendedTextMessage) ? texto(mensagem.extendedTextMessage.text) : null;
  if (estendido) return estendido;

  for (const [campo, rotulo] of MIDIAS) {
    const midia = mensagem[campo];
    if (!ehObjeto(midia)) continue;
    const legenda = texto(midia.caption);
    return legenda ? `${rotulo}: ${legenda}` : rotulo;
  }
  return null;
}

/** O WhatsApp manda a hora em segundos; aceita número, texto ou o formato {low, high}. */
function quandoFoi(valor: unknown, agora: Date): string {
  const bruto = ehObjeto(valor) ? valor.low : valor;
  const segundos = typeof bruto === 'string' ? Number(bruto) : bruto;
  if (typeof segundos === 'number' && Number.isFinite(segundos) && segundos > 1_000_000_000 && segundos < 100_000_000_000) {
    return new Date(segundos * 1000).toISOString();
  }
  return agora.toISOString();
}

export function interpretarAviso(corpo: unknown, agora: Date = new Date()): AvisoDaEvolution {
  if (!ehObjeto(corpo)) return { tipo: 'ignorado', motivo: 'corpo inválido' };

  const instancia = texto(corpo.instance);
  const dados = corpo.data;
  if (!instancia || instancia.length > 100) return { tipo: 'ignorado', motivo: 'sem nome da instância' };
  if (!ehObjeto(dados)) return { tipo: 'ignorado', motivo: 'sem dados' };

  const evento = nomeDoEvento(corpo.event);

  if (evento === 'CONNECTION_UPDATE') {
    const estado = texto(dados.state);
    if (!estado) return { tipo: 'ignorado', motivo: 'aviso de conexão sem estado' };
    return { tipo: 'conexao', instancia, estado, telefone: estado === 'open' ? telefoneDoJid(texto(dados.wuid)) : null };
  }

  // SEND_MESSAGE é a Evolution contando que uma mensagem saiu por ela (o que o painel enviou).
  // Tem o mesmo formato de uma mensagem recebida e é sempre "de mim".
  if (evento === 'MESSAGES_UPSERT' || evento === 'SEND_MESSAGE') {
    const chave = dados.key;
    if (!ehObjeto(chave)) return { tipo: 'ignorado', motivo: 'mensagem sem identificação' };
    const idDoEvento = texto(chave.id);
    if (!idDoEvento || idDoEvento.length > 200) return { tipo: 'ignorado', motivo: 'mensagem sem identificação' };

    const remetente = remetenteDaMensagem(chave, dados);
    if (!remetente) return { tipo: 'ignorado', motivo: 'não é conversa com uma pessoa (grupo, status ou lista)' };

    const conteudo = textoDaMensagem(dados.message);
    if (!conteudo) return { tipo: 'ignorado', motivo: 'tipo de mensagem sem texto (reação, apagada, enquete...)' };

    return {
      tipo: 'mensagem',
      instancia,
      idDoEvento,
      remetente,
      nome: texto(dados.pushName)?.slice(0, 160) ?? null,
      texto: conteudo.slice(0, TEXTO_MAXIMO),
      quando: quandoFoi(dados.messageTimestamp, agora),
      deMim: evento === 'SEND_MESSAGE' || chave.fromMe === true,
    };
  }

  return { tipo: 'ignorado', motivo: `evento que o painel não usa: ${evento || 'sem nome'}` };
}
