'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { atributosDeCookie, COOKIE_WORKSPACE, DIAS_COOKIE_WORKSPACE } from '@/lib/cookies';
import { lerConfigSupabase } from '@/lib/env';
import { obterSessao } from '@/lib/sessao';
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

/** Alterna o workspace ativo para quem participa de mais de uma empresa. */
export async function selecionarWorkspaceAtivo(workspaceId: string): Promise<{ ok: boolean; erro?: string }> {
  const sessao = await obterSessao();
  if (!sessao) return { ok: false, erro: 'Sua sessão expirou.' };
  const valido = sessao.workspaces.some((w) => w.id === workspaceId);
  if (!valido) return { ok: false, erro: 'Você não tem acesso a esse workspace.' };

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_WORKSPACE, workspaceId, { ...atributosDeCookie(), maxAge: DIAS_COOKIE_WORKSPACE });
  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Encerra o Modo Suporte ativo do master e volta para a área administrativa. */
export async function sairDoModoSuporte(): Promise<void> {
  if (lerConfigSupabase()) {
    const supabase = await criarClienteServidor();
    await supabase.rpc('end_support_session');
  }
  revalidatePath('/', 'layout');
  redirect('/contas');
}
