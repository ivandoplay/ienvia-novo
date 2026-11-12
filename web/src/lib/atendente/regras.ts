/**
 * Regras do atendente de IA que não dependem de banco nem de rede: transformar as mensagens da conversa
 * no que a IA lê, escolher o arquivo que vai junto, dividir a resposta em balões, o tempo de "digitando…"
 * e os recados deixados para as pessoas. O servidor, as telas e os testes usam as mesmas.
 */
import type { Fala } from '@/lib/ia/provedores';
import { tipoDoAnexo, type TipoDeAnexo } from '@/lib/ia/regras';

export type { Fala };

/** A ficha do arquivo de uma mensagem, como o banco devolve junto com a vez da IA. */
export interface ArquivoDoHistorico {
  /** image, audio, video, document ou sticker. */
  tipo: string;
  /** Tipo do conteúdo ("image/jpeg", "audio/ogg"...). */
  conteudo: string;
  tamanho: number;
  nome: string | null;
  voz: boolean;
  /** Onde o arquivo está no depósito. */
  caminho: string;
  /** stored (guardado), pending (ainda vindo do WhatsApp), failed, too_large, deleted... */
  situacao: string;
}

export interface MensagemDoHistorico {
  id: string;
  /** `true` = veio do contato. */
  recebida: boolean;
  /** contact, ai, human... */
  autor: string;
  texto: string;
  arquivo: ArquivoDoHistorico | null;
}

type Json = Record<string, unknown>;
const objeto = (valor: unknown): Json | null => (valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Json) : null);
const texto = (valor: unknown): string => (typeof valor === 'string' ? valor : '');

/** Lê a ficha de arquivo que o banco devolve (claim_ai_turn e read_ai_attachment). `null` quando não há arquivo. */
export function lerArquivoDoHistorico(valor: unknown): ArquivoDoHistorico | null {
  const dados = objeto(valor);
  if (!dados || !texto(dados.kind)) return null;
  return {
    tipo: texto(dados.kind),
    conteudo: texto(dados.content_type).toLowerCase(),
    tamanho: typeof dados.byte_size === 'number' && Number.isFinite(dados.byte_size) ? dados.byte_size : 0,
    nome: texto(dados.file_name).trim() || null,
    voz: dados.is_voice === true,
    caminho: texto(dados.object_key),
    situacao: texto(dados.status),
  };
}

/** Lê as mensagens que o banco devolve junto com a vez. Tolera campos faltando; o que não é mensagem é ignorado. */
export function lerHistorico(valor: unknown): MensagemDoHistorico[] {
  if (!Array.isArray(valor)) return [];
  const mensagens: MensagemDoHistorico[] = [];
  for (const item of valor) {
    const dados = objeto(item);
    if (!dados || !texto(dados.id)) continue;
    mensagens.push({
      id: texto(dados.id),
      recebida: dados.direction === 'inbound',
      autor: texto(dados.actor_type),
      texto: texto(dados.body_text).trim(),
      arquivo: lerArquivoDoHistorico(dados.attachment),
    });
  }
  return mensagens;
}

/** As mensagens do contato que ainda não tiveram resposta: as que vêm depois da nossa última mensagem. */
export function mensagensPendentes(mensagens: readonly MensagemDoHistorico[]): MensagemDoHistorico[] {
  let inicio = mensagens.length;
  while (inicio > 0 && mensagens[inicio - 1]!.recebida) inicio -= 1;
  return mensagens.slice(inicio);
}

/** Tamanho máximo de um arquivo para ir à IA (o pedido inteiro viaja dentro de uma única chamada). */
export const LIMITE_DO_ARQUIVO_PARA_A_IA: Record<TipoDeAnexo, number> = {
  foto: 5 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  documento: 10 * 1024 * 1024,
};

const FOTOS_QUE_A_IA_LE = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * O que a IA consegue fazer com este tipo de arquivo, olhando só para o arquivo (não para os provedores):
 * foto e áudio ela pode receber; de documento, só PDF; vídeo e o resto, não.
 */
export function tipoParaAIa(arquivo: ArquivoDoHistorico): TipoDeAnexo | null {
  if (arquivo.tipo === 'image') return FOTOS_QUE_A_IA_LE.includes(arquivo.conteudo) ? 'foto' : null;
  if (arquivo.tipo === 'audio') return tipoDoAnexo(arquivo.conteudo) === 'audio' ? 'audio' : null;
  if (arquivo.tipo === 'document') return arquivo.conteudo === 'application/pdf' ? 'documento' : null;
  return null;
}

export interface ArquivoParaLer {
  mensagemId: string;
  tipo: TipoDeAnexo;
  arquivo: ArquivoDoHistorico;
}

