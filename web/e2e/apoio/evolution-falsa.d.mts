import type { Server } from 'node:http';

export declare const CHAVE_DE_TESTE: string;
export declare const CODIGO_DE_PAREAMENTO: string;
export declare function criarEvolutionFalsa(opcoes?: {
  chave?: string;
  /** Chips que já existem desde o começo. */
  instancias?: Array<{ nome: string; estado?: 'open' | 'close' | 'connecting'; telefone?: string | null }>;
}): Server;
