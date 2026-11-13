import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ehVersaoMaisNova, sha256Hex, verificarManifestoAssinado } from './assinatura.mjs';
import { CHAVE_PUBLICA_ATUALIZACAO_MOTOR } from './chave-publica.mjs';
import { extractZipBuffer } from './zip.mjs';

// Pastas e arquivos do usuário nunca são sobrescritos pela atualização automática.
const PROTEGIDOS = new Set(['data', 'node_modules', '.runtime', '.git', '.env']);
const DIR_TRANSACAO = 'ienvia-update-transaction';
const ARQUIVO_LOCK = 'ienvia-update.lock';

export function caminhoEhProtegido(rel) {
  const primeiraParte = String(rel).split('/')[0].toLowerCase();
  return PROTEGIDOS.has(primeiraParte) || primeiraParte.startsWith('.env');
}

function validarDestino(root, rel) {
  if (!rel || rel.includes('\\') || rel.includes('\0') || rel.split('/').some((p) => !p || p === '.' || p === '..' || p.includes(':'))) {
    throw new Error('Caminho inválido no pacote de atualização.');
  }
  const full = path.join(root, ...rel.split('/'));
  const relativo = path.relative(root, full);
  if (!relativo || relativo.startsWith('..' + path.sep) || path.isAbsolute(relativo)) {
    throw new Error('Caminho fora da pasta do motor.');
  }
  let atual = root;
  for (const parte of rel.split('/')) {
    atual = path.join(atual, parte);
    try {
      if (fs.lstatSync(atual).isSymbolicLink()) {
        throw new Error('Link simbólico não permitido na atualização.');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return full;
}

function escritaAtomica(arquivo, conteudo, mode = 0o644) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = path.join(path.dirname(arquivo), `.ienvia-upd-${crypto.randomBytes(10).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      fs.writeFileSync(fd, conteudo);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, arquivo);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

function comLockDeAtualizacao(root, fn) {
  const runtimeDir = path.join(root, '.runtime');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(runtimeDir, ARQUIVO_LOCK);
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid;
    } catch {
      pid = null;
    }
    let ativo = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        ativo = true;
      } catch (e) {
        if (e.code !== 'ESRCH') ativo = true;
      }
    }
    if (ativo) throw new Error('Outra atualização já está em andamento.');
    fs.unlinkSync(lockPath);
    fd = fs.openSync(lockPath, 'wx', 0o600);
  }

  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return fn(runtimeDir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

function reverterSeInterrompida(root, runtimeDir) {
  const stage = path.join(runtimeDir, DIR_TRANSACAO);
  const manifestPath = path.join(stage, 'manifest.json');
  if (!fs.existsSync(stage)) return false;
  if (!fs.existsSync(manifestPath)) {
    fs.rmSync(stage, { recursive: true, force: true });
    return false;
  }
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (m.committed) {
    fs.rmSync(stage, { recursive: true, force: true });
    return false;
  }
  for (let i = m.operations.length - 1; i >= 0; i--) {
    const op = m.operations[i];
    if (!op || typeof op.rel !== 'string' || caminhoEhProtegido(op.rel)) continue;
    const dest = validarDestino(root, op.rel);
    if (op.existed) {
      const bkp = path.join(stage, `backup-${i}`);
      escritaAtomica(dest, fs.readFileSync(bkp), op.mode || 0o644);
      if (process.platform !== 'win32') fs.chmodSync(dest, op.mode || 0o644);
    } else {
      try {
        fs.unlinkSync(dest);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  fs.rmSync(stage, { recursive: true, force: true });
  return true;
}

export function recuperarAtualizacaoInterrompida(rootDir) {
  const root = fs.realpathSync(rootDir);
  return comLockDeAtualizacao(root, (runtimeDir) => reverterSeInterrompida(root, runtimeDir));
}

export function aplicarAtualizacaoAtomica({ rootDir, zipBuffer }) {
  const root = fs.realpathSync(rootDir);
  const extraido = extractZipBuffer(zipBuffer);
  return comLockDeAtualizacao(root, (runtimeDir) => {
    reverterSeInterrompida(root, runtimeDir);
    const stage = path.join(runtimeDir, DIR_TRANSACAO);
    fs.mkdirSync(stage, { mode: 0o700 });

    const arquivosElegiveis = [];
    const vistos = new Set();
    for (const file of extraido.files) {
      const rel = String(file.relPath || '').replace(/^\/+/, '');
      if (!rel || caminhoEhProtegido(rel)) continue;
      const dest = validarDestino(root, rel);
      if (vistos.has(dest)) throw new Error(`Arquivo duplicado no pacote: ${rel}`);
      vistos.add(dest);
      arquivosElegiveis.push({ rel, dest, content: file.buffer });
    }

    const ops = [];
    try {
      for (const item of arquivosElegiveis) {
        let st = null;
        try {
          st = fs.lstatSync(item.dest);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        if (st && (!st.isFile() || st.isSymbolicLink())) {
          throw new Error(`Destino inválido para atualização: ${item.rel}`);
        }
        const op = { rel: item.rel, existed: Boolean(st), mode: st ? st.mode & 0o777 : 0o644 };
        if (st) {
          escritaAtomica(path.join(stage, `backup-${ops.length}`), fs.readFileSync(item.dest), 0o600);
        }
        ops.push(op);
      }

      const manifestPath = path.join(stage, 'manifest.json');
      escritaAtomica(manifestPath, JSON.stringify({ version: 1, operations: ops, committed: false }), 0o600);

      for (let i = 0; i < arquivosElegiveis.length; i++) {
        const item = arquivosElegiveis[i];
        const mode = process.platform !== 'win32' && item.rel.endsWith('.sh') ? 0o755 : ops[i].mode;
        escritaAtomica(item.dest, item.content, mode);
        if (process.platform !== 'win32') fs.chmodSync(item.dest, mode);
      }

      escritaAtomica(manifestPath, JSON.stringify({ version: 1, operations: ops, committed: true }), 0o600);
      fs.rmSync(stage, { recursive: true, force: true });
      return arquivosElegiveis.length;
    } catch (erro) {
      try {
        reverterSeInterrompida(root, runtimeDir);
      } catch (recErro) {
        throw new Error(`Falha na atualização (${erro.message}) e no rollback (${recErro.message})`);
      }
      throw erro;
    }
  });
}

export async function verificarEAtualizar({
  rootDir,
  panelUrl,
  versaoAtual,
  chavePublicaPem = CHAVE_PUBLICA_ATUALIZACAO_MOTOR,
  fetchFn = fetch,
}) {
  const resp = await fetchFn(`${panelUrl}/api/motor/versao`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) {
    return { updated: false, reason: `versao_http_${resp.status}` };
  }
  const envelope = await resp.json();
  const manifesto = verificarManifestoAssinado(envelope, chavePublicaPem);
  if (!ehVersaoMaisNova(versaoAtual, manifesto.version)) {
    return { updated: false, currentVersion: versaoAtual, remoteVersion: manifesto.version };
  }

  const pkgResp = await fetchFn(`${panelUrl}/api/motor/pacote?versao=${encodeURIComponent(manifesto.version)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!pkgResp.ok) {
    throw new Error(`Falha ao baixar pacote v${manifesto.version}: HTTP ${pkgResp.status}`);
  }
  const zipBuffer = Buffer.from(await pkgResp.arrayBuffer());
  const hashReal = sha256Hex(zipBuffer);
  if (hashReal !== manifesto.sha256.toLowerCase()) {
    throw new Error(`Hash SHA-256 do pacote v${manifesto.version} não confere.`);
  }
  const aplicados = aplicarAtualizacaoAtomica({ rootDir, zipBuffer });
  return { updated: true, newVersion: manifesto.version, filesUpdated: aplicados };
}
