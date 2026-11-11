'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { atributosDeCookie } from '@/lib/cookies';
import { lerConfigSupabase } from '@/lib/env';
import { criarClienteServidor } from '@/lib/supabase/servidor';
import { COOKIE_TEMA, UM_ANO_EM_SEGUNDOS, type Tema } from '@/lib/tema';

/** Encerra a sessão neste navegador e volta para a tela de login. */
export async function sair(): Promise<void> {
  if (lerConfigSupabase()) {
    const supabase = await criarClienteServidor();
    // "local" encerra só esta sessão; o celular e outros computadores continuam logados.
    await supabase.auth.signOut({ scope: 'local' });
  }
  redirect('/login');
}

/** Guarda a escolha de tema (claro/escuro) para a página já chegar na cor certa da próxima vez. */
export async function definirTema(tema: Tema): Promise<void> {
  const valor: Tema = tema === 'claro' ? 'claro' : 'escuro';
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_TEMA, valor, { ...atributosDeCookie(), maxAge: UM_ANO_EM_SEGUNDOS });
}
