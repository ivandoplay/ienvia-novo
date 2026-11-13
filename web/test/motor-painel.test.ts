import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CHAVE_PUBLICA_ATUALIZACAO_MOTOR, VERSAO_ATUAL_DO_MOTOR } from '@ienvia/shared';
// @ts-expect-error módulo JS puro do pacote motor
import { extractZipBuffer as extractZipRaw } from '../../motor/src/zip.mjs';
const lerZip = (buf: Buffer): Map<string, Buffer> => {
  const res = (extractZipRaw as (b: Buffer) => { files: Array<{ path: string; buffer: Buffer }> })(buf);
  return new Map(res.files.map((f) => [f.path, f.buffer]));
};
import { assinarManifestoEd25519, obterVersaoEAssinatura, verificarAssinaturaDoManifesto } from '@/lib/motor/assinatura';
import { extrairTokenDoMotor, gerarCodigoPareamento, gerarTokenDeAparelho, sha256Hex } from '@/lib/motor/autenticacao';
import { gerarPacoteDoMotor, montarZip } from '@/lib/motor/pacote';

describe('autenticação e códigos do motor local', () => {
  test('gera código legível IENV-XXXX-XXXX sem caracteres ambíguos e SHA-256 hex', () => {
    const codigo = gerarCodigoPareamento();
    expect(codigo).toMatch(/^IENV-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(sha256Hex(codigo)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('gera token forte e extrai de Bearer ou X-Ienvia-Motor-Token', () => {
    const token = gerarTokenDeAparelho();
    expect(token).toHaveLength(64);
    expect(extrairTokenDoMotor(new Request('http://localhost', { headers: { 'x-ienvia-motor-token': token } }))).toBe(token);
    expect(extrairTokenDoMotor(new Request('http://localhost', { headers: { authorization: `Bearer ${token}` } }))).toBe(token);
    expect(extrairTokenDoMotor(new Request('http://localhost', { headers: { authorization: 'Bearer curto' } }))).toBeNull();
  });
});

describe('empacotamento zip do motor local', () => {
  test('monta ZIP determinístico legível pelo descompactador do próprio motor', () => {
    const buf = montarZip([
      { path: 'pasta/a.txt', content: 'olá mundo' },
      { path: 'pasta/exec.sh', content: '#!/bin/sh\necho ok\n', executable: true },
    ]);
    const lido = lerZip(buf);
    expect(lido.get('pasta/a.txt')?.toString('utf8')).toBe('olá mundo');
    expect(lido.get('pasta/exec.sh')?.toString('utf8')).toContain('echo ok');
  });

  test('gerarPacoteDoMotor inclui núcleo e scripts de instalação sem incluir node_modules ou data/', () => {
    const pacote = gerarPacoteDoMotor();
    expect(pacote).not.toBeNull();
    expect(pacote!.version).toBe(VERSAO_ATUAL_DO_MOTOR);
    const entradas = lerZip(pacote!.buffer);
    expect(entradas.has('ienvia-motor/package.json')).toBe(true);
    expect(entradas.has('ienvia-motor/src/index.mjs')).toBe(true);
    expect(entradas.has('ienvia-motor/src/sessoes.mjs')).toBe(true);
    expect(entradas.has('ienvia-motor/scripts/iniciar.sh')).toBe(true);
    expect(entradas.has('ienvia-motor/scripts/iniciar.bat')).toBe(true);
    expect(entradas.has('ienvia-motor/scripts/setup-windows.ps1')).toBe(true);
    expect(entradas.has('ienvia-motor/scripts/setup-linux.sh')).toBe(true);
    expect(entradas.has('ienvia-motor/scripts/setup-termux.sh')).toBe(true);
    for (const chave of entradas.keys()) {
      expect(chave).not.toContain('node_modules');
      expect(chave).not.toContain('/data/');
    }
  });
});

describe('assinatura Ed25519 do manifesto do motor', () => {
  test('assina e verifica com par Ed25519 e valida chave de produção se configurada no .env local', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const info = obterVersaoEAssinatura({ NODE_ENV: 'test', IENVIA_MOTOR_SIGNING_PRIVATE_KEY: privateKey });
    expect(info.disponivel).toBe(true);
    expect(info.assinado).toBe(true);
    expect(info.envelope).not.toBeNull();
    expect(verificarAssinaturaDoManifesto(info.envelope!, publicKey)).toBe(true);

    // Adulteração do SHA-256 invalida imediatamente a assinatura.
    const adulterado = { ...info.envelope!, manifest: { ...info.envelope!.manifest, sha256: '0'.repeat(64) } };
    expect(verificarAssinaturaDoManifesto(adulterado, publicKey)).toBe(false);

    // Se o .env local tem a chave real, verifica que bate com CHAVE_PUBLICA_ATUALIZACAO_MOTOR.
    if (fs.existsSync('/home/user/.env')) {
      const envTexto = fs.readFileSync('/home/user/.env', 'utf8');
      const m = /^IENVIA_MOTOR_SIGNING_PRIVATE_KEY_HEX=([0-9a-f]+)$/m.exec(envTexto);
      if (m?.[1]) {
        const real = obterVersaoEAssinatura({ NODE_ENV: 'test', IENVIA_MOTOR_SIGNING_PRIVATE_KEY_HEX: m[1] });
        expect(real.assinado).toBe(true);
        expect(verificarAssinaturaDoManifesto(real.envelope!, CHAVE_PUBLICA_ATUALIZACAO_MOTOR)).toBe(true);
      }
    }

    // Também testa assinarManifestoEd25519 diretamente.
    const direto = assinarManifestoEd25519(info.manifesto!, privateKey);
    expect(verificarAssinaturaDoManifesto(direto, publicKey)).toBe(true);
  });
});