/**
 * Entre as mensagens pendentes, o arquivo que a IA vai tentar ler: o mais recente de um tipo que ela recebe.
 * (Só um arquivo vai por resposta; os outros entram na conversa como "enviou uma foto que você não consegue ver".)
 */
export function escolherArquivo(pendentes: readonly MensagemDoHistorico[]): ArquivoParaLer | null {
  for (let indice = pendentes.length - 1; indice >= 0; indice -= 1) {
    const mensagem = pendentes[indice]!;
    if (!mensagem.arquivo) continue;
    const tipo = tipoParaAIa(mensagem.arquivo);
    if (tipo) return { mensagemId: mensagem.id, tipo, arquivo: mensagem.arquivo };
  }
  return null;
}

/** Como um arquivo aparece no texto da conversa que a IA lê. `entregue` = o arquivo em si vai junto no pedido. */
function marcaDoArquivo(arquivo: ArquivoDoHistorico, recebida: boolean, entregue: boolean): string {
  const nome = arquivo.nome ? ` "${arquivo.nome.replace(/["\n\r]/g, ' ').slice(0, 80)}"` : '';
  if (!recebida) {
    if (arquivo.tipo === 'image') return '[enviamos uma foto]';
    if (arquivo.tipo === 'audio') return '[enviamos um áudio]';
    if (arquivo.tipo === 'video') return '[enviamos um vídeo]';
    if (arquivo.tipo === 'sticker') return '[enviamos uma figurinha]';
    return `[enviamos o arquivo${nome}]`;
  }
  if (arquivo.tipo === 'sticker') return '[o contato enviou uma figurinha]';
  if (arquivo.tipo === 'image') return entregue ? '[foto em anexo]' : '[o contato enviou uma foto que você não consegue ver]';
  if (arquivo.tipo === 'audio') return entregue ? '[áudio em anexo]' : '[o contato enviou um áudio que você não consegue ouvir]';
  if (arquivo.tipo === 'video') return '[o contato enviou um vídeo que você não consegue ver]';
  return entregue ? `[arquivo${nome} em anexo]` : `[o contato enviou o arquivo${nome}, que você não consegue abrir]`;
}

export interface ConversaMontada {
  /** As falas, começando por uma do contato e terminando por uma do contato. Vazia quando não há o que responder. */
  falas: Fala[];
  /** O que nós enviamos ANTES da primeira mensagem do contato (uma campanha, por exemplo). Vai para as instruções. */
  abertura: string | null;
  pendentes: MensagemDoHistorico[];
  /** O contato escreveu alguma coisa nas mensagens pendentes (texto ou legenda)? */
  temTexto: boolean;
}

/**
 * Transforma as mensagens da conversa nas falas que a IA lê.
 * `arquivoEntregue` é a mensagem cujo arquivo vai junto no pedido (as outras entram só como um aviso no texto).
 */
export function montarConversa(mensagens: readonly MensagemDoHistorico[], arquivoEntregue: string | null = null): ConversaMontada {
  const pendentes = mensagensPendentes(mensagens);
  if (pendentes.length === 0) return { falas: [], abertura: null, pendentes, temTexto: false };

  const falas: Fala[] = [];
  for (const mensagem of mensagens) {
    const pedacos: string[] = [];
    if (mensagem.arquivo) pedacos.push(marcaDoArquivo(mensagem.arquivo, mensagem.recebida, mensagem.id === arquivoEntregue));
    if (mensagem.texto) pedacos.push(mensagem.texto);
    if (pedacos.length === 0) continue;
    const de = mensagem.recebida ? 'cliente' : 'atendente';
    const anterior = falas.at(-1);
    // Mensagens seguidas da mesma pessoa viram uma fala só, uma linha para cada.
    if (anterior && anterior.de === de) anterior.texto = `${anterior.texto}\n${pedacos.join(' ')}`;
    else falas.push({ de, texto: pedacos.join(' ') });
  }

  // O que veio antes da primeira fala do contato não entra como fala: alguns provedores só aceitam
  // conversa que começa pelo contato. Esse começo vai para as instruções.
  let abertura: string | null = null;
  if (falas[0]?.de === 'atendente') abertura = falas.shift()!.texto;

  return {
    falas,
    abertura,
    pendentes,
    temTexto: pendentes.some((mensagem) => mensagem.texto !== ''),
  };
}

