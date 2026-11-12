import type { ServerResponse } from 'node:http';

/** O segredo do cofre usado nos testes e na prévia com dados de exemplo (nunca em produção). */
export declare const SEGREDO_DO_COFRE_DE_TESTE: string;
export declare const BASE_PRINCIPAL_DA_INBOX: string;
export declare const BASE_DE_SUPORTE_DA_INBOX: string;
export declare const ARQUIVO_DE_EXEMPLO_DA_INBOX: string;
export declare const FUNCOES_DA_IA: string[];

/** Cifra uma chave do mesmo jeito que o painel (src/lib/ia/cofre.ts). */
export declare function cifrarComoOPainel(texto: string, workspaceId: string, provedor: string, segredo?: string): string;

export declare function criarIaDoBanco(apoio: {
  tabelas: Record<string, unknown[]>;
  responder: (res: ServerResponse, status: number, corpo: unknown) => void;
}): {
  acoesDaIa: (res: ServerResponse, usuario: { id: string }, nome: string, corpo: Record<string, unknown>) => void;
  faltaParaAIa: (workspaceId: string, chipId?: string | null) => 'ai_key_missing' | 'ai_training_missing' | null;
  reiniciarIa: () => void;
};
