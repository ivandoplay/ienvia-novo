import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const MAX_TEXTO = 65_536;
const LIMITE_MIDIA_BYTES = 25 * 1024 * 1024;
const logger = pino({ level: process.env.MOTOR_LOG_LEVEL || 'warn' });

export function normalizarJidParaContato(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const limpo = jid.trim();
  if (limpo.endsWith('@g.us') || limpo === 'status@broadcast' || limpo.endsWith('@broadcast')) {
    return null;
  }
  const semDispositivo = limpo.replace(/:\d+(?=@)/, '');
  if (!/^[1-9][0-9]{5,19}@s\.whatsapp\.net$/.test(semDispositivo)) return null;
  return semDispositivo;
}

export function normalizarTimestampMsg(ts) {
  let num = Number(ts);
  if (!Number.isFinite(num) || num <= 0) return new Date().toISOString();
  if (num < 1e11) num *= 1000;
  return new Date(num).toISOString();
}

export function extrairConteudoMensagemBaileys(msg) {
  if (!msg || !msg.message) return null;
  // Mensagens efêmeras ou viewOnce são ignoradas por privacidade e segurança.
  if (msg.message.viewOnceMessage || msg.message.viewOnceMessageV2 || msg.message.viewOnceMessageV2Extension) {
    return null;
  }
  const inner = msg.message.ephemeralMessage?.message || msg.message;
  if (!inner) return null;

  const texto =
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    '';

  const textoSeguro = String(texto).replace(/\0/g, '').slice(0, MAX_TEXTO).trim();

  if (inner.imageMessage) {
    return {
      text: textoSeguro,
      media: {
        kind: 'image',
        mime: inner.imageMessage.mimetype || 'image/jpeg',
        size: Number(inner.imageMessage.fileLength || 0) || undefined,
        width: inner.imageMessage.width || undefined,
        height: inner.imageMessage.height || undefined,
      },
      mediaMessage: msg,
    };
  }
  if (inner.videoMessage) {
    return {
      text: textoSeguro,
      media: {
        kind: 'video',
        mime: inner.videoMessage.mimetype || 'video/mp4',
        size: Number(inner.videoMessage.fileLength || 0) || undefined,
        duration: inner.videoMessage.seconds || undefined,
      },
      mediaMessage: msg,
    };
  }
  if (inner.audioMessage) {
    return {
      text: '',
      media: {
        kind: 'audio',
        mime: inner.audioMessage.mimetype || 'audio/ogg',
        size: Number(inner.audioMessage.fileLength || 0) || undefined,
        duration: inner.audioMessage.seconds || undefined,
        voice: Boolean(inner.audioMessage.ptt),
      },
      mediaMessage: msg,
    };
  }
  if (inner.stickerMessage) {
    return {
      text: '',
      media: {
        kind: 'sticker',
        mime: inner.stickerMessage.mimetype || 'image/webp',
        size: Number(inner.stickerMessage.fileLength || 0) || undefined,
      },
      mediaMessage: msg,
    };
  }
  if (inner.documentMessage) {
    return {
      text: textoSeguro,
      media: {
        kind: 'document',
        mime: inner.documentMessage.mimetype || 'application/octet-stream',
        size: Number(inner.documentMessage.fileLength || 0) || undefined,
        file_name: inner.documentMessage.fileName || 'documento',
      },
      mediaMessage: msg,
    };
  }

  if (!textoSeguro) return null;
  return { text: textoSeguro, media: null, mediaMessage: null };
}

export class SupervisorDeSessoes {
  constructor({ rootDir, panelUrl, deviceToken, fetchFn = fetch, onLog = console.log }) {
    this.rootDir = rootDir;
    this.panelUrl = panelUrl;
    this.deviceToken = deviceToken;
    this.fetchFn = fetchFn;
    this.onLog = onLog;
    this.sessoes = new Map();
    this.encerrando = false;
  }

  headers(extra = {}) {
    return {
      'x-ienvia-motor-token': this.deviceToken,
      ...extra,
    };
  }

