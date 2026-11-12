/**
 * Porteiro do Ienvia (Cloudflare Worker — camada 100% gratuita, sem cartão).
 *
 * Recebe os avisos (webhooks) da Evolution API, descarta ruídos na borda sem gastar cota do banco
 * e encaminha com troca automática (failover):
 *   1) DESTINO_PRINCIPAL (Supabase Edge Function `evolution-webhook`)
 *   2) DESTINOS_RESERVA (painel na Netlify e/ou Render, separados por vírgula)
 *
 * Arquivo único, sem dependências externas: funciona com `wrangler deploy` ou colando direto no
 * editor do painel da Cloudflare.
 */

export interface AmbienteDoPorteiro {
  /** Endereço completo da Supabase Edge Function (ex: https://PROJETO.supabase.co/functions/v1/evolution-webhook). */
  DESTINO_PRINCIPAL?: string;
  /** Lista opcional de endereços reserva separados por vírgula (ex: Netlify,Render). */
  DESTINOS_RESERVA?: string;
  /** Alias singular opcional caso haja só uma reserva. */
  DESTINO_RESERVA?: string;
  /** Tempo máximo por tentativa, em milissegundos (padrão: 12000). */
  TIMEOUT_MS?: string;
}

const CORPO_MAXIMO = 4_000_000;
const TIMEOUT_PADRAO_MS = 12_000;
const EVENTOS_ACEITOS = new Set(['CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'SEND_MESSAGE']);

const responder = (status: number, corpo: Record<string, unknown>, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

const normalizarUrl = (valor: string | undefined): string | null => {
  const limpo = valor?.trim().replace(/\/+$/, '');
  if (!limpo) return null;
  try {
    const parsed = new URL(limpo);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? limpo : null;
  } catch {
    return null;
  }
};

export function listarDestinos(env: AmbienteDoPorteiro): Array<{ nome: string; url: string }> {
  const lista: Array<{ nome: string; url: string }> = [];
  const vistos = new Set<string>();

  const principal = normalizarUrl(env.DESTINO_PRINCIPAL);
  if (principal) {
    vistos.add(principal);
    lista.push({ nome: 'principal', url: principal });
  }

  const reservasBrutas = [env.DESTINOS_RESERVA, env.DESTINO_RESERVA].filter(Boolean).join(',');
  let indiceReserva = 0;
  for (const parte of reservasBrutas.split(',')) {
    const url = normalizarUrl(parte);
    if (!url || vistos.has(url)) continue;
    vistos.add(url);
    indiceReserva += 1;
    lista.push({ nome: `reserva-${indiceReserva}`, url });
  }

  return lista;
}

function timeoutDasTentativas(env: AmbienteDoPorteiro): number {
  const numero = Number(env.TIMEOUT_MS);
  if (!Number.isFinite(numero)) return TIMEOUT_PADRAO_MS;
  return Math.max(1_000, Math.min(25_000, Math.round(numero)));
}

function eventoAceito(corpo: unknown): boolean {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return false;
  const obj = corpo as Record<string, unknown>;
  if (typeof obj.instance !== 'string' || !obj.instance.trim()) return false;
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) return false;
  const evento = String(obj.event ?? '')
    .trim()
    .toUpperCase()
    .replace(/[.-]/g, '_');
  return EVENTOS_ACEITOS.has(evento);
}

/**
 * Só faz failover quando o destino está fora do ar, lento, sobrecarregado ou sem cota.
 * Rejeições explícitas de negócio/segurança (400, 401, 413) são definitivas.
 */
function deveTentarProximo(status: number): boolean {
  return status === 402 || status === 404 || status === 408 || status === 429 || status >= 500;
}

export async function atenderNoPorteiro(
  pedido: Request,
  env: AmbienteDoPorteiro,
  buscar: typeof fetch = fetch,
): Promise<Response> {
  const destinos = listarDestinos(env);

  if (pedido.method === 'GET' || pedido.method === 'HEAD') {
    return responder(200, {
      ok: true,
      servico: 'ienvia-porteiro',
      destinos: destinos.map((d) => d.nome),
    });
  }

  if (pedido.method !== 'POST') {
    return responder(405, { ok: false, erro: 'método não suportado' });
  }

  const autorizacao = pedido.headers.get('authorization') ?? '';
  const segredo = /^Bearer\s+(\S+)$/i.exec(autorizacao)?.[1];
  if (!segredo || segredo.length > 200) {
    return responder(401, { ok: false, erro: 'não autorizado' });
  }

  const bruto = await pedido.text();
  if (bruto.length > CORPO_MAXIMO) {
    return responder(413, { ok: false, erro: 'aviso grande demais' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bruto);
  } catch {
    return responder(400, { ok: false, erro: 'aviso ilegível' });
  }

  if (!eventoAceito(parsed)) {
    return responder(200, { ok: true, resultado: 'ignorado', filtradoNoPorteiro: true });
  }

  if (destinos.length === 0) {
    return responder(503, { ok: false, erro: 'nenhum destino configurado no porteiro' });
  }

  const timeoutMs = timeoutDasTentativas(env);
  let ultimoStatus = 502;

  for (const destino of destinos) {
    try {
      const resposta = await buscar(destino.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${segredo}`,
          'content-type': 'application/json',
        },
        body: bruto,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!deveTentarProximo(resposta.status)) {
        const texto = await resposta.text();
        return new Response(texto, {
          status: resposta.status,
          headers: {
            'content-type': resposta.headers.get('content-type') ?? 'application/json; charset=utf-8',
            'x-ienvia-destino': destino.nome,
          },
        });
      }

      ultimoStatus = resposta.status;
    } catch {
      ultimoStatus = 504;
    }
  }

  return responder(503, {
    ok: false,
    erro: 'todos os destinos falharam temporariamente',
    ultimoStatus,
  });
}

const worker = {
  fetch(pedido: Request, env: AmbienteDoPorteiro): Promise<Response> {
    return atenderNoPorteiro(pedido, env);
  },
};

export default worker;
