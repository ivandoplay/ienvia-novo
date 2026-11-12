/**
 * Leitura das variáveis de ambiente, num lugar só.
 * As do Supabase não são segredo (endereço do projeto e chave pública).
 * As da Evolution são segredo: não têm o prefixo NEXT_PUBLIC_, então nunca chegam ao navegador.
 */
import { DOMINIO_USUARIO_PADRAO } from '@ienvia/shared';

export interface ConfigSupabase {
  url: string;
  chavePublica: string;
}

/** Devolve `null` quando o painel ainda não foi ligado a um projeto Supabase. */
export function lerConfigSupabase(): ConfigSupabase | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const chavePublica = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();
  if (!url || !chavePublica) return null;
  return { url, chavePublica };
}

/** Domínio interno das contas que entram só com nome de usuário. */
export function dominioDeUsuario(): string {
  return process.env.AUTH_DOMINIO_USUARIO?.trim() || DOMINIO_USUARIO_PADRAO;
}

export interface ConfigEvolution {
  /** Endereço do servidor da Evolution, sem barra no final. */
  url: string;
  chave: string;
}

/** Devolve `null` quando a Evolution ainda não foi configurada neste ambiente. */
export function lerConfigEvolution(): ConfigEvolution | null {
  const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/+$/, '');
  const chave = process.env.EVOLUTION_API_KEY?.trim();
  if (!url || !chave) return null;
  return { url, chave };
}

/**
 * Endereço público do painel (sem barra no final). É para onde a Evolution avisa quando chega
 * mensagem ou quando o chip conecta, e também entra no cabeçalho opcional do OpenRouter.
 * Reconhece automaticamente IENVIA_URL_PUBLICA, Netlify (URL), Render (RENDER_EXTERNAL_URL) e Vercel.
 */
export function enderecoPublico(ambiente: Record<string, string | undefined> = process.env): string | null {
  const definido = ambiente.IENVIA_URL_PUBLICA?.trim().replace(/\/+$/, '');
  if (definido) return definido;
  const daVercel = ambiente.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (daVercel) return `https://${daVercel}`;
  const daNetlify = ambiente.URL?.trim().replace(/\/+$/, '');
  if (daNetlify && /^https?:\/\//i.test(daNetlify)) return daNetlify;
  const doRender = ambiente.RENDER_EXTERNAL_URL?.trim().replace(/\/+$/, '');
  if (doRender && /^https?:\/\//i.test(doRender)) return doRender;
  return null;
}

/**
 * Endereço de webhook cadastrado na Evolution API quando um chip é criado ou conferido.
 * Quando IENVIA_WEBHOOK_URL está definida (por exemplo, o porteiro Cloudflare ou a Supabase Edge
 * Function), a Evolution passa a avisar diretamente esse endereço em vez do painel.
 */
export function enderecoDoAviso(ambiente: Record<string, string | undefined> = process.env): string | null {
  const direto = ambiente.IENVIA_WEBHOOK_URL?.trim().replace(/\/+$/, '');
  if (direto && /^https?:\/\//i.test(direto)) return direto;
  const base = enderecoPublico(ambiente);
  return base ? `${base}/api/webhooks/evolution` : null;
}
