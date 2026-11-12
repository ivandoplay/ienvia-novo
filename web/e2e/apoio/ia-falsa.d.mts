import type { Server } from 'node:http';

export {
  CHAVE_GEMINI_DE_TESTE,
  CHAVE_GEMINI_NO_LIMITE,
  CHAVE_GEMINI_VAZADA,
  CHAVE_NVIDIA_DE_TESTE,
  CHAVE_NVIDIA_NO_LIMITE,
  CHAVE_OPENROUTER_DE_TESTE,
  CHAVE_OPENROUTER_SEM_CREDITO,
} from './chaves-de-ia.mjs';


/** O pedido de resposta como a "IA de mentira" o entendeu. */
export interface PedidoRecebido {
  provedor: 'gemini' | 'openrouter' | 'nvidia';
  modelo: string;
  sistema: string;
  conversa: Array<{ de: 'cliente' | 'atendente'; texto: string }>;
  anexo: { tipo: string; bytes: number } | null;
  temperatura: number | null;
  /** Só a NVIDIA: o pedido veio com "não pense antes de responder"? */
  semPensar?: boolean;
  /** Só a NVIDIA: veio áudio no pedido? (Nunca pode.) */
  temAudio?: boolean;
}

export declare function respostaPadrao(pedido: PedidoRecebido): string;
export declare function criarIaFalsa(opcoes?: { responder?: (pedido: PedidoRecebido) => string }): Server;
