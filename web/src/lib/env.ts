/**
 * Leitura das variáveis de ambiente, num lugar só.
 * Nada aqui é segredo: são o endereço do projeto Supabase e a chave pública.
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
