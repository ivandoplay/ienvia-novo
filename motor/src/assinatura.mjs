import crypto from 'node:crypto';
import { CHAVE_PUBLICA_ATUALIZACAO_MOTOR } from './chave-publica.mjs';

export function sha256Hex(bufferOuTexto) {
  return crypto.createHash('sha256').update(bufferOuTexto).digest('hex');
}

export function analisarVersao(versao) {
  if (!versao) return null;
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(String(versao).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function ehVersaoMaisNova(atual, candidata) {
  const a = analisarVersao(atual);
  const b = analisarVersao(candidata);
  if (!a || !b) return false;
  if (b[0] !== a[0]) return b[0] > a[0];
  if (b[1] !== a[1]) return b[1] > a[1];
  return b[2] > a[2];
}

export function serializarManifestoCanonico(manifesto) {
  return JSON.stringify({
    version: manifesto.version,
    sha256: String(manifesto.sha256).toLowerCase(),
    size: manifesto.size,
    published_at: manifesto.published_at,
    min_node_major: manifesto.min_node_major,
    ...(manifesto.notes ? { notes: manifesto.notes } : {}),
  });
}

export function verificarManifestoAssinado(pacote, chavePublicaPem = CHAVE_PUBLICA_ATUALIZACAO_MOTOR) {
  if (!pacote || typeof pacote !== 'object') throw new Error('Manifesto inválido.');
  const { manifest, signature, algorithm } = pacote;
  if (algorithm !== 'ed25519') throw new Error('Algoritmo de assinatura não suportado.');
  if (!manifest || typeof manifest !== 'object') throw new Error('Dados do manifesto ausentes.');
  if (!analisarVersao(manifest.version)) throw new Error('Versão do pacote inválida.');
  if (!/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || ''))) throw new Error('Resumo SHA-256 inválido.');
  if (!Number.isInteger(manifest.size) || manifest.size <= 0) throw new Error('Tamanho do pacote inválido.');

  const payload = Buffer.from(serializarManifestoCanonico(manifest), 'utf8');
  const sig = Buffer.from(String(signature || ''), 'base64');
  const ok = crypto.verify(null, payload, chavePublicaPem, sig);
  if (!ok) {
    throw new Error('Assinatura Ed25519 do pacote não confere — atualização recusada por segurança.');
  }
  return manifest;
}
