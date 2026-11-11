/**
 * Uma "Evolution de mentira" para os testes.
 *
 * Os testes não podem criar chips de verdade no WhatsApp. Este servidor imita as chamadas
 * que o painel faz, devolvendo respostas com o mesmo formato de uma Evolution 2.3.7 real
 * (conferidas em 11/11/2026).
 *
 * As rotas /controle/... não existem na Evolution: servem para o teste "ler o QR Code",
 * limpar os chips ou simular uma falha.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const CHAVE_DE_TESTE = 'chave-da-evolution-de-teste';
/** Código de 8 dígitos que a Evolution de mentira sempre devolve. */
export const CODIGO_DE_PAREAMENTO = 'ABCD1234';

const IMAGEM_DO_QR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

/**
 * `instancias` são chips que já existem desde o começo (para os testes da Inbox, que não criam chip):
 * [{ nome, estado: 'open' | 'close' | 'connecting', telefone }]. Eles sobrevivem ao "/controle/reiniciar".
 */
export function criarEvolutionFalsa({ chave = CHAVE_DE_TESTE, instancias: fixas = [] } = {}) {
  /** nome → instância */
  const instancias = new Map();
  /** Tudo o que foi enviado por /message/sendText, na ordem. */
  const enviadas = [];
  /** Toda chamada a /message/sendText, tenha dado certo ou não (para provar que o painel chama uma vez só). */
  const tentativas = [];
  const colocarFixas = () => {
    for (const fixa of fixas) {
      instancias.set(fixa.nome, {
        nome: fixa.nome,
        id: crypto.randomUUID(),
        estado: fixa.estado ?? 'open',
        dono: fixa.telefone ? `${fixa.telefone}@s.whatsapp.net` : null,
        aviso: null,
        qr: 1,
        fixa: true,
      });
    }
  };
  colocarFixas();
  /** 'nenhuma' | 'recusa' (responde 400) | 'pane' (responde 500) | 'queda' (derruba a conexão) | 'silencio' (não responde nunca) */
  let falha = 'nenhuma';
  const pendurados = new Set();

  const responder = (res, status, corpo) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(corpo));
  };
  const naoExiste = (res, nome) =>
    responder(res, 404, { status: 404, error: 'Not Found', response: { message: [`The "${nome}" instance does not exist`] } });

  const avisoPublico = (aviso) =>
    aviso
      ? {
          id: 'aviso-de-teste',
          url: aviso.url,
          headers: aviso.headers ?? {},
          enabled: aviso.enabled !== false,
          events: aviso.events ?? [],
          webhookByEvents: false,
          webhookBase64: false,
        }
      : null;

  function controle(req, res, url) {
    const prefixo = url.searchParams.get('prefixo') ?? '';
    const alvos = [...instancias.values()].filter((instancia) => instancia.nome.startsWith(prefixo));

    if (url.pathname === '/controle/conectar') {
      const telefone = url.searchParams.get('telefone') ?? '5585999990000';
      for (const instancia of alvos) {
        instancia.estado = 'open';
        instancia.dono = `${telefone}@s.whatsapp.net`;
      }
      return responder(res, 200, { conectadas: alvos.length });
    }
    if (url.pathname === '/controle/reiniciar') {
      for (const instancia of alvos) instancias.delete(instancia.nome);
      // Os chips fixos voltam ao estado inicial em vez de sumir.
      colocarFixas();
      falha = 'nenhuma';
      return responder(res, 200, { apagadas: alvos.length });
    }
    if (url.pathname === '/controle/enviadas') {
      if (req.method === 'DELETE') {
        enviadas.length = 0;
        tentativas.length = 0;
      }
      return responder(res, 200, enviadas.filter((envio) => envio.instancia.startsWith(prefixo)));
    }
    if (url.pathname === '/controle/tentativas') {
      return responder(res, 200, tentativas.filter((envio) => envio.instancia.startsWith(prefixo)));
    }
    if (url.pathname === '/controle/falha') {
      falha = url.searchParams.get('tipo') ?? 'nenhuma';
      return responder(res, 200, { falha });
    }
    if (url.pathname === '/controle/instancias') {
      return responder(
        res,
        200,
        alvos.map((instancia) => ({ nome: instancia.nome, estado: instancia.estado, aviso: avisoPublico(instancia.aviso) })),
      );
    }
    return responder(res, 404, { message: `Controle desconhecido: ${url.pathname}` });
  }

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://evolution.local');
    const partes = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (url.pathname === '/') return responder(res, 200, { status: 200, message: 'Welcome to the Evolution API, it is working!', version: '2.3.7' });
    if (partes[0] === 'controle') return controle(req, res, url);

    if (req.headers.apikey !== chave) {
      return responder(res, 401, { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } });
    }
    if (falha === 'silencio') {
      pendurados.add(res);
      res.on('close', () => pendurados.delete(res));
      return; // nunca responde: quem chamou vai desistir pelo tempo limite
    }
    if (falha === 'queda') {
      req.socket.destroy(); // a conexão cai no meio: quem chamou fica sem saber se o pedido foi atendido
      return;
    }
    if (falha === 'recusa') {
      return responder(res, 400, { status: 400, error: 'Bad Request', response: { message: ['Falha simulada'] } });
    }
    if (falha === 'pane') {
      return responder(res, 500, { status: 500, error: 'Internal Server Error', response: { message: 'Falha simulada' } });
    }

    const [grupo, acao, nome] = partes;
    const instancia = nome ? instancias.get(nome) : undefined;

    if (req.method === 'POST' && grupo === 'instance' && acao === 'create') {
      const corpo = await lerCorpo(req);
      const novoNome = String(corpo.instanceName ?? '');
      if (instancias.has(novoNome)) {
        return responder(res, 403, { status: 403, error: 'Forbidden', response: { message: [`This name "${novoNome}" is already in use.`] } });
      }
      const nova = { nome: novoNome, id: crypto.randomUUID(), estado: 'connecting', dono: null, aviso: corpo.webhook ?? null, qr: 1 };
      instancias.set(novoNome, nova);
      return responder(res, 201, {
        instance: { instanceName: novoNome, instanceId: nova.id, integration: 'WHATSAPP-BAILEYS', webhookWaBusiness: null, accessTokenWaBusiness: '', status: 'connecting' },
        hash: crypto.randomUUID().toUpperCase(),
        webhook: nova.aviso ? { webhookUrl: nova.aviso.url, webhookHeaders: nova.aviso.headers ?? {}, webhookByEvents: false, webhookBase64: false } : {},
        websocket: {},
        rabbitmq: {},
        nats: {},
        sqs: {},
        settings: { rejectCall: false, msgCall: '', groupsIgnore: true, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false, wavoipToken: '' },
        qrcode: { pairingCode: null, code: '2@qr-de-teste-1', base64: IMAGEM_DO_QR, count: 1 },
      });
    }

    if (req.method === 'GET' && grupo === 'instance' && acao === 'fetchInstances') {
      const procurado = url.searchParams.get('instanceName');
      const lista = [...instancias.values()].filter((item) => !procurado || item.nome === procurado);
      if (procurado && lista.length === 0) return naoExiste(res, procurado);
      return responder(
        res,
        200,
        lista.map((item) => ({
          id: item.id,
          name: item.nome,
          connectionStatus: item.estado,
          ownerJid: item.dono,
          profileName: null,
          profilePicUrl: null,
          integration: 'WHATSAPP-BAILEYS',
          number: null,
          token: 'TOKEN-DE-TESTE',
          clientName: 'evolution_de_teste',
        })),
      );
    }

    // Envio de texto. As respostas imitam a Evolution 2.3.7 (código-fonte e servidor real conferidos em 11/11/2026).
    if (req.method === 'POST' && grupo === 'message' && acao === 'sendText') {
      if (!instancia) return naoExiste(res, nome ?? '');
      const corpo = await lerCorpo(req);
      tentativas.push({ instancia: instancia.nome, numero: corpo.number, texto: corpo.text });
      if (typeof corpo.number !== 'string' || !corpo.number) {
        return responder(res, 400, { status: 400, error: 'Bad Request', response: { message: [['instance requires property "number"']] } });
      }
      if (typeof corpo.text !== 'string') {
        return responder(res, 400, { status: 400, error: 'Bad Request', response: { message: [['instance requires property "text"']] } });
      }
      if (!corpo.text.trim()) {
        return responder(res, 400, { status: 400, error: 'Bad Request', response: { message: ['Text is required'] } });
      }
      if (instancia.estado !== 'open') {
        // A Evolution de verdade não responde quando o chip não está conectado.
        pendurados.add(res);
        res.on('close', () => pendurados.delete(res));
        return;
      }
      const digitos = corpo.number.replace(/\D/g, '');
      const jid = `${digitos}@s.whatsapp.net`;
      // O fim do número decide o que acontece (ver CONVERSAS_DA_INBOX em dados.mjs).
      if (digitos.endsWith('0404')) {
        return responder(res, 400, { status: 400, error: 'Bad Request', response: { message: [{ jid, exists: false, number: corpo.number }] } });
      }
      if (digitos.endsWith('0500')) {
        return responder(res, 500, { status: 500, error: 'Internal Server Error', response: { message: 'Falha simulada' } });
      }
      const id = `3EB0${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
      enviadas.push({ instancia: instancia.nome, numero: corpo.number, texto: corpo.text, id });
      return responder(res, 201, {
        key: { remoteJid: jid, fromMe: true, id },
        pushName: 'Você',
        status: 'PENDING',
        message: { conversation: corpo.text },
        contextInfo: null,
        messageType: 'conversation',
        messageTimestamp: Math.floor(Date.now() / 1000),
        instanceId: instancia.id,
        source: 'unknown',
      });
    }

    if (grupo === 'instance' || grupo === 'webhook') {
      if (!instancia) return naoExiste(res, nome ?? '');

      if (req.method === 'GET' && grupo === 'instance' && acao === 'connectionState') {
        return responder(res, 200, { instance: { instanceName: instancia.nome, state: instancia.estado } });
      }
      if (req.method === 'GET' && grupo === 'instance' && acao === 'connect') {
        if (instancia.estado === 'open') return responder(res, 200, { instance: { instanceName: instancia.nome, state: 'open' } });
        instancia.estado = 'connecting';
        instancia.qr += 1;
        return responder(res, 200, {
          pairingCode: url.searchParams.get('number') ? CODIGO_DE_PAREAMENTO : null,
          code: `2@qr-de-teste-${instancia.qr}`,
          base64: IMAGEM_DO_QR,
          count: instancia.qr,
        });
      }
      if (req.method === 'DELETE' && grupo === 'instance' && acao === 'logout') {
        instancia.estado = 'close';
        instancia.dono = null;
        return responder(res, 200, { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } });
      }
      if (req.method === 'DELETE' && grupo === 'instance' && acao === 'delete') {
        instancias.delete(instancia.nome);
        return responder(res, 200, { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } });
      }
      if (req.method === 'GET' && grupo === 'webhook' && acao === 'find') {
        return responder(res, 200, avisoPublico(instancia.aviso));
      }
      if (req.method === 'POST' && grupo === 'webhook' && acao === 'set') {
        const corpo = await lerCorpo(req);
        instancia.aviso = corpo.webhook ?? null;
        return responder(res, 201, avisoPublico(instancia.aviso));
      }
    }

    return responder(res, 404, { status: 404, error: 'Not Found', response: { message: [`Cannot ${req.method} ${url.pathname}`] } });
  });

  // Ao desligar, solta quem ficou esperando uma resposta que nunca viria.
  servidor.on('close', () => {
    for (const res of pendurados) res.destroy();
  });
  return servidor;
}

// Rodando direto (node evolution-falsa.mjs): sobe o servidor para os testes de navegador.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const porta = Number(process.env.PORTA_EVOLUTION_FALSA ?? 54398);
  const { CHIPS_FIXOS_NA_EVOLUTION } = await import('./dados.mjs');
  criarEvolutionFalsa({ instancias: CHIPS_FIXOS_NA_EVOLUTION }).listen(porta, '127.0.0.1', () => {
    console.log(`Evolution de mentira ouvindo em http://127.0.0.1:${porta}`);
  });
}
