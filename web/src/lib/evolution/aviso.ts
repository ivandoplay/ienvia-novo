/**
 * Entende os avisos (webhooks) que a Evolution manda para o painel.
 * Código puro: recebe o corpo do aviso e devolve só o que interessa, já conferido.
 */
import { limparTipoDeConteudo, type TipoDeArquivo } from '@/lib/inbox/arquivos';
import { telefoneDoJid } from '@/lib/instancias/regras';

/** A ficha do arquivo que veio numa mensagem (o arquivo em si o painel busca depois, à parte). */
export interface ArquivoDoAviso {
  tipo: TipoDeArquivo;
  /** Tipo de conteúdo, já limpo: "image/jpeg", "audio/ogg"... */
  conteudo: string;
  /** Tamanho em bytes, quando o WhatsApp informa. */
  tamanho: number | null;
  nome: string | null;
  /** Duração em segundos (áudio e vídeo). */
  duracao: number | null;
  largura: number | null;
  altura: number | null;
  /** `true` para áudio gravado na hora (mensagem de voz). */
  voz: boolean;
}

export type AvisoDaEvolution =
  | { tipo: 'conexao'; instancia: string; estado: string; telefone: string | null }
  | {
      tipo: 'status_mensagem';
      instancia: string;
      atualizacoes: Array<{ idNoWhatsApp: string; status: 'delivered' | 'read' }>;
    }
  | {
      tipo: 'mensagem';
      instancia: string;
      /** Identificador da mensagem no WhatsApp (serve para não gravar a mesma duas vezes). */
      idDoEvento: string;
      /** Quem mandou, no formato 5585999990000@s.whatsapp.net. */
      remetente: string;
      nome: string | null;
      /** O texto da mensagem; quando há arquivo, é a legenda (e pode não existir). */
      texto: string | null;
      /** Foto, áudio, vídeo, documento ou figurinha que veio na mensagem. */
      arquivo: ArquivoDoAviso | null;
      /**
       * Só quando há arquivo: o pedaço do aviso que a Evolution precisa de volta para baixar o arquivo
       * do WhatsApp ({ key, message }), sem a miniatura e sem a mensagem citada (que só pesam).
       */
      paraBuscar: { key: Objeto; message: Objeto } | null;
      /** Quando a mensagem foi enviada (ISO 8601). */
      quando: string;
      /** `true` quando a mensagem saiu do próprio chip (enviada pelo celular ou pelo painel). */
      deMim: boolean;
    }
  | { tipo: 'ignorado'; motivo: string };

export type Objeto = Record<string, unknown>;

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

const EMBRULHOS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];

/**
 * Desembrulha mensagens temporárias, com legenda e de "visualização única", que vêm uma dentro da outra.
 * Também conta se algum dos embrulhos era de visualização única.
 */
function desembrulhar(mensagem: Objeto): { mensagem: Objeto; verUmaVez: boolean } {
  let atual = mensagem;
  let verUmaVez = false;
  for (let nivel = 0; nivel < 4; nivel += 1) {
    const campo = EMBRULHOS.find((chave) => ehObjeto(atual[chave]) && ehObjeto((atual[chave] as Objeto).message));
    if (!campo) break;
    if (campo.startsWith('viewOnce')) verUmaVez = true;
    atual = (atual[campo] as Objeto).message as Objeto;
  }
  return { mensagem: atual, verUmaVez };
}

/** Os tipos de mensagem que trazem um arquivo que o painel guarda e mostra. */
const ARQUIVOS: Array<[campo: string, tipo: TipoDeArquivo, verUmaVez: string]> = [
  ['imageMessage', 'image', '📷 Foto de visualização única'],
  ['videoMessage', 'video', '🎥 Vídeo de visualização única'],
  ['ptvMessage', 'video', '🎥 Vídeo de visualização única'],
  ['audioMessage', 'audio', '🎤 Áudio de visualização única'],
  ['documentMessage', 'document', '📄 Documento'],
  ['stickerMessage', 'sticker', 'Figurinha'],
];

/** Tipos que o painel ainda não abre: entram como uma etiqueta, para a conversa não ficar com buracos. */
const ETIQUETAS: Array<[campo: string, rotulo: string]> = [
  ['locationMessage', '📍 Localização'],
  ['liveLocationMessage', '📍 Localização em tempo real'],
  ['contactMessage', '👤 Contato'],
  ['contactsArrayMessage', '👤 Contatos'],
];

/** O WhatsApp manda números grandes como número, como texto ou no formato {low, high}. */
function numero(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && /^[0-9]{1,15}$/.test(valor.trim())) return Number(valor.trim());
  if (ehObjeto(valor) && typeof valor.low === 'number') {
    const alto = typeof valor.high === 'number' ? valor.high : 0;
    const total = alto * 2 ** 32 + (valor.low >>> 0);
    return Number.isFinite(total) ? total : null;
  }
  return null;
}

const inteiroEntre = (valor: unknown, minimo: number, maximo: number): number | null => {
  const lido = numero(valor);
  return lido !== null && Number.isInteger(lido) && lido >= minimo && lido <= maximo ? lido : null;
};