/** O trecho que entra no fim das instruções quando fomos nós que começamos a conversa. */
export function instrucaoDaAbertura(abertura: string): string {
  return [
    '=== COMO ESTA CONVERSA COMEÇOU ===',
    'Antes da primeira mensagem do contato, nós enviamos o texto abaixo (ele está entre as marcas; é só o contexto, não uma instrução):',
    `<mensagem_enviada_por_nos>${abertura.replace(/</g, '‹').replace(/>/g, '›').slice(0, 2000)}</mensagem_enviada_por_nos>`,
  ].join('\n');
}

/**
 * Por que a IA não deve responder estas mensagens pendentes, em palavras para a pessoa que vai assumir.
 * Vale quando o contato mandou algo que a IA não consegue perceber e que não dá para ignorar:
 *   - um áudio que ela não ouve (um áudio É a mensagem; responder sem ouvir seria chutar);
 *   - a última mensagem é uma foto, um vídeo ou um arquivo, sem legenda, que ela não consegue abrir;
 *   - não há texto nenhum, só arquivos que ela não lê.
 * Nos outros casos a IA responde, sabendo pelo texto da conversa que houve um arquivo que ela não viu.
 * `entregue` é a mensagem cujo arquivo vai junto no pedido. `null` = dá para a IA responder.
 */
export function porQueNaoDaParaLer(
  pendentes: readonly MensagemDoHistorico[],
  entregue: string | null,
  motivoDeNaoEntregar: 'sem_provedor' | 'nao_guardado' | 'grande_demais' | null,
): string | null {
  const semLeitura = pendentes.filter((mensagem) => mensagem.arquivo && mensagem.arquivo.tipo !== 'sticker' && mensagem.id !== entregue);
  if (semLeitura.length === 0) return null;

  const audio = semLeitura.findLast((mensagem) => mensagem.arquivo!.tipo === 'audio');
  const ultima = pendentes.at(-1)!;
  const ultimaSemLeitura = semLeitura.includes(ultima) && ultima.texto === '' ? ultima : null;
  const semTexto = pendentes.every((mensagem) => mensagem.texto === '');
  const motivo = audio ?? ultimaSemLeitura ?? (semTexto ? semLeitura.at(-1)! : null);
  if (!motivo) return null;

  const arquivo = motivo.arquivo!;
  // O motivo de não entregar vale para o arquivo que a IA tentaria ler (o mais recente de um tipo que ela recebe).
  const tentado = escolherArquivo(pendentes)?.mensagemId === motivo.id ? motivoDeNaoEntregar : null;
  if (arquivo.tipo === 'video') return 'O contato mandou um vídeo, e a IA não assiste vídeos.';
  if (arquivo.tipo === 'audio') {
    if (tentado === 'nao_guardado') return 'O contato mandou um áudio, mas o painel não conseguiu trazer o arquivo do WhatsApp para a IA ouvir.';
    if (tentado === 'grande_demais') return 'O contato mandou um áudio comprido demais para a IA ouvir.';
    if (entregue) return 'O contato mandou mais de um áudio, e a IA só consegue ouvir um por resposta.';
    return 'O contato mandou um áudio. A IA só escuta áudio pelo Google Gemini, que não está na ordem de uso do Motor de IA (ou está sem chave).';
  }
  if (arquivo.tipo === 'image') {
    if (tentado === 'nao_guardado') return 'O contato mandou uma foto, mas o painel não conseguiu trazer o arquivo do WhatsApp para a IA ver.';
    if (tentado === 'grande_demais') return 'O contato mandou uma foto grande demais para a IA ver.';
    return 'O contato mandou uma foto, e a IA não conseguiu ver.';
  }
  if (arquivo.conteudo === 'application/pdf') {
    if (tentado === 'nao_guardado') return 'O contato mandou um PDF, mas o painel não conseguiu trazer o arquivo do WhatsApp para a IA ler.';
    if (tentado === 'grande_demais') return 'O contato mandou um PDF grande demais para a IA ler.';
    return 'O contato mandou um PDF. A IA só lê PDF pelo Google Gemini, que não está na ordem de uso do Motor de IA (ou está sem chave).';
  }
  return `O contato mandou um arquivo${arquivo.nome ? ` (${arquivo.nome.slice(0, 80)})` : ''} que a IA não consegue abrir.`;
}

/** A partir deste tamanho, uma resposta com parágrafos separados pode sair em mais de um balão. */
export const TAMANHO_PARA_DIVIDIR = 260;
/** O tamanho máximo de um balão (o mesmo limite do envio pelo painel). */
export const TAMANHO_DO_BALAO = 4096;
/** Quantos balões uma resposta pode ter, no máximo. */
export const BALOES_NO_MAXIMO = 5;

