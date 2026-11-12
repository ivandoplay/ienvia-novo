import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Cliente Supabase com a chave do SERVIDOR: ignora as regras de acesso por usuário (RLS).
 *
 * Use só onde não existe uma pessoa logada e o banco oferece uma função feita para isso
 * (hoje: receber os avisos da Evolution). Nunca use para atender um pedido vindo do navegador —
 * para isso existe o cliente de `servidor.ts`, que respeita o que cada pessoa pode ver.
 *
 * Devolve `null` quando a chave não foi configurada neste ambiente.
 */
export function criarClienteDeServico(): SupabaseClient | null {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL)?.trim();
  const chave = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY)?.trim();
  if (!url || !chave) return null;
  return createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });
}
