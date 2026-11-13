import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function detectarPlataformaMotor() {
  const ehTermux =
    Boolean(process.env.TERMUX_VERSION) ||
    Boolean(process.env.PREFIX && String(process.env.PREFIX).includes('com.termux')) ||
    process.platform === 'android';
  if (ehTermux) return 'android-termux';
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'darwin';
  return 'unknown';
}

export function lerConfiguracao(rootDir) {
  const arquivo = path.join(rootDir, 'data', 'motor.json');
  let salvo = {};
  if (fs.existsSync(arquivo)) {
    try {
      salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    } catch {
      salvo = {};
    }
  }
  const panelUrl = (process.env.IENVIA_PANEL_URL || salvo.panelUrl || '').trim().replace(/\/+$/, '');
  const deviceToken = (process.env.IENVIA_MOTOR_TOKEN || salvo.deviceToken || '').trim();
  const executorId = salvo.executorId || '';
  const workspaceId = salvo.workspaceId || '';
  const displayName = salvo.displayName || os.hostname();
  return { panelUrl, deviceToken, executorId, workspaceId, displayName, arquivo };
}

export function salvarConfiguracao(rootDir, dados) {
  const dir = path.join(rootDir, 'data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const arquivo = path.join(dir, 'motor.json');
  const tmp = path.join(dir, `.motor-${process.pid}.tmp`);
  const conteudo = JSON.stringify(dados, null, 2) + '\n';
  fs.writeFileSync(tmp, conteudo, { mode: 0o600 });
  fs.renameSync(tmp, arquivo);
  if (process.platform !== 'win32') {
    fs.chmodSync(arquivo, 0o600);
  }
  return arquivo;
}

export function normalizarCodigoPareamento(entrada) {
  const bruto = String(entrada || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const corpo = bruto.startsWith('IENV') ? bruto.slice(4) : bruto;
  if (!/^[A-Z0-9]{8}$/.test(corpo)) return null;
  return `IENV-${corpo.slice(0, 4)}-${corpo.slice(4, 8)}`;
}

export function metadataDoAparelho() {
  return {
    hostname: os.hostname(),
    arch: process.arch,
    node: process.version,
    os_release: os.release(),
  };
}
