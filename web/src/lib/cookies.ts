/**
 * Regras dos cookies do painel, num lugar só (sessão, tema e workspace escolhido).
 *
 * - Em produção: só trafegam por HTTPS e só no próprio site (SameSite=Lax).
 * - Em desenvolvimento: iguais, mas aceitam http://localhost.
 * - Prévia embutida (IENVIA_PREVIA_EMBUTIDA=1, só fora de produção): quando o painel é
 *   aberto dentro de um quadro em outro site, o navegador só guarda o cookie se ele for
 *   SameSite=None + Secure. Em produção essa opção é ignorada de propósito.
 */
export interface AtributosDeCookie {
  path: '/';
  sameSite: 'lax' | 'none';
  secure: boolean;
  partitioned?: boolean;
}

export const COOKIE_WORKSPACE = 'ienvia_ws';
export const DIAS_COOKIE_WORKSPACE = 60 * 60 * 24 * 365;

export function atributosDeCookie(ambiente: NodeJS.ProcessEnv = process.env): AtributosDeCookie {
  const emProducao = ambiente.NODE_ENV === 'production';
  if (!emProducao && ambiente.IENVIA_PREVIA_EMBUTIDA === '1') {
    return { path: '/', sameSite: 'none', secure: true, partitioned: true };
  }
  return { path: '/', sameSite: 'lax', secure: emProducao };
}

/**
 * Cookie de sessão do Supabase. `httpOnly` impede que qualquer script da página leia o
 * token de login: todo acesso ao banco é feito pelo servidor, o navegador não precisa dele.
 */
export function atributosDoCookieDeSessao(ambiente: NodeJS.ProcessEnv = process.env) {
  return { ...atributosDeCookie(ambiente), httpOnly: true };
}
