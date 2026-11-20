/**
 * Empacota áudio Opus dentro de um arquivo OGG — o formato de "mensagem de voz" do WhatsApp.
 *
 * O navegador grava em WebM/Opus ou MP4/AAC, e a Evolution manda o que recebe. Só quando o arquivo é
 * OGG/Opus o WhatsApp desenha o áudio como gravado na hora (onda sonora e play redondo). Este módulo
 * faz a parte que falta: codifica em Opus com o WebCodecs e escreve o contêiner OGG.
 *
 * Nada aqui inventa áudio: se o navegador não souber codificar Opus, devolvemos `null` e quem chamou
 * decide (a tela avisa e envia o arquivo como está).
 */

const TAXA_OPUS = 48_000;
/** Amostras que o decodificador deve descartar no começo (valor de referência do Opus em 48 kHz). */
const PRE_SKIP = 312;
/** Quadro de 20 ms, que é o tamanho que o Opus usa por padrão. */
const QUADRO = 960;

type PedacoCodificado = {
  byteLength: number;
  copyTo: (destino: Uint8Array) => void;
  timestamp: number;
  duration: number | null;
};

type CodificadorDeAudio = {
  new (config: object): {
    configure: (config: object) => void;
    encode: (dados: unknown) => void;
    flush: () => Promise<void>;
    close: () => void;
    ondata: ((pedaco: PedacoCodificado) => void) | null;
    onerror: ((evento: unknown) => void) | null;
  };
  isConfigSupported?: (config: object) => Promise<{ supported: boolean }>;
};

type DadoDeAudio = new (config: object) => { close: () => void };

function webCodecs(): { Codificador: CodificadorDeAudio; Dado: DadoDeAudio } | null {
  if (typeof window === 'undefined') return null;
  const janela = window as unknown as { AudioEncoder?: CodificadorDeAudio; AudioData?: DadoDeAudio };
  if (!janela.AudioEncoder || !janela.AudioData) return null;
  return typeof janela.AudioEncoder.isConfigSupported === 'function' ? { Codificador: janela.AudioEncoder, Dado: janela.AudioData } : null;
}

/** O navegador consegue codificar Opus? (Chrome/Edge/Android: sim. Safari antigo: não.) */
export function consegueCodificarOpus(): boolean {
  return webCodecs() !== null;
}

/** Junta os canais num só (o WhatsApp usa voz mono) e reamostra para 48 kHz. */
function monoEm48k(buffer: AudioBuffer): Float32Array {
  const canais = Math.max(1, buffer.numberOfChannels);
  const entrada = new Float32Array(buffer.length);
  for (let c = 0; c < canais; c += 1) {
    const canal = buffer.getChannelData(c);
    for (let i = 0; i < canal.length; i += 1) entrada[i]! += canal[i]! / canais;
  }
  if (Math.abs(buffer.sampleRate - TAXA_OPUS) < 1) return entrada;

  // Reamostragem linear: suficiente para voz e sem depender de biblioteca externa.
  const proporcao = TAXA_OPUS / buffer.sampleRate;
  const saida = new Float32Array(Math.max(1, Math.round(entrada.length * proporcao)));
  for (let i = 0; i < saida.length; i += 1) {
    const posicao = i / proporcao;
    const antes = Math.floor(posicao);
    const depois = Math.min(entrada.length - 1, antes + 1);
    const fracao = posicao - antes;
    saida[i] = entrada[antes]! * (1 - fracao) + entrada[depois]! * fracao;
  }
  return saida;
}

/** Codifica o áudio (já decodificado) em Opus. `null` = este navegador não sabe. */
export async function codificarOpus(buffer: AudioBuffer): Promise<Uint8Array | null> {
  const api = webCodecs();
  if (!api) return null;

  const amostras = monoEm48k(buffer);
  const pacotes: Array<{ dados: Uint8Array; granulo: number }> = [];
  let erro: unknown = null;

  // WebCodecs exige callbacks no construtor; não possui eventos ondata/onerror.
  const codificador = new api.Codificador({
    output: (pedaco: PedacoCodificado) => {
      const dados = new Uint8Array(pedaco.byteLength);
      pedaco.copyTo(dados);
      const granulo = Math.max(PRE_SKIP, Math.round(((pedaco.timestamp + (pedaco.duration ?? 0)) / 1_000_000) * TAXA_OPUS) + PRE_SKIP);
      pacotes.push({ dados, granulo });
    },
    error: (evento: unknown) => { erro = evento; },
  });
  codificador.configure({ codec: 'opus', sampleRate: TAXA_OPUS, numberOfChannels: 1, bitrate: 32_000 });

  for (let inicio = 0; inicio < amostras.length; inicio += QUADRO) {
    const fim = Math.min(amostras.length, inicio + QUADRO);
    const quadro = amostras.slice(inicio, fim);
    if (quadro.length < QUADRO) {
      // O Opus só aceita quadros cheios: completa com silêncio.
      const cheio = new Float32Array(QUADRO);
      cheio.set(quadro);
      codificador.encode(
        new api.Dado({
          format: 'f32-planar',
          sampleRate: TAXA_OPUS,
          numberOfFrames: QUADRO,
          numberOfChannels: 1,
          timestamp: Math.round((inicio / TAXA_OPUS) * 1_000_000),
          data: cheio,
          transfer: [cheio.buffer],
        }),
      );
    } else {
      codificador.encode(
        new api.Dado({
          format: 'f32-planar',
          sampleRate: TAXA_OPUS,
          numberOfFrames: QUADRO,
          numberOfChannels: 1,
          timestamp: Math.round((inicio / TAXA_OPUS) * 1_000_000),
          data: quadro,
          transfer: [quadro.buffer],
        }),
      );
    }
  }

  await codificador.flush();
  codificador.close();
  if (erro || pacotes.length === 0) return null;
  return montarOgg(pacotes);
}

