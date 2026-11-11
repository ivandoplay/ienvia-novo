import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { atributosDoCookieDeSessao } from '@/lib/cookies';
import { lerConfigSupabase } from '@/lib/env';

/**
 * Cliente Supabase para código que roda no servidor (páginas, ações, rotas de API).
 * Usa a sessão guardada nos cookies do navegador, então toda consulta passa pelo RLS
 * como o usuário logado — o servidor não enxerga nada além do que ele pode ver.
 *
 * `cache` faz com que cada requisição use um único cliente, por mais partes da página que o peçam.
 */
export const criarClienteServidor = cache(async () => {
  const config = lerConfigSupabase();
  if (!config) {
    throw new Error(
      'Supabase não configurado: defina NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
  }

  const cookieStore = await cookies();
  return createServerClient(config.url, config.chavePublica, {
    cookieOptions: atributosDoCookieDeSessao(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesParaGravar) {
        try {
          for (const { name, value, options } of cookiesParaGravar) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Páginas (Server Components) não podem gravar cookies; quem renova a sessão
          // é o proxy (src/proxy.ts), que roda antes de toda requisição.
        }
      },
    },
  });
});
