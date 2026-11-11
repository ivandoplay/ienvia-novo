/** Tema do painel. O escuro é o padrão; o claro é uma escolha individual guardada num cookie. */
export type Tema = 'escuro' | 'claro';

export const COOKIE_TEMA = 'ienvia_tema';
export const UM_ANO_EM_SEGUNDOS = 60 * 60 * 24 * 365;

export function lerTema(valorDoCookie: string | undefined): Tema {
  return valorDoCookie === 'claro' ? 'claro' : 'escuro';
}
