/** A biblioteca não traz tipos; o que este projeto usa está descrito aqui. */
declare module 'opus-recorder' {
  export default class Recorder {
    constructor(opcoes: Record<string, unknown>);
    start(): Promise<void>;
    stop(): Promise<void>;
    close(): void;
    ondataavailable: ((dados: Uint8Array) => void) | null;
    onstop: (() => void) | null;
  }
}
