/**
 * Regras dos arquivos da Inbox (fotos, áudios, vídeos, documentos e figurinhas) que não dependem
 * de banco nem de rede. A tela, as ações do servidor e os testes usam as mesmas.
 *
 * Os arquivos ficam num depósito fechado do Supabase Storage. O caminho de cada um é:
 *   recebido:            <empresa>/<conversa>/<mensagem>/<nome>
 *   enviado pelo painel: <empresa>/<conversa>/envios/<chave do envio>/<nome>
 * O banco confere esses mesmos formatos (supabase/migrations, "inbox_media").
 */

/** Nome do depósito no Supabase Storage. */
export const DEPOSITO = 'midias';

export type TipoDeArquivo = 'image' | 'audio' | 'video' | 'document' | 'sticker';
/** O que o painel sabe enviar (figurinha só se recebe). */
export type TipoDeEnvio = Exclude<TipoDeArquivo, 'sticker'>;

const MB = 1024 * 1024;
/** Foto, vídeo e áudio: o limite do próprio WhatsApp. */
export const LIMITE_DE_MIDIA = 16 * MB;
/** Documento: o limite do depósito do painel. */
export const LIMITE_DE_DOCUMENTO = 25 * MB;
/** Acima disto um arquivo recebido não é guardado (a mensagem aparece, com um aviso). */
export const LIMITE_PARA_GUARDAR = 25 * MB;

export const limiteDoTipo = (tipo: TipoDeEnvio): number => (tipo === 'document' ? LIMITE_DE_DOCUMENTO : LIMITE_DE_MIDIA);

/** Legenda de foto, vídeo ou documento. Áudio não leva legenda. */
export const LEGENDA_MAXIMA = 1024;

/** "image/JPEG; charset=binary" → "image/jpeg". Vazio ou malformado → "application/octet-stream". */
export function limparTipoDeConteudo(valor: unknown): string {
  const limpo = typeof valor === 'string' ? (valor.split(';')[0] ?? '').trim().toLowerCase() : '';
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(limpo) && limpo.length <= 120 ? limpo : 'application/octet-stream';
}

const TIPO_PELA_EXTENSAO: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  weba: 'audio/webm',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

const EXTENSAO_PELO_TIPO: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

const extensaoDe = (nome: string): string => /\.([a-z0-9]{1,8})$/i.exec(nome)?.[1]?.toLowerCase() ?? '';

/**
 * O tipo de conteúdo de um arquivo escolhido no computador. O navegador costuma informar; quando não
 * informa (acontece com .opus, .m4a e outros), vale o que a extensão do nome indica.
 */
export function tipoDeConteudoDoArquivo(nome: string, informado: string | null | undefined): string {
  const limpo = limparTipoDeConteudo(informado);
  if (limpo !== 'application/octet-stream') return limpo;
  return TIPO_PELA_EXTENSAO[extensaoDe(nome)] ?? 'application/octet-stream';
}

/**
 * Como um arquivo vai para o WhatsApp. Foto, vídeo e áudio só nos formatos que o WhatsApp mostra;
 * todo o resto vai como documento (chega inteiro, para baixar). O banco confere a mesma regra.
 */
export function tipoParaEnvio(tipoDeConteudo: string): TipoDeEnvio {
  const tipo = limparTipoDeConteudo(tipoDeConteudo);
  if (tipo === 'image/jpeg' || tipo === 'image/png' || tipo === 'image/webp') return 'image';
  if (tipo === 'video/mp4') return 'video';
  if (tipo.startsWith('audio/')) return 'audio';
  return 'document';
}

/** O que o painel decide sobre um arquivo que a pessoa escolheu para enviar. */
export type AvaliacaoDoArquivo =
  | {
      ok: true;
      tipo: TipoDeEnvio;
      /** Tipo de conteúdo com que o arquivo sobe para o depósito. */
      conteudo: string;
      nomeNoDeposito: string;
      /** Explicação curta de como o arquivo vai chegar ("Vai como foto"). */
      comoVai: string;
    }
  | { ok: false; erro: string };

/**
 * Confere um arquivo antes de subir: tamanho, e de que jeito ele vai para o WhatsApp.
 * Foto, vídeo ou áudio acima de 16 MB ainda pode ir, mas como documento (até 25 MB).
 */
