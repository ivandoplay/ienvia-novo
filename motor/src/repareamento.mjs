import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { lerConfiguracao, salvarConfiguracao, normalizarCodigoPareamento } from './config.mjs';

// Remove apenas o vínculo de acesso ao painel. Não toca em wa_auth nem em filas.
export function invalidarAcessoRevogado(rootDir, panelUrl = '', env = process.env) {
  const cfg = lerConfiguracao(rootDir);
  salvarConfiguracao(rootDir, {
    panelUrl: panelUrl || cfg.panelUrl,
    deviceToken: '', executorId: '', workspaceId: '', displayName: cfg.displayName,
  });
  // Um token de ambiente revogado não pode sobrepor o próximo pareamento salvo.
  if (env.IENVIA_MOTOR_TOKEN) delete env.IENVIA_MOTOR_TOKEN;
}

export async function pedirNovoCodigo({ parear, input = stdin, output = stdout, createInterface = readline.createInterface, onLog = console.log }) {
  const rl = createInterface({ input, output });
  const abort = new AbortController();
  const parar = () => abort.abort();
  process.once('SIGINT', parar); process.once('SIGTERM', parar);
  try {
    onLog('[motor] Gere um novo código de aparelho no painel para vincular novamente.');
    while (!abort.signal.aborted) {
      let valor;
      try { valor = await rl.question('Cole o novo código (IENV-XXXX-XXXX): ', { signal: abort.signal }); }
      catch (err) { if (abort.signal.aborted || ['ERR_USE_AFTER_CLOSE','ABORT_ERR'].includes(err.code)) return false; throw err; }
      const codigo = normalizarCodigoPareamento(valor);
      if (!codigo) { onLog('[motor] Código inválido. Confira o código no painel.'); continue; }
      try { await parear(codigo); return !abort.signal.aborted; }
      catch (err) { onLog(`[motor] Não foi possível parear: ${err.message}. Informe um novo código ou use Ctrl+C.`); }
    }
    return false;
  } finally {
    process.off('SIGINT', parar); process.off('SIGTERM', parar); rl.close();
  }
}
