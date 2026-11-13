import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { ehVersaoMaisNova, sha256Hex, serializarManifestoCanonico, verificarManifestoAssinado } from '../src/assinatura.mjs';
import { aplicarAtualizacaoAtomica, recuperarAtualizacaoInterrompida, verificarEAtualizar } from '../src/atualizador.mjs';
import { lerConfiguracao, normalizarCodigoPareamento, salvarConfiguracao } from '../src/config.mjs';
import { extrairConteudoMensagemBaileys, normalizarJidParaContato } from '../src/sessoes.mjs';
import { extractZipBuffer } from '../src/zip.mjs';

function criarZipDeTeste(arquivos) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c >>> 0;
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  for (const item of arquivos) {
    const nameBuf = Buffer.from(item.path, 'utf8');
    const rawBuf = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content, 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compBuf.length, 18);
    local.writeUInt32LE(rawBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, compBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compBuf.length, 20);
    central.writeUInt32LE(rawBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100644 & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compBuf.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(arquivos.length, 8);
  eocd.writeUInt16LE(arquivos.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

test('assinatura Ed25519 valida manifesto legítimo e rejeita adulteração ou downgrade', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const manifest = {
    version: '6.1.0',
    sha256: 'a'.repeat(64),
    size: 2048,
    published_at: '2026-11-12T10:00:00.000Z',
    min_node_major: 20,
  };
  const signature = crypto.sign(null, Buffer.from(serializarManifestoCanonico(manifest)), privateKey).toString('base64');

  const ok = verificarManifestoAssinado({ manifest, signature, algorithm: 'ed25519' }, publicKey);
  assert.equal(ok.version, '6.1.0');
  assert.equal(ehVersaoMaisNova('6.0.0', '6.1.0'), true);
  assert.equal(ehVersaoMaisNova('6.1.0', '6.0.9'), false);

  assert.throws(
    () => verificarManifestoAssinado({ manifest: { ...manifest, size: 9999 }, signature, algorithm: 'ed25519' }, publicKey),
    /Assinatura Ed25519/,
  );
});

test('atualização atômica protege pasta data/ e .env e aplica arquivos novos', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ienvia-motor-upd-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'data', 'wa_auth'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.mjs'), '// versao antiga\n');
    fs.writeFileSync(path.join(tmpDir, 'data', 'motor.json'), '{"deviceToken":"secreto"}\n');
    fs.writeFileSync(path.join(tmpDir, 'data', 'wa_auth', 'creds.json'), '{"me":"ok"}\n');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'KEEP=1\n');

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const zipBuf = criarZipDeTeste([
      { path: 'ienvia-motor/src/index.mjs', content: '// versao 6.2.0\n' },
      { path: 'ienvia-motor/data/motor.json', content: '{"deviceToken":"ROUBADO"}\n' },
      { path: 'ienvia-motor/.env', content: 'KEEP=0\n' },
    ]);
    const manifest = {
      version: '6.2.0',
      sha256: sha256Hex(zipBuf),
      size: zipBuf.length,
      published_at: '2026-11-12T10:00:00.000Z',
      min_node_major: 20,
    };
    const signature = crypto.sign(null, Buffer.from(serializarManifestoCanonico(manifest)), privateKey).toString('base64');

    const res = await verificarEAtualizar({
      rootDir: tmpDir,
      panelUrl: 'https://painel.teste.invalid',
      versaoAtual: '6.0.0',
      chavePublicaPem: publicKey,
      fetchFn: async (url) => {
        if (url.endsWith('/api/motor/versao')) {
          return new Response(JSON.stringify({ manifest, signature, algorithm: 'ed25519' }), { status: 200 });
        }
        return new Response(zipBuf, { status: 200 });
      },
    });

    assert.equal(res.updated, true);
    assert.equal(res.newVersion, '6.2.0');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'src', 'index.mjs'), 'utf8'), '// versao 6.2.0\n');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'data', 'motor.json'), 'utf8'), '{"deviceToken":"secreto"}\n');
    assert.equal(fs.readFileSync(path.join(tmpDir, '.env'), 'utf8'), 'KEEP=1\n');
    assert.equal(recuperarAtualizacaoInterrompida(tmpDir), false);

    // Extraído ZIP diretamente confere contagem.
    const zipLido = extractZipBuffer(zipBuf);
    assert.equal(zipLido.fileCount, 3);

    // Sem atualização se já estiver na mesma versão.
    const semUpdate = await verificarEAtualizar({
      rootDir: tmpDir,
      panelUrl: 'https://painel.teste.invalid',
      versaoAtual: '6.2.0',
      chavePublicaPem: publicKey,
      fetchFn: async () => new Response(JSON.stringify({ manifest, signature, algorithm: 'ed25519' }), { status: 200 }),
    });
    assert.equal(semUpdate.updated, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('zipReader rejeita Zip Slip (../)', () => {
  const zipMalicioso = criarZipDeTeste([{ path: 'ienvia-motor/../../etc/passwd', content: 'x' }]);
  assert.throws(() => extractZipBuffer(zipMalicioso), /Caminho inseguro/);
});

test('configuração local e normalizador de eventos Baileys', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ienvia-motor-cfg-'));
  try {
    assert.equal(normalizarCodigoPareamento('ienv ab12 cd34'), 'IENV-AB12-CD34');
    salvarConfiguracao(tmpDir, {
      panelUrl: 'https://painel.teste',
      deviceToken: 'tok-123',
      executorId: 'exec-1',
    });
    const cfg = lerConfiguracao(tmpDir);
    assert.equal(cfg.panelUrl, 'https://painel.teste');
    assert.equal(cfg.deviceToken, 'tok-123');
    assert.equal(normalizarJidParaContato('5586999990000:12@s.whatsapp.net'), '5586999990000@s.whatsapp.net');
    assert.equal(normalizarJidParaContato('12036300000000@g.us'), null);

    // viewOnce é ignorado por privacidade.
    assert.equal(
      extrairConteudoMensagemBaileys({ message: { viewOnceMessage: { message: { conversation: 'segredo' } } } }),
      null,
    );
    const img = extrairConteudoMensagemBaileys({
      message: { imageMessage: { caption: 'Foto', mimetype: 'image/jpeg', fileLength: 4096 } },
    });
    assert.equal(img?.text, 'Foto');
    assert.equal(img?.media?.kind, 'image');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
