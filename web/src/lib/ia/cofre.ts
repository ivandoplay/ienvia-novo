import 'server-only';

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * O "cofre" das chaves que os clientes cadastram (Gemini, OpenRouter).
 *
 * A chave do cliente é cifrada AQUI, no servidor do painel, antes de ir para o banco, com um segredo
 * que só este servidor conhece (IENVIA_CHAVE_DOS_SEGREDOS). No banco fica só o texto cifrado: quem
 * tiver acesso ao banco, a uma cópia de segurança ou ao painel do Supabase não consegue ler a chave.
 *
 * Formato do texto cifrado:  v1.<12 bytes aleatórios>.<conferência de 16 bytes>.<conteúdo>
 * (tudo em base64url). O algoritmo é AES-256-GCM, que também detecta qualquer alteração no texto.
 */

const VERSAO = 'v1';
const ALGORITMO = 'aes-256-gcm';

/**
 * O segredo do cofre: 32 bytes, escritos em hexadecimal (64 letras) ou em base64 (43 ou 44 letras).
 * Devolve `null` quando a variável não existe ou não tem esse formato.
 */
export function lerChaveDoCofre(ambiente: Record<string, string | undefined> = process.env): Buffer | null {
  const bruto = ambiente.IENVIA_CHAVE_DOS_SEGREDOS?.trim();
  if (!bruto) return null;
  if (/^[0-9a-fA-F]{64}$/.test(bruto)) return Buffer.from(bruto, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(bruto)) {
    const bytes = Buffer.from(bruto.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return bytes.length === 32 ? bytes : null;
  }
  return null;
}

/**
 * A que este segredo pertence. Entra na conferência do texto cifrado: uma chave cifrada para uma
 * empresa e um provedor não abre se alguém a copiar para outra empresa ou outro provedor.
 */
export const contextoDaChaveDeIa = (workspaceId: string, provedor: string): string => `ienvia:chave-de-ia:${workspaceId}:${provedor}`;

export function cifrar(texto: string, contexto: string, chave: Buffer): string {
  const iv = randomBytes(12);
  const cifrador = createCipheriv(ALGORITMO, chave, iv);
  cifrador.setAAD(Buffer.from(contexto, 'utf8'));
  const conteudo = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  return [VERSAO, iv.toString('base64url'), cifrador.getAuthTag().toString('base64url'), conteudo.toString('base64url')].join('.');
}

/**
 * Devolve o texto original, ou `null` quando o texto cifrado foi alterado, é de outro contexto,
 * foi cifrado com outro segredo ou não tem o formato esperado. Nunca lança erro.
 */
export function decifrar(cifra: string, contexto: string, chave: Buffer): string | null {
  const partes = typeof cifra === 'string' ? cifra.split('.') : [];
  if (partes.length !== 4 || partes[0] !== VERSAO) return null;
  try {
    const iv = Buffer.from(partes[1]!, 'base64url');
    const conferencia = Buffer.from(partes[2]!, 'base64url');
    if (iv.length !== 12 || conferencia.length !== 16) return null;
    const decifrador = createDecipheriv(ALGORITMO, chave, iv);
    decifrador.setAAD(Buffer.from(contexto, 'utf8'));
    decifrador.setAuthTag(conferencia);
    return Buffer.concat([decifrador.update(Buffer.from(partes[3]!, 'base64url')), decifrador.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Os 4 últimos caracteres da chave, para a tela mostrar qual chave está cadastrada ("…x9Zk"). */
export function finalDaChave(chave: string): string {
  const final = chave.trim().slice(-4).replace(/[^A-Za-z0-9._-]/g, '');
  return final || '----';
}
