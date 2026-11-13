import { createHash, randomBytes } from 'node:crypto';

const ALFABETO_PAREAMENTO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function sha256Hex(valor: string | Buffer): string {
  return createHash('sha256').update(valor).digest('hex');
}

/**
 * Gera código humano legível de uso único (`IENV-XXXX-XXXX`), sem caracteres ambíguos (0/O/1/I).
 */
export function gerarCodigoPareamento(): string {
  const bytes = randomBytes(8);
  let corpo = '';
  for (let i = 0; i < 8; i++) {
    corpo += ALFABETO_PAREAMENTO[bytes[i]! % ALFABETO_PAREAMENTO.length]!;
  }
  return `IENV-${corpo.slice(0, 4)}-${corpo.slice(4, 8)}`;
}

export function gerarTokenDeAparelho(): string {
  return randomBytes(32).toString('hex');
}

export function extrairTokenDoMotor(req: Request): string | null {
  const headerDireto = req.headers.get('x-ienvia-motor-token')?.trim();
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim();
  const token = headerDireto || bearer || '';
  if (!token || token.length < 24 || token.length > 200) return null;
  return token;
}
