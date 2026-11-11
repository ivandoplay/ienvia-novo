/** Arquivos pequenos e de verdade (abrem em qualquer programa), gerados em código para os testes e a prévia. */
export declare function fotoDeExemplo(opcoes?: { largura?: number; altura?: number; tom?: 'dia' | 'tarde' }): Buffer;
export declare function figurinhaDeExemplo(lado?: number): Buffer;
export declare function audioDeExemplo(segundos?: number): Buffer;
export declare function pdfDeExemplo(linhas?: string[]): Buffer;
/** Só o começo de um MP4: não toca. Serve para conferir que o painel guarda e mostra o tocador. */
export declare function videoDeExemplo(bytes?: number): Buffer;
