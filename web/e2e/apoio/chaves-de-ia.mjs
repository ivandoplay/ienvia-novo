/**
 * As chaves que a "IA de mentira" (ia-falsa.mjs) reconhece. Nenhuma é de verdade.
 * Ficam num arquivo só delas para os testes de navegador poderem usá-las sem carregar o servidor de mentira.
 */
export const CHAVE_GEMINI_DE_TESTE = 'AIzaSyTeste-chave-valida-do-gemini-0001';
/** Chave que existe, mas está no limite de uso (o Gemini responde 429). */
export const CHAVE_GEMINI_NO_LIMITE = 'AIzaSyTeste-chave-no-limite-de-uso-0002';
export const CHAVE_OPENROUTER_DE_TESTE = 'sk-or-v1-teste-chave-valida-0001';
/** Chave que existe, mas a conta está sem crédito (o OpenRouter responde 402). */
export const CHAVE_OPENROUTER_SEM_CREDITO = 'sk-or-v1-teste-conta-sem-credito-0002';
export const CHAVE_NVIDIA_DE_TESTE = 'nvapi-teste-chave-valida-da-nvidia-0001';
/** Chave que existe, mas passou do limite de pedidos por minuto (a NVIDIA responde 429). */
export const CHAVE_NVIDIA_NO_LIMITE = 'nvapi-teste-chave-no-limite-de-uso-0002';
/** A chave que o Google encontrou publicada e bloqueou (403 "reported as leaked"). */
export const CHAVE_GEMINI_VAZADA = 'AIzaSyTeste-chave-que-vazou-e-foi-bloqueada-0003';
