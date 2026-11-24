import path from 'node:path';
import { abrirFila } from './fila-historico.mjs';
import { nucleoTelefone } from './destinatario.mjs';

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
async function breve(acao) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(acao), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout de presença/leitura')), 3000); })]); }
  finally { clearTimeout(timer); }
}
// Confirmação de leitura usa as chaves reais recebidas, nunca um ID fabricado.
export class PresencaDeResposta {
  constructor({ rootDir, wait = esperar, onLog = () => {} }) {
    this.fila = abrirFila(path.join(rootDir, 'data', 'leituras-pendentes'));
    this.wait = wait; this.onLog = onLog;
  }
  receber(instanceId, msg) {
    const key = msg?.key;
    if (!key?.id || key.fromMe || !key.remoteJid || key.remoteJid.endsWith('@g.us') || key.remoteJid === 'status@broadcast') return;
    this.fila.guardar(`${instanceId}:${key.remoteJid}:${key.id}`, { historical: false, instanceId, key, receivedAt: Date.now() });
  }
  selecionar(instanceId, jid) {
    const itens = this.fila.listar(this.fila.contagem().live, 'live');
    return itens.filter(item => {
      const v = item.valor;
      if (Date.now() - v.receivedAt > 7 * 86400000) { this.fila.confirmar(item.nome); return false; }
      return v.instanceId === instanceId && [v.key.remoteJid, v.key.remoteJidAlt].some(peer =>
        typeof peer === 'string' && peer.endsWith('@s.whatsapp.net') && nucleoTelefone(peer) === nucleoTelefone(jid));
    });
  }
  async enviar({ instanceId, sock, jid, tipo, texto = '', enviar }) {
    // Snapshot antes do envio: novas mensagens durante a resposta não são marcadas como lidas.
    const lote = this.selecionar(instanceId, jid);
    const estado = tipo === 'audio' ? 'recording' : tipo === 'text' ? 'composing' : null;
    let iniciouPresenca = false;
    try {
      if (estado && typeof sock.sendPresenceUpdate === 'function') {
        try {
          await breve(() => sock.sendPresenceUpdate(estado, jid));
          iniciouPresenca = true;
          const ms = estado === 'recording' ? 2400 : Math.min(4000, Math.max(1200, String(texto).length * 22));
          await this.wait(ms);
        } catch (err) { this.onLog(`[motor] Indicador indisponível: ${err.message}`); }
      }
      const resultado = await enviar();
      if (resultado?.key?.id && lote.length && typeof sock.readMessages === 'function') {
        try {
          // Um erro no visto nunca transforma um envio confirmado em falha/reenvio.
          await breve(() => sock.readMessages(lote.map(item => item.valor.key)));
          for (const item of lote) this.fila.confirmar(item.nome);
        } catch (err) { this.onLog(`[motor] Leitura pendente: ${err.message}`); }
      }
      return resultado;
    } finally {
      if (iniciouPresenca) {
        try { await breve(() => sock.sendPresenceUpdate('paused', jid)); }
        catch (err) { this.onLog(`[motor] Não foi possível limpar indicador: ${err.message}`); }
      }
    }
  }
}
