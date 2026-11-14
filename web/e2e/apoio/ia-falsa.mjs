/**
 * Uma "IA de mentira" para os testes: imita o Google Gemini, o OpenRouter e a NVIDIA no mesmo servidor.
 *
 * Os testes não podem gastar a chave de ninguém nem depender de um provedor de fora. Este servidor
 * responde no formato documentado por cada provedor; as respostas de ERRO são cópias das respostas
 * de verdade (apoio-da-reconstrucao/ia-respostas-reais.txt, colhidas em 11/11/2026).
 *
 *   Gemini:      /v1beta/models            e  /v1beta/models/<modelo>:generateContent
 *   OpenRouter:  /openrouter/api/v1/models e  /openrouter/api/v1/chat/completions
 *   NVIDIA:      /nvidia/v1/models         e  /nvidia/v1/chat/completions
 *
 * As rotas /controle/... não existem nos provedores: servem para o teste ver o que foi pedido
 * ou simular uma falha.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  CHAVE_GEMINI_DE_TESTE,
  CHAVE_GEMINI_NO_LIMITE,
  CHAVE_GEMINI_VAZADA,
  CHAVE_NVIDIA_DE_TESTE,
  CHAVE_NVIDIA_NO_LIMITE,
  CHAVE_OPENROUTER_DE_TESTE,
  CHAVE_OPENROUTER_SEM_CREDITO,
} from './chaves-de-ia.mjs';

export {
  CHAVE_GEMINI_DE_TESTE,
  CHAVE_GEMINI_NO_LIMITE,
  CHAVE_GEMINI_VAZADA,
  CHAVE_NVIDIA_DE_TESTE,
  CHAVE_NVIDIA_NO_LIMITE,
  CHAVE_OPENROUTER_DE_TESTE,
  CHAVE_OPENROUTER_SEM_CREDITO,
};

/** O que o Gemini de mentira tem: modelos de conversa, um de voz e um que nem gera texto. */
const MODELOS_DO_GEMINI = [
  // Modelos que o painel usa como primeira escolha (transcrição de áudio).
  { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-embedding-001', displayName: 'Gemini Embedding', supportedGenerationMethods: ['embedContent'] },
];

const MODELOS_DO_OPENROUTER = [
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek: DeepSeek V3', pricing: { prompt: '0.0000003', completion: '0.0000012' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'google/gemma-4-26b-a4b-it:free', name: 'Google: Gemma 4 26B (free)', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', pricing: { prompt: '0.000003', completion: '0.000015' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  { id: 'black-forest-labs/flux-3', name: 'FLUX 3 (só imagem)', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
];

/**
 * O que a NVIDIA de mentira tem (os nomes saíram da lista de verdade, de 11/11/2026):
 *   pensa    — sem o pedido "não pense", gasta a resposta inteira raciocinando e não escreve nada;
 *   enxerga  — recebe foto (os outros recusam com o erro "multimodal processing is not enabled");
 *   liberado — false = aparece na lista, mas a conta não pode usar (404 "Not found for account").
 * Os quatro últimos não são de conversa, e o painel tem de tirá-los da lista.
 */
const MODELOS_DA_NVIDIA = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', pensa: true, enxerga: false, liberado: true },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', pensa: false, enxerga: true, liberado: true },
  { id: 'z-ai/glm-5.3-flash', pensa: true, enxerga: true, liberado: true },
  { id: 'google/gemma-4-31b-it', pensa: false, enxerga: true, liberado: false },
  { id: 'nvidia/nemotron-3.5-embed-1b', pensa: false, enxerga: false, liberado: true },
  { id: 'nvidia/nemotron-3.5-content-safety', pensa: false, enxerga: false, liberado: true },
  { id: 'nvidia/nemotron-parse-2.0', pensa: false, enxerga: false, liberado: true },
  { id: 'deepseek-ai/deepseek-coder-6.7b-instruct', pensa: false, enxerga: false, liberado: true },
];

/** As respostas de erro da NVIDIA, copiadas das de verdade. Repare: cada uma vem num formato. */
const NVIDIA_CHAVE_INVALIDA = { status: 403, title: 'Forbidden', detail: 'Authorization failed' };
const NVIDIA_SEM_CHAVE = 'Header of type `authorization` was missing';
const NVIDIA_MODELO_INEXISTENTE = '404 page not found';
const NVIDIA_MODELO_NAO_LIBERADO = {
  status: 404,
  title: 'Not Found',
  detail: "Function 'ac74040f-9fc9-4c5e-ac74-279ba5161d69': Not found for account 'conta-de-teste'",
};
const NVIDIA_NAO_ENXERGA = {
  message: 'ValueError: Received multimodal data but multimodal processing is not enabled. Use --enable-multimodal flag to enable multimodal processing.',
  type: 'Bad Request',
  code: 400,
};
/** O modelo pensou até acabar o espaço: sem texto, só o raciocínio (que não é resposta). */
const nvidiaSoPensou = (modelo) => ({
  id: 'chatcmpl-so-pensou',
  object: 'chat.completion',
  created: 1,
  model: modelo,
  choices: [
    {
      index: 0,
      finish_reason: 'length',
      message: { role: 'assistant', content: null, reasoning_content: "Here's a thinking process: 1. Analyze the user input. 2. The customer is asking" },
    },
  ],
  usage: { prompt_tokens: 55, completion_tokens: 200, total_tokens: 255, completion_tokens_details: { reasoning_tokens: 200 } },
});

function lerCorpo(req) {
  return new Promise((resolve) => {
    let texto = '';
    req.on('data', (parte) => (texto += parte));
    req.on('end', () => {
      try {
        resolve(texto ? JSON.parse(texto) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const CHAVE_INVALIDA_NO_GEMINI = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } },
      { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: 'API key not valid. Please pass a valid API key.' },
    ],
  },
};
const SEM_CHAVE_NO_GEMINI = {
  error: {
    code: 403,
    message: "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
    status: 'PERMISSION_DENIED',
  },
};

/**
 * `responder` decide o texto que a "IA" devolve. Recebe { provedor, modelo, sistema, conversa, anexo }
 * (conversa = [{ de: 'cliente' | 'atendente', texto }]) e devolve o texto. O padrão repete a última
 * fala do cliente, para o teste reconhecer a resposta.
 */
export function criarIaFalsa({ responder: responderOriginal = respostaPadrao } = {}) {
  /** Todo pedido de resposta recebido, na ordem (para o teste conferir o que o painel mandou). */
  const pedidos = [];
  /** Falha simulada: { tipo, vezes, provedor } — vale para os próximos `vezes` pedidos de resposta. */
  let falha = null;
  let proximaResposta = null;
  const pendurados = new Set();

  const decidir = (pedido) => {
    if (proximaResposta !== null) {
      const r = proximaResposta;
      proximaResposta = null;
      return r;
    }
    return responderOriginal(pedido);
  };

  const responder = (res, status, corpo) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(corpo));
  };
  /** Alguns erros de verdade chegam em texto puro, sem JSON. */
  const responderTexto = (res, status, texto) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(texto);
  };

  /** Devolve true quando a falha simulada já respondeu por conta própria. */
  function aplicarFalha(provedor, res) {
    if (!falha || falha.vezes <= 0 || (falha.provedor && falha.provedor !== provedor)) return false;
    falha.vezes -= 1;
    const { tipo } = falha;
    if (tipo === 'queda') {
      res.destroy();
      return true;
    }
    if (tipo === 'silencio') {
      pendurados.add(res);
      return true;
    }
    if (provedor === 'gemini') {
      if (tipo === 'pane') responder(res, 503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } });
      else if (tipo === 'limite') responder(res, 429, { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } });
      else if (tipo === 'bloqueio') responder(res, 200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 9, totalTokenCount: 9 } });
      else if (tipo === 'vazio') responder(res, 200, { candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS', index: 0 }], usageMetadata: { promptTokenCount: 9, totalTokenCount: 9 } });
      else return false;
      return true;
    }
    if (provedor === 'nvidia') {
      if (tipo === 'pane') responder(res, 500, { message: 'Internal server error', type: 'Internal Server Error', code: 500 });
      // O corpo de um 429 de verdade da NVIDIA não foi observado; o painel se guia só pelo número.
      else if (tipo === 'limite') responder(res, 429, { status: 429, title: 'Too Many Requests' });
      else if (tipo === 'bloqueio') responder(res, 422, { error: { message: 'input rejected by content safety screening' } });
      else if (tipo === 'vazio') responder(res, 200, nvidiaSoPensou('x'));
      else return false;
      return true;
    }
    if (tipo === 'pane') responder(res, 502, { error: { message: 'Provider returned error', code: 502 } });
    else if (tipo === 'limite') responder(res, 429, { error: { message: 'Rate limit exceeded: free-models-per-day.', code: 429 } });
    else if (tipo === 'bloqueio') responder(res, 403, { error: { message: 'Your input was flagged by moderation.', code: 403 } });
    else if (tipo === 'vazio') responder(res, 200, { id: 'gen-vazio', object: 'chat.completion', created: 1, model: 'x', system_fingerprint: null, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] });
    // O OpenRouter às vezes devolve "200" com o erro do fornecedor dentro do corpo.
    else if (tipo === 'erro-no-corpo') responder(res, 200, { error: { message: 'Provider returned error', code: 502 } });
    else return false;
    return true;
  }

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://ia.falsa');
    const caminho = url.pathname;

    // ----- controle (só para os testes) -----
    if (caminho === '/controle/pedidos' && req.method === 'GET') return responder(res, 200, pedidos);
    if (caminho === '/controle/reiniciar' && req.method === 'POST') {
      pedidos.length = 0;
      falha = null;
      proximaResposta = null;
      return responder(res, 200, { ok: true });
    }
    if (caminho === '/controle/proxima-resposta' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      proximaResposta = typeof corpo?.texto === 'string' ? corpo.texto : null;
      return responder(res, 200, { ok: true });
    }
    if (caminho === '/controle/falha' && req.method === 'POST') {
      const tipo = url.searchParams.get('tipo') ?? 'nenhuma';
      falha = tipo === 'nenhuma' ? null : { tipo, vezes: Number(url.searchParams.get('vezes') ?? 1), provedor: url.searchParams.get('provedor') };
      return responder(res, 200, { ok: true });
    }

    // ----- Gemini -----
    if (caminho.startsWith('/v1beta/')) {
      const chave = String(req.headers['x-goog-api-key'] ?? '');
      if (!chave) return responder(res, 403, SEM_CHAVE_NO_GEMINI);
      if (chave === CHAVE_GEMINI_VAZADA) {
        return responder(res, 403, { error: { code: 403, message: 'Your API key was reported as leaked. Please use another API key.', status: 'PERMISSION_DENIED' } });
      }
      if (chave !== CHAVE_GEMINI_DE_TESTE && chave !== CHAVE_GEMINI_NO_LIMITE) return responder(res, 400, CHAVE_INVALIDA_NO_GEMINI);

      if (req.method === 'GET' && caminho === '/v1beta/models') return responder(res, 200, { models: MODELOS_DO_GEMINI });

      const gerar = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(caminho);
      if (req.method === 'POST' && gerar) {
        const modelo = decodeURIComponent(gerar[1]);
        const corpo = await lerCorpo(req);
        const conversa = (corpo.contents ?? []).map((fala) => ({
          de: fala.role === 'model' ? 'atendente' : 'cliente',
          texto: (fala.parts ?? []).map((parte) => parte.text ?? '').filter(Boolean).join('\n'),
        }));
        const anexo = (corpo.contents ?? []).flatMap((fala) => fala.parts ?? []).find((parte) => parte.inlineData)?.inlineData ?? null;
        const pedido = {
          provedor: 'gemini',
          modelo,
          sistema: (corpo.systemInstruction?.parts ?? []).map((parte) => parte.text ?? '').join(''),
          conversa,
          anexo: anexo ? { tipo: anexo.mimeType, bytes: Buffer.from(anexo.data ?? '', 'base64').length } : null,
          temperatura: corpo.generationConfig?.temperature ?? null,
        };
        pedidos.push(pedido);
        if (chave === CHAVE_GEMINI_NO_LIMITE) {
          return responder(res, 429, { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } });
        }
        if (aplicarFalha('gemini', res)) return undefined;
        if (!MODELOS_DO_GEMINI.some((item) => item.name === `models/${modelo}` && item.supportedGenerationMethods.includes('generateContent'))) {
          return responder(res, 404, {
            error: { code: 404, message: `models/${modelo} is not found for API version v1beta, or is not supported for generateContent.`, status: 'NOT_FOUND' },
          });
        }
        const texto = decidir(pedido);
        // O modelo "que pensa" devolve o raciocínio numa parte separada, que o painel tem de ignorar.
        const partes = modelo === 'gemini-4-argon' ? [{ text: 'Raciocínio interno que não é a resposta.', thought: true }, { text: texto }] : [{ text: texto }];
        return responder(res, 200, {
          candidates: [{ content: { parts: partes, role: 'model' }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 18, totalTokenCount: 138 },
          modelVersion: modelo,
          responseId: `resposta-${pedidos.length}`,
        });
      }
      return responder(res, 404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
    }

    // ----- OpenRouter -----
    if (caminho.startsWith('/openrouter/api/v1/')) {
      const rota = caminho.slice('/openrouter/api/v1'.length);
      const chave = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      // A lista de modelos do OpenRouter é pública.
      if (req.method === 'GET' && rota === '/models') return responder(res, 200, { data: MODELOS_DO_OPENROUTER });

      if (!chave) return responder(res, 401, { error: { message: 'No cookie auth credentials found', code: 401 } });
      if (chave !== CHAVE_OPENROUTER_DE_TESTE && chave !== CHAVE_OPENROUTER_SEM_CREDITO) {
        return responder(res, 401, { error: { message: 'User not found.', code: 401 } });
      }

      if (req.method === 'POST' && rota === '/chat/completions') {
        const corpo = await lerCorpo(req);
        const mensagens = Array.isArray(corpo.messages) ? corpo.messages : [];
        const emTexto = (conteudo) =>
          Array.isArray(conteudo) ? conteudo.map((parte) => (parte.type === 'text' ? parte.text : '')).filter(Boolean).join('\n') : String(conteudo ?? '');
        const imagem = mensagens.flatMap((mensagem) => (Array.isArray(mensagem.content) ? mensagem.content : [])).find((parte) => parte.type === 'image_url');
        const dadosDaImagem = /^data:([^;]+);base64,(.*)$/.exec(imagem?.image_url?.url ?? '');
        const pedido = {
          provedor: 'openrouter',
          modelo: String(corpo.model ?? ''),
          sistema: mensagens.filter((mensagem) => mensagem.role === 'system').map((mensagem) => emTexto(mensagem.content)).join('\n'),
          conversa: mensagens
            .filter((mensagem) => mensagem.role !== 'system')
            .map((mensagem) => ({ de: mensagem.role === 'assistant' ? 'atendente' : 'cliente', texto: emTexto(mensagem.content) })),
          anexo: dadosDaImagem ? { tipo: dadosDaImagem[1], bytes: Buffer.from(dadosDaImagem[2], 'base64').length } : null,
          temperatura: corpo.temperature ?? null,
        };
        pedidos.push(pedido);
        if (chave === CHAVE_OPENROUTER_SEM_CREDITO) {
          return responder(res, 402, { error: { message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits', code: 402 } });
        }
        if (aplicarFalha('openrouter', res)) return undefined;
        const escolhido = MODELOS_DO_OPENROUTER.find((item) => item.id === pedido.modelo && item.architecture.output_modalities.includes('text'));
        if (!escolhido) return responder(res, 400, { error: { message: `${pedido.modelo} is not a valid model ID`, code: 400 } });
        // Foto mandada a um modelo que só lê texto (resposta copiada da de verdade).
        if (pedido.anexo && !escolhido.architecture.input_modalities.includes('image')) {
          return responder(res, 404, {
            error: {
              message: 'No endpoints found that support image input',
              code: 404,
              metadata: { routing_funnel: [{ step: 'Initial Endpoints', endpoint_count: 3 }], failed_routing_step: 'Filter by Image Support' },
            },
          });
        }
        return responder(res, 200, {
          id: `gen-${pedidos.length}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: pedido.modelo,
          system_fingerprint: null,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: decidir(pedido) } }],
          usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 },
        });
      }
      return responder(res, 404, { error: { message: 'Not Found', code: 404 } });
    }

    // ----- NVIDIA -----
    if (caminho.startsWith('/nvidia/v1/')) {
      const rota = caminho.slice('/nvidia/v1'.length);
      // A lista de modelos da NVIDIA é pública, igual para todo mundo, e só traz o nome de cada modelo.
      if (req.method === 'GET' && rota === '/models') {
        return responder(res, 200, {
          object: 'list',
          data: MODELOS_DA_NVIDIA.map((item) => ({ id: item.id, object: 'model', created: 735790403, owned_by: item.id.split('/')[0] })),
        });
      }

      if (req.method === 'POST' && rota === '/chat/completions') {
        if (!req.headers.authorization) return responderTexto(res, 401, NVIDIA_SEM_CHAVE);
        const chave = String(req.headers.authorization).replace(/^Bearer\s+/i, '');
        if (chave !== CHAVE_NVIDIA_DE_TESTE && chave !== CHAVE_NVIDIA_NO_LIMITE) return responder(res, 403, NVIDIA_CHAVE_INVALIDA);

        const corpo = await lerCorpo(req);
        const mensagens = Array.isArray(corpo.messages) ? corpo.messages : [];
        const emTexto = (conteudo) =>
          Array.isArray(conteudo) ? conteudo.map((parte) => (parte.type === 'text' ? parte.text : '')).filter(Boolean).join('\n') : String(conteudo ?? '');
        const partes = mensagens.flatMap((mensagem) => (Array.isArray(mensagem.content) ? mensagem.content : []));
        const imagem = partes.find((parte) => parte.type === 'image_url');
        const dadosDaImagem = /^data:([^;]+);base64,(.*)$/.exec(imagem?.image_url?.url ?? '');
        const pedido = {
          provedor: 'nvidia',
          modelo: String(corpo.model ?? ''),
          sistema: mensagens.filter((mensagem) => mensagem.role === 'system').map((mensagem) => emTexto(mensagem.content)).join('\n'),
          conversa: mensagens
            .filter((mensagem) => mensagem.role !== 'system')
            .map((mensagem) => ({ de: mensagem.role === 'assistant' ? 'atendente' : 'cliente', texto: emTexto(mensagem.content) })),
          anexo: dadosDaImagem ? { tipo: dadosDaImagem[1], bytes: Buffer.from(dadosDaImagem[2], 'base64').length } : null,
          temperatura: corpo.temperature ?? null,
          // O painel tem de pedir ao modelo que não "pense" antes de responder.
          semPensar: corpo.chat_template_kwargs?.enable_thinking === false,
          // Áudio nunca pode chegar aqui: os modelos de verdade o descartam calados e inventam a resposta.
          temAudio: partes.some((parte) => parte.type === 'audio_url' || parte.type === 'input_audio'),
        };
        pedidos.push(pedido);
        if (chave === CHAVE_NVIDIA_NO_LIMITE) return responder(res, 429, { status: 429, title: 'Too Many Requests' });
        if (aplicarFalha('nvidia', res)) return undefined;

        const escolhido = MODELOS_DA_NVIDIA.find((item) => item.id === pedido.modelo);
        if (!escolhido) return responderTexto(res, 404, NVIDIA_MODELO_INEXISTENTE);
        if (!escolhido.liberado) return responder(res, 404, NVIDIA_MODELO_NAO_LIBERADO);
        if (pedido.anexo && !escolhido.enxerga) return responder(res, 400, NVIDIA_NAO_ENXERGA);
        if (escolhido.pensa && !pedido.semPensar) return responder(res, 200, nvidiaSoPensou(pedido.modelo));
        return responder(res, 200, {
          id: `chatcmpl-${pedidos.length}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          // A NVIDIA de verdade devolve o modelo com outro nome ("private/nvidia/..."): a tela tem de mostrar o nome que a pessoa escolheu.
          model: `private/${pedido.modelo}`,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: decidir(pedido), reasoning_content: null } }],
          usage: { prompt_tokens: 55, completion_tokens: 8, total_tokens: 63, completion_tokens_details: { reasoning_tokens: 0 } },
        });
      }
      return responderTexto(res, 404, NVIDIA_MODELO_INEXISTENTE);
    }

    return responder(res, 404, { error: 'rota não imitada' });
  });

  // Ao desligar, solta quem ficou esperando uma resposta que nunca viria.
  servidor.on('close', () => {
    for (const res of pendurados) res.destroy();
  });
  return servidor;
}

/** Sem roteiro definido: o teste de conexão recebe "OK"; o resto recebe a última fala do cliente de volta. */
export function respostaPadrao({ sistema, conversa }) {
  if (sistema.includes('Responda apenas com a palavra OK')) return 'OK';
  const ultima = [...conversa].reverse().find((fala) => fala.de === 'cliente');
  return `Resposta de teste para: "${ultima?.texto ?? ''}"`;
}

// Rodando direto (node ia-falsa.mjs): sobe o servidor para os testes de navegador.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const porta = Number(process.env.PORTA_IA_FALSA ?? 54397);
  criarIaFalsa().listen(porta, '127.0.0.1', () => {
    console.log(`IA de mentira ouvindo em http://127.0.0.1:${porta}`);
  });
}