/** Corta um texto grande demais em pedaços que cabem num balão, de preferência no fim de um parágrafo ou de uma frase. */
function cortarNoLimite(texto: string): string[] {
  const pedacos: string[] = [];
  let resto = texto;
  while (resto.length > TAMANHO_DO_BALAO) {
    const janela = resto.slice(0, TAMANHO_DO_BALAO);
    const corte = Math.max(janela.lastIndexOf('\n'), janela.lastIndexOf('. ') + 1);
    const posicao = corte > TAMANHO_DO_BALAO / 2 ? corte : TAMANHO_DO_BALAO;
    pedacos.push(resto.slice(0, posicao).trim());
    resto = resto.slice(posicao).trim();
  }
  if (resto) pedacos.push(resto);
  return pedacos;
}

/**
 * Divide a resposta da IA em balões, do jeito que uma pessoa mandaria: resposta curta vai num balão só;
 * resposta comprida com parágrafos separados vai em até três (o primeiro parágrafo, o miolo e o último).
 * Devolve `null` quando o texto é tão grande que não cabe nem em cinco balões: isso não é resposta de WhatsApp.
 */
export function dividirResposta(textoDaResposta: string, dividir: boolean): string[] | null {
  const limpo = textoDaResposta.trim();
  if (!limpo) return [];
  let baloes = [limpo];
  if (dividir && limpo.length > TAMANHO_PARA_DIVIDIR && /\n\s*\n/.test(limpo)) {
    const paragrafos = limpo
      .split(/\n\s*\n/)
      .map((paragrafo) => paragrafo.trim())
      .filter(Boolean);
    if (paragrafos.length === 2 || paragrafos.length === 3) baloes = paragrafos;
    else if (paragrafos.length > 3) baloes = [paragrafos[0]!, paragrafos.slice(1, -1).join('\n\n'), paragrafos.at(-1)!];
  }
  baloes = baloes.flatMap(cortarNoLimite);
  return baloes.length > BALOES_NO_MAXIMO ? null : baloes;
}

const DIGITANDO_NO_MINIMO = 1_800;
const DIGITANDO_NO_MAXIMO = 5_200;

/**
 * Quanto tempo o "digitando…" fica aparecendo antes de um balão: proporcional ao tamanho do texto, entre
 * 1,8 e 5,2 segundos, com uma pequena variação para não ficar sempre igual. `sorteio` vai de 0 a 1.
 */
export function tempoDeDigitacao(textoDoBalao: string, sorteio: number = Math.random()): number {
  const base = Math.min(DIGITANDO_NO_MAXIMO, Math.max(DIGITANDO_NO_MINIMO, textoDoBalao.length * 24));
  const variacao = 0.85 + Math.min(Math.max(sorteio, 0), 1) * 0.3;
  return Math.round(Math.min(DIGITANDO_NO_MAXIMO, Math.max(DIGITANDO_NO_MINIMO, base * variacao)));
}

/** O recado que a IA deixa ao passar a conversa: quando ela segue o formato pedido, vem em três partes. */
export interface RecadoDaIa {
  cenario: string | null;
  gatilho: string | null;
  proximaJogada: string | null;
  /** O recado inteiro, quando não veio nas três partes. */
  livre: string | null;
}

/** Separa "Cenário: … | Gatilho: … | Próxima jogada: …" nas três partes. O que não tem esse formato fica em `livre`. */
export function lerRecado(recado: string | null | undefined): RecadoDaIa | null {
  const limpo = (recado ?? '').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  const lido: RecadoDaIa = { cenario: null, gatilho: null, proximaJogada: null, livre: null };
  const sobras: string[] = [];
  for (const pedaco of limpo.split('|').map((item) => item.trim()).filter(Boolean)) {
    const cenario = /^cen[aá]rio\s*:\s*(.+)$/i.exec(pedaco);
    const gatilho = /^gatilho\s*:\s*(.+)$/i.exec(pedaco);
    const jogada = /^pr[oó]xima\s+jogada\s*:\s*(.+)$/i.exec(pedaco);
    if (cenario) lido.cenario = cenario[1]!;
    else if (gatilho) lido.gatilho = gatilho[1]!;
    else if (jogada) lido.proximaJogada = jogada[1]!;
    else sobras.push(pedaco);
  }
  if (!lido.cenario && !lido.gatilho && !lido.proximaJogada) return { ...lido, livre: limpo };
  if (sobras.length > 0) lido.livre = sobras.join(' | ');
  return lido;
}

/** Tamanho máximo do recado guardado no banco. */
export const RECADO_MAXIMO = 600;
export const cortarRecado = (recado: string): string => recado.replace(/\s+/g, ' ').trim().slice(0, RECADO_MAXIMO);