export function avaliarArquivo(arquivo: { nome: string; tipoInformado?: string | null; tamanho: number }): AvaliacaoDoArquivo {
  if (!Number.isFinite(arquivo.tamanho) || arquivo.tamanho <= 0) return { ok: false, erro: 'Este arquivo está vazio.' };
  if (arquivo.tamanho > LIMITE_DE_DOCUMENTO) {
    return {
      ok: false,
      erro: `Este arquivo tem ${tamanhoLegivel(arquivo.tamanho)}. O painel envia arquivos de até ${tamanhoLegivel(LIMITE_DE_DOCUMENTO)}.`,
    };
  }

  const conteudo = tipoDeConteudoDoArquivo(arquivo.nome, arquivo.tipoInformado);
  const natural = tipoParaEnvio(conteudo);
  const tipo: TipoDeEnvio = natural !== 'document' && arquivo.tamanho > LIMITE_DE_MIDIA ? 'document' : natural;
  const noDeposito = nomeNoDeposito(arquivo.nome, conteudo);

  let comoVai = 'Vai como documento';
  if (tipo === 'image') comoVai = 'Vai como foto';
  else if (tipo === 'video') comoVai = 'Vai como vídeo';
  else if (tipo === 'audio') comoVai = 'Vai como mensagem de voz, sem legenda';
  else if (natural !== 'document') comoVai = `Passa de ${tamanhoLegivel(LIMITE_DE_MIDIA)}: vai como documento`;
  else if (conteudo.startsWith('image/') || conteudo.startsWith('video/')) comoVai = 'O WhatsApp não mostra este formato na conversa: vai como documento';

  return { ok: true, tipo, conteudo, nomeNoDeposito: noDeposito, comoVai };
}

export const ehTipoDeEnvio = (valor: unknown): valor is TipoDeEnvio =>
  valor === 'image' || valor === 'audio' || valor === 'video' || valor === 'document';

/**
 * Nome do arquivo dentro do depósito: só letras sem acento, números, ponto, traço e sublinhado,
 * começando por letra ou número. (O nome de verdade, com acentos e espaços, fica guardado à parte
 * e é o que as pessoas veem.)
 */
export function nomeNoDeposito(nomeOriginal: string, tipoDeConteudo: string): string {
  const semPasta = nomeOriginal.split(/[\\/]/).pop() ?? '';
  let limpo = semPasta
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[-.]+$/, '');

  let extensao = extensaoDe(limpo);
  if (extensao) limpo = limpo.slice(0, -(extensao.length + 1)).replace(/[-.]+$/, '');
  else extensao = EXTENSAO_PELO_TIPO[limparTipoDeConteudo(tipoDeConteudo)] ?? '';

  const base = limpo.slice(0, 80).replace(/[-.]+$/, '') || 'arquivo';
  return extensao ? `${base}.${extensao}` : base;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHAVE = '[a-zA-Z0-9_-]{16,80}';
const NOME = '[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}';
const CAMINHO_DE_ENVIO = new RegExp(`^(${UUID})/(${UUID})/envios/(${CHAVE})/${NOME}$`);
const CAMINHO_DE_ARQUIVO = new RegExp(`^${UUID}/${UUID}/(?:${UUID}|envios/${CHAVE})/${NOME}$`);

/** Onde o navegador coloca o arquivo de um envio. */
export function caminhoDoEnvio(workspaceId: string, conversaId: string, chave: string, nome: string): string {
  return `${workspaceId}/${conversaId}/envios/${chave}/${nome}`;
}

/** O caminho é mesmo o da pasta deste envio (desta empresa, desta conversa e desta chave)? */
export function ehCaminhoDoEnvio(caminho: unknown, workspaceId: string, conversaId: string, chave: string): caminho is string {
  if (typeof caminho !== 'string') return false;
  const partes = CAMINHO_DE_ENVIO.exec(caminho);
  return Boolean(partes && partes[1] === workspaceId && partes[2] === conversaId && partes[3] === chave);
}

/** Um caminho com o formato de um arquivo da Inbox (recebido ou enviado). Quem pode ler é o depósito que decide. */
export function ehCaminhoDeArquivo(caminho: unknown): caminho is string {
  return typeof caminho === 'string' && caminho.length <= 400 && CAMINHO_DE_ARQUIVO.test(caminho);
}

/** Endereço, dentro do painel, que mostra (ou baixa) um arquivo. Confere a sessão a cada pedido. */
export function enderecoDoArquivo(caminho: string, baixarComo?: string | null): string {
  const base = `/api/inbox/midia/${caminho}`;
  return baixarComo ? `${base}?baixar=${encodeURIComponent(baixarComo)}` : base;
}

