import crypto from 'node:crypto';
import { BufferJSON } from '@whiskeysockets/baileys';
import { abrirFila } from './fila-historico.mjs';
import { resolverDestinatario } from './destinatario.mjs';
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

export function ondaDoCabecalho(valor) {
  if (typeof valor !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(valor)) return undefined;
  const bytes = Buffer.from(valor, 'base64');
  return bytes.length === 64 && bytes.every(n => n <= 100) ? bytes : undefined;
}

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
  constructor({ rootDir, panelUrl, deviceToken, fetchFn = fetch, onLog = console.log, socketFactory = makeWASocket, authFactory = useMultiFileAuthState, versionFactory = fetchLatestBaileysVersion }) {
    this.socketFactory = socketFactory; this.authFactory = authFactory; this.versionFactory = versionFactory;
    this.reconexoes = new Map();
    this.rootDir = rootDir;
    this.panelUrl = panelUrl;
    this.deviceToken = deviceToken;
    this.fetchFn = fetchFn;
    this.onLog = onLog;
    this.sessoes = new Map();
    this.encerrando = false;
    this.filaHistorico = abrirFila(path.join(rootDir,'data','fila-historico'));
    this.escoandoHistorico = new Set();
    this.filaRecibos = abrirFila(path.join(rootDir,'data','fila-recibos'));
    this.proximoRecibo = 0;
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

  async iniciarConexao(instanceId, { mode = 'qr', phone = null, onReady = () => {}, onFailure = () => {}, tentativa = 0 } = {}) {
    await this.pararSessao(instanceId, false);
    const pasta = this.pastaDaSessao(instanceId);
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });

    const { state, saveCreds } = await this.authFactory(pasta);
    let version;
    try {
      ({ version } = await this.versionFactory());
    } catch {
      version = undefined;
    }

    const sock = this.socketFactory({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: true,
    });

    const registro = { sock, status: 'connecting', qrTimer: null, codeRequested: false };
    this.sessoes.set(instanceId, registro);

    sock.ev.on('creds.update', saveCreds);
    this.registrarRecibos(sock, instanceId);

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
          onReady('qr');
        } catch (err) {
          this.onLog(`[motor] falha ao enviar QR da instância ${instanceId}: ${err.message}`);
          onFailure(new Error('Não foi possível disponibilizar o QR no painel.'));
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
          if (!codigo) throw new Error('WhatsApp retornou código vazio.');
          onReady('code');
        } catch (err) {
          this.onLog(`[motor] falha ao gerar código de pareamento ${instanceId}: ${err.message}`);
          onFailure(new Error('Falha ao solicitar código de pareamento ao WhatsApp.'));
        }
      }

      if (connection === 'open') {
        registro.status = 'connected';
        onReady('connected');
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
        this.onLog(`[motor] conexão encerrada ${instanceId}; status=${statusCode ?? 'desconhecido'}; modo=${mode}; tentativa=${tentativa}`);
        // Reinício de handshake (515) não depende de creds.json já ter sido escrito.
        // Não trocar código por QR e não deixar timer velho ressuscitar sessão limpa.
        if (this.sessoes.has(instanceId)) return;
        if (!loggedOut && !this.encerrando && tentativa < 2) {
          const timer = setTimeout(() => {
            this.reconexoes.delete(instanceId);
            if (!this.encerrando && !this.sessoes.has(instanceId)) {
              this.iniciarConexao(instanceId, { mode, phone, onReady, onFailure, tentativa: tentativa + 1 })
                .catch(onFailure);
            }
          }, 4000);
          this.reconexoes.set(instanceId, timer);
        } else {
          onFailure(new Error(`WhatsApp encerrou a conexão (status ${statusCode ?? 'desconhecido'}).`));
        }
      }
    });

    sock.ev.on('messaging-history.set', ({ messages }) => {
      for (const msg of messages || []) {
        if (!msg.key?.id) continue;
        try { this.filaHistorico.guardar(instanceId + ':' + msg.key.id, { instanceId, historical: true, msg: JSON.stringify(msg, BufferJSON.replacer) }); }
        catch (err) { this.onLog(`[motor] Histórico não salvo: ${err.message}`); }
      }
      this.onLog(`[motor] Histórico enfileirado: ${(messages || []).length} mensagens.`);
    });
    sock.ev.on('messages.upsert', ({ type, messages }) => {
      if (!['notify','append'].includes(type)) return;
      for (const msg of messages || []) {
        if (!msg.key?.id) continue;
        try { this.filaHistorico.guardar(instanceId + ':' + msg.key.id, { instanceId, historical: false, msg: JSON.stringify(msg, BufferJSON.replacer) }); }
        catch (err) { this.onLog(`[motor] Entrada não salva: ${err.message}`); }
      }
    });
  }

  registrarRecibos(sock, instanceId) {
    const guardar=(key,status)=>{
      if(key?.fromMe!==true||!key.id||![0,3,4,5].includes(status))return;
      try{this.filaRecibos.guardar(`${instanceId}:${key.id}:${status}`,{historical:false,instanceId,receipt:{id:key.id,status},queuedAt:Date.now()});}
      catch(err){this.onLog(`[motor] Falha ao preservar confirmação: ${err.message}`);}
    };
    sock.ev.on('messages.update',updates=>{for(const {key,update} of updates||[])guardar(key,update?.status);});
    sock.ev.on('message-receipt.update',updates=>{for(const {key,receipt} of updates||[]){
      const status=receipt?.playedTimestamp?5:receipt?.readTimestamp?4:receipt?.receiptTimestamp?3:null;
      if(status!==null)guardar(key,status);
    }});
  }

  async escoarRecibos() {
    if(this.encerrando||this.proximoRecibo>Date.now())return;
    this.proximoRecibo=Date.now()+5000;
    const itens=this.filaRecibos.listar(20,'live');
    const grupos=new Map();
    for(const item of itens){
      if(Date.now()-item.valor.queuedAt>86400000){this.filaRecibos.confirmar(item.nome);continue;}
      const id=item.valor.instanceId;if(!grupos.has(id))grupos.set(id,[]);grupos.get(id).push(item);
    }
    for(const [instanceId,lote] of grupos){
      const result=await this.chamarApi('/api/motor/recibos',{instance_id:instanceId,receipts:lote.map(i=>i.valor.receipt)});
      if(result.result!=='ok'||!Array.isArray(result.confirmed))continue;
      const confirmed=new Set(result.confirmed);
      for(const item of lote)if(confirmed.has(item.valor.receipt.id))this.filaRecibos.confirmar(item.nome);
    }
  }

  async escoarHistorico({ tipo = 'all' } = {}) {
    if (tipo === 'receipts') return this.escoarRecibos();
    if (this.encerrando || this.escoandoHistorico.has(tipo) || this.escoandoHistorico.has('all') || (tipo === 'all' && this.escoandoHistorico.size)) return;
    this.escoandoHistorico.add(tipo);
    try {
      for (const item of this.filaHistorico.listar(tipo === 'history' ? 2 : 10, tipo)) {
        if (this.encerrando) break;
        const { instanceId } = item.valor;
        const msg = JSON.parse(item.valor.msg, BufferJSON.reviver);
        const sock = this.sessoes.get(instanceId)?.sock;
        if (!sock) continue;
        try {
          let jid = normalizarJidParaContato(msg.key?.remoteJid) || normalizarJidParaContato(msg.key?.remoteJidAlt);
          if (!jid && msg.key?.remoteJid?.endsWith('@lid')) jid = normalizarJidParaContato(await sock.signalRepository?.lidMapping?.getPNForLID(msg.key.remoteJid));
          if (!jid) {
            if (!msg.key?.remoteJid?.endsWith('@lid')) this.filaHistorico.confirmar(item.nome);
            continue;
          }
          const x = extrairConteudoMensagemBaileys(msg);
          if (!x) { this.filaHistorico.confirmar(item.nome); continue; }
          const r = await this.chamarApi('/api/motor/eventos', { historical: item.valor.historical === true, instance_id: instanceId, event_id: msg.key.id, sender_jid: jid, push_name: msg.pushName || '', body_text: x.text, occurred_at: normalizarTimestampMsg(msg.messageTimestamp), from_me: Boolean(msg.key.fromMe), media: x.media });
          if (r.result === 'accepted' && r.message_id && r.media?.status === 'pending' && x.mediaMessage) {
            await this.enviarMidiaRecebida(r.message_id, x.mediaMessage, x.media);
          }
          if (['accepted','duplicate','ignored'].includes(r.result)) this.filaHistorico.confirmar(item.nome);
        } catch (err) { this.onLog(`[motor] Histórico preservado para nova tentativa: ${err.message}`); }
      }
    } finally { this.escoandoHistorico.delete(tipo); }
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
    clearTimeout(this.reconexoes.get(instanceId));
    this.reconexoes.delete(instanceId);
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
    let envioIniciado = false;
    const concluir = (outcome, extra = {}) =>
      this.chamarApi('/api/motor/comandos', {
        command_id: cmd.id,
        outcome,
        ...extra,
      });

    try {
      if (['connect_qr','connect_code'].includes(cmd.command_type)) {
        let timeout;
        try {
          await new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Tempo esgotado: WhatsApp não disponibilizou QR/código em 45 segundos.')), 45_000);
            this.iniciarConexao(cmd.instance_id, {
              mode: cmd.command_type === 'connect_code' ? 'code' : 'qr',
              phone: cmd.payload?.phone,
              onReady: resolve,
              onFailure: reject,
            }).catch(reject);
          });
          await concluir('succeeded');
        } catch (err) {
          await this.pararSessao(cmd.instance_id, false);
          await this.chamarApi('/api/motor/estado', { instance_id: cmd.instance_id, status: 'disconnected' }).catch(() => undefined);
          await concluir('failed', { error_detail: String(err.message).slice(0, 500) });
        } finally { clearTimeout(timeout); }
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
        const jid = await resolverDestinatario(registro.sock, cmd.payload?.recipient);
        const texto = cmd.payload?.body_text;
        envioIniciado = true;
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
        const jid = await resolverDestinatario(registro.sock, cmd.payload?.recipient);
        const caption = att.caption || undefined;
        let payloadWa;
        if (att.kind === 'image') payloadWa = { image: buf, mimetype: att.content_type, caption };
        else if (att.kind === 'video') payloadWa = { video: buf, mimetype: att.content_type, caption };
        else if (att.kind === 'audio') {
          const waveform = ondaDoCabecalho(mediaResp.headers.get('x-ienvia-audio-waveform'));
          payloadWa = { audio: buf, mimetype: att.content_type || 'audio/ogg; codecs=opus', ptt: att.is_voice !== false,
            ...(waveform ? { waveform } : {}),
            ...(Number.isFinite(att.duration_seconds) && att.duration_seconds > 0 ? { seconds: Math.round(att.duration_seconds) } : {}),
          };
        }
        else payloadWa = { document: buf, mimetype: att.content_type, fileName: att.file_name || 'arquivo', caption };

        envioIniciado = true;
        const enviado = await registro.sock.sendMessage(jid, payloadWa);
        const waId = enviado?.key?.id || null;
        await concluir(waId ? 'sent' : 'uncertain', { provider_message_id: waId });
        return;
      }

      await concluir('failed', { error_detail: `Comando desconhecido: ${cmd.command_type}` });
    } catch (err) {
      // Se falhou durante envio sem confirmação clara do socket, marca como incerto para nunca reenviar.
      const ehEnvio = cmd.command_type === 'send_text' || cmd.command_type === 'send_media';
      await concluir(ehEnvio && envioIniciado ? 'uncertain' : 'failed', { error_detail: err.message }).catch(() => undefined);
    }
  }

  async encerrarTudo() {
    this.encerrando = true;
    await Promise.all([...this.sessoes.keys()].map((id) => this.pararSessao(id, false)));
  }
}
