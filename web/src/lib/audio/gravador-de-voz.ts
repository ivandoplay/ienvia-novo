/**
 * Gravador de mensagem de voz que produz OGG/Opus em qualquer navegador.
 *
 * O MediaRecorder só grava OGG/Opus no Chrome do Android; no computador ele grava WebM e no iPhone
 * grava MP4/AAC. Aí o áudio chegava no WhatsApp como arquivo anexado, não como "gravado agora".
 *
 * Aqui a gravação do microfone é convertida em OGG/Opus de verdade por uma biblioteca pequena
 * (opus-recorder, licença BSD, ~180 KB), que roda dentro de um Web Worker e não pesa no resto do
 * painel: só é baixada quando a pessoa aperta "Gravar".
 */

export type GravadorDeVoz = {
  /** Termina a gravação e devolve o OGG/Opus pronto. */
  parar: () => Promise<Blob | null>;
  /** Descarta a gravação (a pessoa cancelou). */
  cancelar: () => void;
  /** Segundos já gravados. */
  segundos: () => number;
};

type RecorderDaBiblioteca = {
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  close: () => void;
  ondataavailable: ((dados: Uint8Array) => void) | null;
  onstop: (() => void) | null;
};

/**
 * Começa a gravar. Devolve `null` quando o navegador não deixa usar o microfone ou não consegue
 * carregar a biblioteca — quem chamou cai no gravador simples do navegador.
 */
export async function comecarAGravarEmOgg(fluxo: MediaStream): Promise<GravadorDeVoz | null> {
  try {
    const modulo = (await import('opus-recorder')) as unknown as {
      default?: new (opcoes: Record<string, unknown>) => RecorderDaBiblioteca;
    };
    const Recorder = modulo.default;
    if (!Recorder) return null;

    const pedacos: Uint8Array[] = [];
    const inicio = Date.now();
    let terminou: (valor: Blob | null) => void = () => undefined;
    const acabou = new Promise<Blob | null>((resolver) => {
      terminou = resolver;
    });

    const gravador = new Recorder({
      // 48 kHz mono, 32 kbps: é exatamente o perfil que o WhatsApp usa em recado de voz.
      encoderSampleRate: 48_000,
      encoderChannels: 1,
      encoderBitRate: 32_000,
      encoderFrameSize: 20,
      numberOfChannels: 1,
      streamPages: false,
      // Os arquivos da biblioteca são servidos pelo próprio painel (public/gravador).
      encoderPath: '/gravador/encoderWorker.min.js',
      mediaStream: fluxo,
    });

    gravador.ondataavailable = (dados) => {
      if (dados?.length) pedacos.push(dados);
    };
    gravador.onstop = () => {
      if (pedacos.length === 0) {
        terminou(null);
        return;
      }
      const total = pedacos.reduce((soma, parte) => soma + parte.length, 0);
      const juntos = new Uint8Array(total);
      let deslocamento = 0;
      for (const parte of pedacos) {
        juntos.set(parte, deslocamento);
        deslocamento += parte.length;
      }
      terminou(new Blob([juntos.buffer as ArrayBuffer], { type: 'audio/ogg' }));
    };

    await gravador.start();

    return {
      parar: async () => {
        await gravador.stop();
        const arquivo = await acabou;
        gravador.close();
        return arquivo;
      },
      cancelar: () => {
        try {
          void gravador.stop();
          gravador.close();
        } catch {
          /* já parado */
        }
        terminou(null);
      },
      segundos: () => Math.round((Date.now() - inicio) / 1000),
    };
  } catch {
    return null;
  }
}
