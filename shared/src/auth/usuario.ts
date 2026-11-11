/**
 * Login por nome de usuário.
 *
 * O Supabase Auth só conhece e-mail + senha. Para o cliente poder entrar com um
 * usuário simples ("joao"), transformamos o usuário em um e-mail interno
 * ("joao@zapia.local"). O domínio padrão é o mesmo do sistema antigo, para que as
 * contas migradas continuem entrando com o mesmo usuário e a mesma senha.
 *
 * Quem digitar um e-mail completo entra com o próprio e-mail, sem transformação.
 */

/** Domínio interno usado pelas contas criadas só com nome de usuário. */
export const DOMINIO_USUARIO_PADRAO = 'zapia.local';

const TAMANHO_MAXIMO = 64;
const EMAIL_SIMPLES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Tira espaços, acentos e maiúsculas; mantém só letras, números, ponto, hífen e sublinhado. */
export function normalizarUsuario(entrada: string): string {
  return String(entrada ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, TAMANHO_MAXIMO);
}

/**
 * Converte o que a pessoa digitou no campo "Usuário" no e-mail usado pelo Supabase Auth.
 * Devolve `null` quando a entrada não serve nem como usuário nem como e-mail.
 */
export function usuarioParaEmail(entrada: string, dominio: string = DOMINIO_USUARIO_PADRAO): string | null {
  const bruto = String(entrada ?? '').trim().toLowerCase();
  if (!bruto) return null;

  if (bruto.includes('@')) {
    return EMAIL_SIMPLES.test(bruto) && bruto.length <= 254 ? bruto : null;
  }

  const usuario = normalizarUsuario(bruto);
  if (!usuario || !/[a-z0-9]/.test(usuario)) return null;
  return `${usuario}@${dominio}`;
}

/**
 * Caminho inverso, para exibir: "joao@zapia.local" vira "joao";
 * um e-mail de verdade continua aparecendo como e-mail.
 */
export function emailParaUsuario(email: string | null | undefined, dominio: string = DOMINIO_USUARIO_PADRAO): string {
  const valor = String(email ?? '').trim().toLowerCase();
  if (!valor) return '';
  const sufixo = `@${dominio}`;
  return valor.endsWith(sufixo) ? valor.slice(0, -sufixo.length) : valor;
}

/**
 * Rótulo curto para o topo do painel: "@joao" para quem entra com usuário;
 * "maria" para quem entra com "maria@empresa.com" (o e-mail inteiro fica no menu da conta).
 */
export function apelidoDoLogin(login: string | null | undefined): string {
  const valor = String(login ?? '').trim();
  if (!valor) return '';
  const arroba = valor.indexOf('@');
  return arroba > 0 ? valor.slice(0, arroba) : `@${valor.replace(/^@+/, '')}`;
}

/** Iniciais para o avatar ("Maria Souza" → "MS", "joao" → "JO"). */
export function iniciais(nome: string | null | undefined): string {
  const partes = String(nome ?? '')
    .trim()
    .split(/[\s._@-]+/)
    .filter(Boolean);
  if (partes.length === 0) return '?';
  const primeira = partes[0] ?? '';
  if (partes.length === 1) return primeira.slice(0, 2).toUpperCase();
  const segunda = partes[1] ?? '';
  return `${primeira.charAt(0)}${segunda.charAt(0)}`.toUpperCase();
}