/* ------------------------------- OGG ------------------------------- */

const TABELA_CRC = (() => {
  const tabela = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let valor = i << 24;
    for (let j = 0; j < 8; j += 1) {
      valor = (valor & 0x80000000) !== 0 ? (valor << 1) ^ 0x04c11db7 : valor << 1;
    }
    tabela[i] = valor >>> 0;
  }
  return tabela;
})();

function crc32Ogg(dados: Uint8Array): number {
  let crc = 0;
  for (const byte of dados) {
    crc = ((crc << 8) ^ TABELA_CRC[((crc >>> 24) & 0xff) ^ byte]!) >>> 0;
  }
  return crc >>> 0;
}

/** Monta uma página OGG com um ou mais pacotes. */
function paginaOgg(pacotes: Uint8Array[], tipoDoCabecalho: number, granulo: number, serial: number, sequencia: number): Uint8Array {
  const tabela: number[] = [];
  for (const pacote of pacotes) {
    let restante = pacote.length;
    while (restante >= 255) {
      tabela.push(255);
      restante -= 255;
    }
    tabela.push(restante);
  }
  const corpo = new Uint8Array(pacotes.reduce((soma, pacote) => soma + pacote.length, 0));
  let deslocamento = 0;
  for (const pacote of pacotes) {
    corpo.set(pacote, deslocamento);
    deslocamento += pacote.length;
  }

  const cabecalho = new Uint8Array(27 + tabela.length);
  const vista = new DataView(cabecalho.buffer);
  cabecalho.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  cabecalho[4] = 0; // versão
  cabecalho[5] = tipoDoCabecalho;
  vista.setUint32(6, granulo >>> 0, true);
  vista.setUint32(6 + 4, granulo > 0xffffffff ? 0xffffffff : 0, true); // parte alta do granulo
  vista.setUint32(14, serial, true);
  vista.setUint32(18, sequencia, true);
  vista.setUint32(22, 0, true); // CRC (preenchido abaixo)
  cabecalho[26] = tabela.length;
  cabecalho.set(tabela, 27);

  const pagina = new Uint8Array(cabecalho.length + corpo.length);
  pagina.set(cabecalho, 0);
  pagina.set(corpo, cabecalho.length);
  const crc = crc32Ogg(pagina);
  new DataView(pagina.buffer).setUint32(22, crc, true);
  return pagina;
}

/** Escreve o arquivo OGG inteiro: cabeçalho Opus, etiquetas e os pacotes de áudio. */
export function montarOgg(pacotes: Array<{ dados: Uint8Array; granulo: number }>): Uint8Array {
  const serial = 0x1e7a2b3c;
  const paginas: Uint8Array[] = [];

  const opusHead = new Uint8Array(19);
  opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  opusHead[8] = 1; // versão
  opusHead[9] = 1; // canais (mono)
  new DataView(opusHead.buffer).setUint16(10, PRE_SKIP, true);
  new DataView(opusHead.buffer).setUint32(12, TAXA_OPUS, true);
  new DataView(opusHead.buffer).setUint16(16, 0, true); // ganho
  opusHead[18] = 0; // mapeamento de canais
  paginas.push(paginaOgg([opusHead], 0x02, 0, serial, 0));

  const fornecedor = new TextEncoder().encode('ienvia');
  const opusTags = new Uint8Array(8 + 4 + fornecedor.length + 4);
  opusTags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  new DataView(opusTags.buffer).setUint32(8, fornecedor.length, true);
  opusTags.set(fornecedor, 12);
  new DataView(opusTags.buffer).setUint32(12 + fornecedor.length, 0, true); // nenhum comentário
  paginas.push(paginaOgg([opusTags], 0x00, 0, serial, 1));

  // Agrupa os pacotes em páginas de até ~4 KB, como fazem os gravadores de verdade.
  let sequencia = 2;
  let grupo: Uint8Array[] = [];
  let tamanhoDoGrupo = 0;
  let ultimoGranulo = 0;
  const fecharPagina = (ultima: boolean) => {
    if (grupo.length === 0) return;
    paginas.push(paginaOgg(grupo, ultima ? 0x04 : 0x00, ultimoGranulo, serial, sequencia));
    sequencia += 1;
    grupo = [];
    tamanhoDoGrupo = 0;
  };

  pacotes.forEach((pacote, indice) => {
    grupo.push(pacote.dados);
    tamanhoDoGrupo += pacote.dados.length;
    ultimoGranulo = pacote.granulo;
    const ultima = indice === pacotes.length - 1;
    if (tamanhoDoGrupo >= 4000 && !ultima) fecharPagina(false);
    if (ultima) fecharPagina(true);
  });

  const total = paginas.reduce((soma, pagina) => soma + pagina.length, 0);
  const arquivo = new Uint8Array(total);
  let deslocamento = 0;
  for (const pagina of paginas) {
    arquivo.set(pagina, deslocamento);
    deslocamento += pagina.length;
  }
  return arquivo;
}
