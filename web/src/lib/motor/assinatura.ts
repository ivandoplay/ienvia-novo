import 'server-only';

import crypto from 'node:crypto';
import {
  CHAVE_PUBLICA_ATUALIZACAO_MOTOR,
  VERSAO_ATUAL_DO_MOTOR,
  serializarManifestoCanonico,
  type ManifestoAssinadoDoMotor,
  type ManifestoDoMotor,
} from '@ienvia/shared';
import { gerarPacoteDoMotor } from './pacote';

function lerChavePrivadaEd25519(env: NodeJS.ProcessEnv = process.env): string | null {
  const hex = env.IENVIA_MOTOR_SIGNING_PRIVATE_KEY_HEX?.trim();
  if (hex && /^[0-9a-f]+$/i.test(hex)) {
    return Buffer.from(hex, 'hex').toString('utf8');
  }
  const pem = env.IENVIA_MOTOR_SIGNING_PRIVATE_KEY?.trim();
  if (pem) {
    return pem.replace(/\\n/g, '\n');
  }
  return null;
}

export function assinarManifestoEd25519(manifesto: ManifestoDoMotor, privateKeyPem: string): ManifestoAssinadoDoMotor {
  const payload = Buffer.from(serializarManifestoCanonico(manifesto), 'utf8');
  const signature = crypto.sign(null, payload, privateKeyPem).toString('base64');
  return {
    manifest: manifesto,
    signature,
    algorithm: 'ed25519',
  };
}

export function verificarAssinaturaDoManifesto(envelope: ManifestoAssinadoDoMotor, publicKeyPem = CHAVE_PUBLICA_ATUALIZACAO_MOTOR): boolean {
  const payload = Buffer.from(serializarManifestoCanonico(envelope.manifest), 'utf8');
  const sig = Buffer.from(envelope.signature, 'base64');
  return crypto.verify(null, payload, publicKeyPem, sig);
}

export function obterVersaoEAssinatura(env: NodeJS.ProcessEnv = process.env): {
  disponivel: boolean;
  versao: string;
  assinado: boolean;
  envelope: ManifestoAssinadoDoMotor | null;
  manifesto: ManifestoDoMotor | null;
} {
  const pacote = gerarPacoteDoMotor();
  if (!pacote) {
    return { disponivel: false, versao: VERSAO_ATUAL_DO_MOTOR, assinado: false, envelope: null, manifesto: null };
  }

  const manifesto: ManifestoDoMotor = {
    version: pacote.version,
    sha256: pacote.sha256,
    size: pacote.size,
    published_at: '2026-11-12T00:00:00.000Z',
    min_node_major: 20,
    notes: 'Motor Ienvia oficial v6 — pareamento seguro, fila anti-reenvio e suporte a mídia e IA.',
  };

  const chavePrivada = lerChavePrivadaEd25519(env);
  if (!chavePrivada) {
    return { disponivel: true, versao: pacote.version, assinado: false, envelope: null, manifesto };
  }

  const envelope = assinarManifestoEd25519(manifesto, chavePrivada);
  return { disponivel: true, versao: pacote.version, assinado: true, envelope, manifesto };
}