/** Nome para o arquivo baixado: sem quebras de linha, aspas ou barras, com no máximo 150 letras. */
export function nomeParaBaixar(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.replace(/[\u0000-\u001f\u007f"\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  return limpo || null;
}

/**
 * Tamanho com que uma foto (ou vídeo) aparece dentro do balão: cabe numa caixa de 330 × 340 sem distorcer
 * e nunca é ampliada. Saber o tamanho antes de a imagem carregar evita que a conversa "pule" enquanto carrega.
 * `null` quando as medidas não são conhecidas.
 */
export function tamanhoNoBalao(largura: number | null | undefined, altura: number | null | undefined): { width: number; height: number } | null {
  if (!largura || !altura || largura <= 0 || altura <= 0 || !Number.isFinite(largura) || !Number.isFinite(altura)) return null;
  const escala = Math.min(1, 330 / largura, 340 / altura);
  return { width: Math.max(1, Math.round(largura * escala)), height: Math.max(1, Math.round(altura * escala)) };
}

/** 245000 → "239 KB"; 3355443 → "3,2 MB". Zero ou desconhecido → "". */
export function tamanhoLegivel(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1).replace('.', ',')} MB`;
}

/** 9 → "0:09"; 201 → "3:21"; 3725 → "1:02:05". Desconhecido → `null`. */
export function duracaoLegivel(segundos: number | null | undefined): string | null {
  if (typeof segundos !== 'number' || !Number.isFinite(segundos) || segundos < 0) return null;
  const total = Math.round(segundos);
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const resto = String(total % 60).padStart(2, '0');
  return horas > 0 ? `${horas}:${String(minutos).padStart(2, '0')}:${resto}` : `${minutos}:${resto}`;
}

/** Como chamar o arquivo em uma frase: "Foto", "Mensagem de voz", "Documento Contrato.pdf"... */
export function nomeDoTipo(tipo: TipoDeArquivo, voz: boolean): string {
  if (tipo === 'image') return 'Foto';
  if (tipo === 'video') return 'Vídeo';
  if (tipo === 'audio') return voz ? 'Mensagem de voz' : 'Áudio';
  if (tipo === 'sticker') return 'Figurinha';
  return 'Documento';
}

/**
 * Situação do arquivo de uma mensagem, do jeito que a tela mostra:
 *   guardado      — está no depósito, dá para ver e baixar;
 *   buscando      — o painel está trazendo o arquivo do WhatsApp agora;
 *   falhou        — não deu para trazer (a pessoa pode pedir de novo);
 *   grande_demais — passou do tamanho que o painel guarda;
 *   apagado       — já saiu do depósito pelo prazo de guarda.
 */
export type SituacaoDoArquivo = 'guardado' | 'buscando' | 'falhou' | 'grande_demais' | 'apagado';

/** Depois deste tempo "buscando", o painel assume que a busca se perdeu e oferece tentar de novo. */
export const TEMPO_MAXIMO_BUSCANDO = 120_000;

export function situacaoDoArquivo(status: string, mensagemCriadaEm: string, agora: Date): SituacaoDoArquivo {
  if (status === 'stored') return 'guardado';
  if (status === 'too_large') return 'grande_demais';
  if (status === 'deleted') return 'apagado';
  if (status === 'pending') {
    const idade = agora.getTime() - new Date(mensagemCriadaEm).getTime();
    return Number.isFinite(idade) && idade < TEMPO_MAXIMO_BUSCANDO ? 'buscando' : 'falhou';
  }
  return 'falhou';
}

/** O depósito avisou que o arquivo já está lá? (acontece quando o mesmo envio é pedido duas vezes) */
export function depositoDizQueJaExiste(erro: { statusCode?: unknown; message?: unknown; error?: unknown; code?: unknown } | null | undefined): boolean {
  if (!erro) return false;
  return (
    String(erro.statusCode) === '409' ||
    erro.code === 'KeyAlreadyExists' ||
    erro.error === 'Duplicate' ||
    /already exists/i.test(String(erro.message ?? ''))
  );
}

/** O depósito recusou por tamanho? */
export function depositoDizQueEhGrandeDemais(erro: { statusCode?: unknown; message?: unknown; code?: unknown } | null | undefined): boolean {
  if (!erro) return false;
  return String(erro.statusCode) === '413' || erro.code === 'EntityTooLarge' || /maximum allowed size/i.test(String(erro.message ?? ''));
}
