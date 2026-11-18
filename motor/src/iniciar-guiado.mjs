import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { lerConfiguracao, normalizarCodigoPareamento } from './config.mjs';

export function argumentosDeInicio(config, codigo = '') {
  const painel = config.panelUrl || 'https://app.ienvia.online';
  if (!/^https:\/\//i.test(painel)) throw new Error('O painel deve usar HTTPS.');
  if (config.deviceToken) return ['--sem-pagina'];
  const code = normalizarCodigoPareamento(codigo);
  if (!code) throw new Error('Código inválido. Use IENV-XXXX-XXXX.');
  return ['--url', painel, '--pair', code, '--once'];
}

export async function iniciarGuiado() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  function executar(args) {
    return new Promise((resolve, reject) => {
      const filho = spawn(process.execPath, [path.join(root,'src','index.mjs'), ...args], { cwd: root, stdio: 'inherit' });
      filho.once('error', reject);
      filho.once('exit', (code, signal) => resolve(signal ? 130 : (code ?? 1)));
    });
  }
  let cfg = lerConfiguracao(root);
  if (!cfg.deviceToken) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let codigo = '';
    try {
      while (!normalizarCodigoPareamento(codigo)) {
        codigo = (await rl.question('Cole o código do aparelho (IENV-XXXX-XXXX): ')).trim();
        if (!normalizarCodigoPareamento(codigo)) console.log('Código inválido; confira no painel.');
      }
    } finally { rl.close(); }
    const code = await executar(argumentosDeInicio(cfg,codigo));
    if (code !== 0) return code;
    cfg = lerConfiguracao(root);
    if (!cfg.deviceToken) throw new Error('O pareamento não foi salvo. Nenhum dado foi apagado.');
  }
  console.log('[Ienvia] Aparelho vinculado. Use Instâncias no painel para conectar o WhatsApp.');
  console.log('[Ienvia] Mantenha esta janela aberta. Ctrl+C encerra sem apagar sua sessão.');
  let code;
  do { code = await executar(['--sem-pagina']); } while (code === 42);
  return code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  iniciarGuiado().then(code => { process.exitCode = code; }).catch(err => { console.error('[Ienvia]',err.message); process.exitCode = 1; });
}