  async chamarApi(rota, corpo = null, metodo = 'POST') {
    const resp = await this.fetchFn(`${this.panelUrl}${rota}`, {
      method: metodo,
      headers: this.headers(corpo ? { 'content-type': 'application/json' } : {}),
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(dados.erro || `HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return dados;
  }

  pastaDaSessao(instanceId) {
    return path.join(this.rootDir, 'data', 'wa_auth', instanceId);
  }

  async iniciarConexao(instanceId, { mode = 'qr', phone = null } = {}) {
    await this.pararSessao(instanceId, false);
    const pasta = this.pastaDaSessao(instanceId);
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });

    const { state, saveCreds } = await useMultiFileAuthState(pasta);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    const registro = { sock, status: 'connecting', qrTimer: null, codeRequested: false };
    this.sessoes.set(instanceId, registro);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (this.sessoes.get(instanceId)?.sock !== sock) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr && mode === 'qr') {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
          await this.chamarApi('/api/motor/estado', {
            instance_id: instanceId,
            status: 'connecting',
            pairing_qr: dataUrl,
          });
        } catch (err) {
          this.onLog(`[motor] falha ao enviar QR da instância ${instanceId}: ${err.message}`);
        }
      }

      if (qr && mode === 'code' && phone && !registro.codeRequested && !state.creds.registered) {
        registro.codeRequested = true;
        try {
          const digits = String(phone).replace(/\D/g, '');
          const codigo = await sock.requestPairingCode(digits);
          await this.chamarApi('/api/motor/estado', {
            instance_id: instanceId,
            status: 'connecting',
            pairing_code: String(codigo || '').toUpperCase(),
          });
        } catch (err) {
          this.onLog(`[motor] falha ao gerar código de pareamento ${instanceId}: ${err.message}`);
        }
      }

      if (connection === 'open') {
        registro.status = 'connected';
        const jid = sock.user?.id || '';
        const phoneMatch = /^([1-9]\d{5,19})/.exec(jid);
        const connectedPhone = phoneMatch ? `+${phoneMatch[1]}` : null;
        await this.chamarApi('/api/motor/estado', {
          instance_id: instanceId,
          status: 'connected',
          connected_phone: connectedPhone,
        }).catch(() => undefined);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        registro.status = 'disconnected';
        this.sessoes.delete(instanceId);
        await this.chamarApi('/api/motor/estado', {
          instance_id: instanceId,
          status: 'disconnected',
        }).catch(() => undefined);
        if (!loggedOut && !this.encerrando) {
          setTimeout(() => {
            if (!this.encerrando && fs.existsSync(path.join(pasta, 'creds.json'))) {
              this.iniciarConexao(instanceId, { mode: 'qr' }).catch(() => undefined);
            }
          }, 4000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ type, messages }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages || []) {
        try {
          const jid = normalizarJidParaContato(msg?.key?.remoteJid);
          const msgId = msg?.key?.id;
          if (!jid || !msgId) continue;
          const extraido = extrairConteudoMensagemBaileys(msg);
          if (!extraido) continue;

          const recebido = await this.chamarApi('/api/motor/eventos', {
            instance_id: instanceId,
            event_id: msgId,
            sender_jid: jid,
            push_name: msg.pushName || '',
            body_text: extraido.text,
            occurred_at: normalizarTimestampMsg(msg.messageTimestamp),
            from_me: Boolean(msg.key.fromMe),
            media: extraido.media,
          });

          if (recebido?.message_id && recebido?.media?.status === 'pending' && extraido.mediaMessage) {
            await this.enviarMidiaRecebida(recebido.message_id, extraido.mediaMessage, extraido.media);
          }
        } catch (err) {
          this.onLog(`[motor] erro ao processar mensagem recebida: ${err.message}`);
        }
      }
    });
  }

  async enviarMidiaRecebida(messageId, msg, mediaMeta) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;
    if (buffer.length > LIMITE_MIDIA_BYTES) return;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const url = `${this.panelUrl}/api/motor/midia?message_id=${encodeURIComponent(messageId)}`;
    const resp = await this.fetchFn(url, {
      method: 'POST',
      headers: this.headers({
        'content-type': mediaMeta.mime || 'application/octet-stream',
        'x-media-sha256': sha256,
      }),
      body: buffer,
      signal: AbortSignal.timeout(45_000),
    });
    if (!resp.ok) {
      throw new Error(`Upload de mídia falhou: HTTP ${resp.status}`);
    }
  }

  async pararSessao(instanceId, limparArquivos = false) {
    const atual = this.sessoes.get(instanceId);
    this.sessoes.delete(instanceId);
    if (atual?.sock) {
      try {
        if (limparArquivos) await atual.sock.logout().catch(() => undefined);
        atual.sock.end(undefined);
      } catch {
        // Ignora erro ao encerrar socket antigo.
      }
    }
    if (limparArquivos) {
      fs.rmSync(this.pastaDaSessao(instanceId), { recursive: true, force: true });
    }
  }

  async executarComando(cmd) {
    const concluir = (outcome, extra = {}) =>
      this.chamarApi('/api/motor/comandos', {
        command_id: cmd.id,
        outcome,
        ...extra,
      });

    try {
      if (cmd.command_type === 'connect_qr') {
        await this.iniciarConexao(cmd.instance_id, { mode: 'qr' });
        await concluir('succeeded');
        return;
      }
      if (cmd.command_type === 'connect_code') {
        await this.iniciarConexao(cmd.instance_id, { mode: 'code', phone: cmd.payload?.phone });
        await concluir('succeeded');
        return;
      }
      if (cmd.command_type === 'disconnect') {
        await this.pararSessao(cmd.instance_id, false);
        await this.chamarApi('/api/motor/estado', { instance_id: cmd.instance_id, status: 'disconnected' }).catch(() => undefined);
        await concluir('succeeded');
        return;
      }
      if (cmd.command_type === 'clear_session') {
        await this.pararSessao(cmd.instance_id, true);
        await this.chamarApi('/api/motor/estado', { instance_id: cmd.instance_id, status: 'disconnected' }).catch(() => undefined);
        await concluir('succeeded');
        return;
      }

      const registro = this.sessoes.get(cmd.instance_id);
      if (!registro || registro.status !== 'connected') {
        await concluir('failed', { error_detail: 'Chip local não está conectado neste aparelho.' });
        return;
      }

      if (cmd.command_type === 'send_text') {
        const jid = cmd.payload?.recipient;
        const texto = cmd.payload?.body_text;
        const enviado = await registro.sock.sendMessage(jid, { text: texto });
        const waId = enviado?.key?.id || null;
        await concluir(waId ? 'sent' : 'uncertain', { provider_message_id: waId });
        return;
      }

      if (cmd.command_type === 'send_media') {
        const att = cmd.attachment;
        if (!att || !cmd.message_id) {
          await concluir('failed', { error_detail: 'Dados da mídia ausentes.' });
          return;
        }
        const mediaResp = await this.fetchFn(
          `${this.panelUrl}/api/motor/midia?message_id=${encodeURIComponent(cmd.message_id)}`,
          { headers: this.headers(), signal: AbortSignal.timeout(45_000) },
        );
        if (!mediaResp.ok) {
          await concluir('failed', { error_detail: `Não foi possível baixar mídia do painel: HTTP ${mediaResp.status}` });
          return;
        }
        const buf = Buffer.from(await mediaResp.arrayBuffer());
        const jid = cmd.payload?.recipient;
        const caption = att.caption || undefined;
        let payloadWa;
        if (att.kind === 'image') payloadWa = { image: buf, mimetype: att.content_type, caption };
        else if (att.kind === 'video') payloadWa = { video: buf, mimetype: att.content_type, caption };
        else if (att.kind === 'audio') payloadWa = { audio: buf, mimetype: att.content_type || 'audio/ogg; codecs=opus', ptt: att.is_voice !== false };
        else payloadWa = { document: buf, mimetype: att.content_type, fileName: att.file_name || 'arquivo', caption };

        const enviado = await registro.sock.sendMessage(jid, payloadWa);
        const waId = enviado?.key?.id || null;
        await concluir(waId ? 'sent' : 'uncertain', { provider_message_id: waId });
        return;
      }

      await concluir('failed', { error_detail: `Comando desconhecido: ${cmd.command_type}` });
    } catch (err) {
      // Se falhou durante envio sem confirmação clara do socket, marca como incerto para nunca reenviar.
      const ehEnvio = cmd.command_type === 'send_text' || cmd.command_type === 'send_media';
      await concluir(ehEnvio ? 'uncertain' : 'failed', { error_detail: err.message }).catch(() => undefined);
    }
  }

  async encerrarTudo() {
    this.encerrando = true;
    await Promise.all([...this.sessoes.keys()].map((id) => this.pararSessao(id, false)));
  }
}