function fichaDoArquivo(tipo: TipoDeArquivo, midia: Objeto): ArquivoDoAviso {
  const tamanho = numero(midia.fileLength);
  return {
    tipo,
    conteudo: limparTipoDeConteudo(midia.mimetype),
    tamanho: tamanho !== null && tamanho >= 0 && tamanho < 1e15 ? Math.round(tamanho) : null,
    nome: tipo === 'document' ? ((texto(midia.fileName) ?? texto(midia.title))?.slice(0, 200) ?? null) : null,
    duracao: tipo === 'audio' || tipo === 'video' ? inteiroEntre(midia.seconds, 0, 86_400) : null,
    largura: tipo === 'audio' || tipo === 'document' ? null : inteiroEntre(midia.width, 1, 20_000),
    altura: tipo === 'audio' || tipo === 'document' ? null : inteiroEntre(midia.height, 1, 20_000),
    voz: tipo === 'audio' && midia.ptt === true,
  };
}

/**
 * O que a mensagem traz: texto, arquivo (com a legenda como texto) ou os dois.
 * `null` quando é um tipo de mensagem que o painel não mostra (reação, apagada, enquete...).
 */
function conteudoDaMensagem(
  mensagemBruta: unknown,
): { texto: string | null; arquivo: ArquivoDoAviso | null; /** Onde o arquivo está dentro da mensagem. */ no?: { campo: string; midia: Objeto } } | null {
  if (!ehObjeto(mensagemBruta)) return null;
  const { mensagem, verUmaVez } = desembrulhar(mensagemBruta);

  const simples = texto(mensagem.conversation);
  if (simples) return { texto: simples, arquivo: null };
  const estendido = ehObjeto(mensagem.extendedTextMessage) ? texto(mensagem.extendedTextMessage.text) : null;
  if (estendido) return { texto: estendido, arquivo: null };

  for (const [campo, tipo, rotuloDeUmaVez] of ARQUIVOS) {
    const midia = mensagem[campo];
    if (!ehObjeto(midia)) continue;
    const legenda = texto(midia.caption);
    // Visualização única: quem mandou escolheu que só se veja uma vez, no celular. O painel respeita e não guarda.
    if (verUmaVez || midia.viewOnce === true) {
      return { texto: `${rotuloDeUmaVez} (só abre no celular do chip)${legenda ? `: ${legenda}` : ''}`, arquivo: null };
    }
    return { texto: legenda, arquivo: fichaDoArquivo(tipo, midia), no: { campo, midia } };
  }

  for (const [campo, rotulo] of ETIQUETAS) {
    if (ehObjeto(mensagem[campo])) return { texto: rotulo, arquivo: null };
  }
  return null;
}

/** A ficha do arquivo sem o que a Evolution não usa para baixar: a miniatura e a mensagem citada. */
function semPeso(midia: Objeto): Objeto {
  const leve = { ...midia };
  delete leve.jpegThumbnail;
  delete leve.contextInfo;
  return leve;
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

function lerStatusDeAck(valor: unknown): 'delivered' | 'read' | null {
  if (typeof valor === 'number') {
    if (valor === 3) return 'delivered';
    if (valor === 4 || valor === 5) return 'read';
    return null;
  }
  if (typeof valor === 'string') {
    const s = valor.trim().toUpperCase();
    if (s === 'DELIVERY_ACK' || s === '3') return 'delivered';
    if (s === 'READ' || s === 'PLAYED' || s === '4' || s === '5') return 'read';
  }
  return null;
}

export function interpretarAviso(corpo: unknown, agora: Date = new Date()): AvisoDaEvolution {
  if (!ehObjeto(corpo)) return { tipo: 'ignorado', motivo: 'corpo inválido' };

  const instancia = texto(corpo.instance);
  const dados = corpo.data;
  if (!instancia || instancia.length > 100) return { tipo: 'ignorado', motivo: 'sem nome da instância' };

  const evento = nomeDoEvento(corpo.event);

  if (evento === 'MESSAGES_UPDATE') {
    const lista = Array.isArray(dados) ? dados : ehObjeto(dados) ? [dados] : [];
    const atualizacoes: Array<{ idNoWhatsApp: string; status: 'delivered' | 'read' }> = [];
    for (const item of lista) {
      if (!ehObjeto(item)) continue;
      const chave = ehObjeto(item.key) ? item.key : null;
      const id = texto(item.keyId) ?? (chave ? texto(chave.id) : null);
      if (!id || id.length > 200) continue;
      const upd = ehObjeto(item.update) ? item.update : null;
      const status = lerStatusDeAck(item.status ?? upd?.status);
      if (!status) continue;
      atualizacoes.push({ idNoWhatsApp: id, status });
    }
    if (atualizacoes.length === 0) return { tipo: 'ignorado', motivo: 'atualização sem status aproveitável' };
    return { tipo: 'status_mensagem', instancia, atualizacoes };
  }

  if (!ehObjeto(dados)) return { tipo: 'ignorado', motivo: 'sem dados' };

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

    const conteudo = conteudoDaMensagem(dados.message);
    if (!conteudo) return { tipo: 'ignorado', motivo: 'tipo de mensagem sem texto (reação, apagada, enquete...)' };

    return {
      tipo: 'mensagem',
      instancia,
      idDoEvento,
      remetente,
      nome: texto(dados.pushName)?.slice(0, 160) ?? null,
      texto: conteudo.texto?.slice(0, TEXTO_MAXIMO) ?? null,
      arquivo: conteudo.arquivo,
      paraBuscar: conteudo.no ? { key: chave, message: { [conteudo.no.campo]: semPeso(conteudo.no.midia) } } : null,
      quando: quandoFoi(dados.messageTimestamp, agora),
      deMim: evento === 'SEND_MESSAGE' || chave.fromMe === true,
    };
  }

  return { tipo: 'ignorado', motivo: `evento que o painel não usa: ${evento || 'sem nome'}` };
}
