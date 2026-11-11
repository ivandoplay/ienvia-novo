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
 * mensagem ou quando o chip conecta. Na Vercel vem sozinho; fora dela, defina IENVIA_URL_PUBLICA.
 */
export function enderecoPublico(): string | null {
  const definido = process.env.IENVIA_URL_PUBLICA?.trim().replace(/\/+$/, '');
  if (definido) return definido;
  const daVercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return daVercel ? `https://${daVercel}` : null;
}
