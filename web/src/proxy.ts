import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { atributosDoCookieDeSessao } from '@/lib/cookies';
import { lerConfigSupabase } from '@/lib/env';

/** Endereços que qualquer pessoa pode abrir sem estar logada. */
const ROTAS_PUBLICAS = ['/login'];

/**
 * Roda antes de toda requisição:
 *  1. renova o cookie de sessão do Supabase quando ele está perto de vencer;
 *  2. manda para /login quem tenta abrir o painel sem estar logado;
 *  3. tira da tela de login quem já está logado.
 */
export async function proxy(request: NextRequest) {
  const config = lerConfigSupabase();
  // Sem Supabase configurado o painel mostra uma tela de "configuração pendente".
  if (!config) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.chavePublica, {
    cookieOptions: atributosDoCookieDeSessao(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesParaGravar) {
        for (const { name, value } of cookiesParaGravar) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesParaGravar) response.cookies.set(name, value, options);
      },
    },
  });

  // getUser() confere o token com o Supabase; não confiar só no conteúdo do cookie.
  const { data, error } = await supabase.auth.getUser();
  const logado = Boolean(data.user) && !error;

  const caminho = request.nextUrl.pathname;
  const ehPublica = ROTAS_PUBLICAS.includes(caminho);
  const ehApi = caminho.startsWith('/api/');

  if (!logado && !ehPublica) {
    if (ehApi) {
      return NextResponse.json({ erro: 'Faça login para continuar.' }, { status: 401 });
    }
    const destino = request.nextUrl.clone();
    destino.pathname = '/login';
    destino.search = '';
    if (caminho !== '/') destino.searchParams.set('voltar', caminho);
    return redirecionarMantendoCookies(destino, response);
  }

  if (logado && (ehPublica || caminho === '/')) {
    const destino = request.nextUrl.clone();
    destino.pathname = '/visao-geral';
    destino.search = '';
    return redirecionarMantendoCookies(destino, response);
  }

  return response;
}

/** Um redirecionamento precisa levar junto os cookies de sessão que acabaram de ser renovados. */
function redirecionarMantendoCookies(destino: URL, origem: NextResponse) {
  const redirecionamento = NextResponse.redirect(destino);
  for (const cookie of origem.cookies.getAll()) redirecionamento.cookies.set(cookie);
  return redirecionamento;
}

export const config = {
  // Tudo, menos arquivos estáticos e imagens.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2)$).*)'],
};
