import crypto from 'node:crypto';
import { IntencoesDeConexao } from './intencoes.mjs';
import { atrasoReconexao, podeRetomarSessao, ehMensagemHistorica } from './operacao.mjs';
import { PresencaDeResposta } from './presenca.mjs';
import { BufferJSON } from '@whiskeysockets/baileys';
import { abrirFila } from './fila-historico.mjs';
import { resolverDestinatario } from './destinatario.mjs';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const MAX_TEXTO = 65_536;
const LIMITE_MIDIA_BYTES = 25 * 1024 * 1024;
const logger = pino({ level: 'silent' });

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
    this.geracoes = new Map();
    this.intencoes = new IntencoesDeConexao(rootDir);
    this.estados = new Map();
    this.nomes = new Map();
    this.historicoRecebido = 0;
    this.ultimoHistorico = 0;
    this.enviosAtivos = 0;
    this.retornosFila = new Map();
    this.nomesContatos = new Map();
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
    this.presencaDeResposta = new PresencaDeResposta({ rootDir, onLog });
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

  async iniciarConexao(instanceId, { mode = 'qr', phone = null, onReady = () => {}, onFailure = () => {}, tentativa = 0, recuperarSessao = false, sessaoRecuperada = false } = {}) {
    const geracao = (this.geracoes.get(instanceId) || 0) + 1;
    this.geracoes.set(instanceId, geracao);
    await this.pararSessao(instanceId, false, true);
    const inicioConexao = Date.now();
    this.estados.set(instanceId, { estado: 'connecting', desde: this.estados.get(instanceId)?.desde });
    const pasta = this.pastaDaSessao(instanceId);
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });

    const { state, saveCreds } = await this.authFactory(pasta);
    let version;
    try {
      ({ version } = await this.versionFactory());
    } catch {
      version = undefined;
    }

    if (this.encerrando || this.geracoes.get(instanceId) !== geracao) return;
    const sock = this.socketFactory({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: true,
      browser: Browsers.macOS('Desktop'),
      shouldSyncHistoryMessage: () => true,
    });

    const registro = { sock, status: 'connecting', qrTimer: null, codeRequested: false, estabelecida: false };
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
          this.estados.set(instanceId, { estado: 'pairing' });
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
          this.estados.set(instanceId, { estado: 'pairing' });
          onReady('code');
        } catch (err) {
          this.onLog(`[motor] falha ao gerar código de pareamento ${instanceId}: ${err.message}`);
          onFailure(new Error('Falha ao solicitar código de pareamento ao WhatsApp.'));
        }
      }

      if (connection === 'open') {
        registro.status = 'connected';
        registro.estabelecida = true;
        try { this.intencoes.definir(instanceId, true); } catch { this.onLog('[motor] Nao foi possivel salvar a retomada automatica.'); }
        tentativa = 0;
        this.estados.set(instanceId, { estado: 'connected' });
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
        const estavaConectado = registro.status === 'connected';
        registro.status = 'disconnected';
        this.sessoes.delete(instanceId);
        if ([401,403,411,440,500].includes(statusCode)) {
          try { this.intencoes.definir(instanceId, false); } catch {}
        }
        const retomar = podeRetomarSessao(statusCode, registro.estabelecida || state.creds?.registered === true);
        const vaiRecuperar = !this.encerrando && (retomar || (!estavaConectado &&
          ((!loggedOut && tentativa < 2 && ![403,411,440,500].includes(statusCode)) || (loggedOut && recuperarSessao && !sessaoRecuperada))));
        this.estados.set(instanceId, { estado: vaiRecuperar ? 'reconnecting' : 'disconnected', desde: this.estados.get(instanceId)?.desde || Date.now(), proxima: vaiRecuperar ? Date.now() + atrasoReconexao(tentativa) : null });
        await this.chamarApi('/api/motor/estado', {
          instance_id: instanceId,
          status: vaiRecuperar ? 'connecting' : 'disconnected',
        }).catch(() => undefined);
        this.onLog(`[motor] conexão encerrada ${instanceId}; status=${statusCode ?? 'desconhecido'}; modo=${mode}; tentativa=${tentativa}`);
        // Reinício de handshake (515) não depende de creds.json já ter sido escrito.
        // Não trocar código por QR e não deixar timer velho ressuscitar sessão limpa.
        if (this.sessoes.has(instanceId)) return;
        // Pedido explícito de pareamento: uma credencial recusada não pode bloquear
        // todas as tentativas futuras. Preservar os arquivos e recuperar só uma vez.
        if (loggedOut && recuperarSessao && !sessaoRecuperada && !estavaConectado && !this.encerrando) {
          try {
            const arquivo = path.join(this.rootDir, 'data', 'wa_auth_recusadas', instanceId + '-' + crypto.randomUUID());
            fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 });
            fs.renameSync(pasta, arquivo);
            await this.iniciarConexao(instanceId, { mode, phone, onReady, onFailure,
              tentativa: 0, recuperarSessao, sessaoRecuperada: true });
          } catch {
            onFailure(new Error('Sessão recusada (401); não foi possível preparar novo pareamento.'));
          }
          return;
        }
        if (!this.encerrando && (retomar || (!loggedOut && tentativa < 2 && ![403,411,440,500].includes(statusCode)))) {
          this.agendarReconexao(instanceId, { mode, phone, onReady, onFailure, tentativa: tentativa + 1, recuperarSessao, sessaoRecuperada }, atrasoReconexao(tentativa));
        } else {
          onFailure(new Error(`WhatsApp encerrou a conexão (status ${statusCode ?? 'desconhecido'}).`));
        }
      }
    });

    sock.ev.on('messaging-history.set', ({ messages, contacts, chats }) => {
      this.historicoRecebido += (messages || []).length;
      this.ultimoHistorico = Date.now();
      for (const c of [...(contacts || []), ...(chats || [])]) {
        const nome = c.notify || c.name || c.verifiedName;
        if (this.nomesContatos.size >= 50000) this.nomesContatos.delete(this.nomesContatos.keys().next().value);
        if (c.id && nome) this.nomesContatos.set(instanceId + ':' + c.id, String(nome).slice(0,150));
      }
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
        try { this.filaHistorico.guardar(instanceId + ':' + msg.key.id, { instanceId, historical: ehMensagemHistorica(type, msg, inicioConexao), msg: JSON.stringify(msg, BufferJSON.replacer) }); }
        catch (err) { this.onLog(`[motor] Entrada não salva: ${err.message}`); }
        if (type === 'notify' && !ehMensagemHistorica(type, msg, inicioConexao)) {
          try { this.presencaDeResposta.receber(instanceId, msg); }
          catch (err) { this.onLog(`[motor] Chave de leitura não salva: ${err.message}`); }
        }
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
        if ((this.retornosFila.get(item.nome)?.proxima || 0) > Date.now()) continue;
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
          const r = await this.chamarApi('/api/motor/eventos', { historical: item.valor.historical === true, instance_id: instanceId, event_id: msg.key.id, sender_jid: jid, push_name: msg.pushName || this.nomesContatos.get(instanceId + ':' + msg.key?.remoteJid) || this.nomesContatos.get(instanceId + ':' + jid) || '', body_text: x.text, occurred_at: normalizarTimestampMsg(msg.messageTimestamp), from_me: Boolean(msg.key.fromMe), media: x.media });
          if (['accepted','duplicate'].includes(r.result) && r.message_id && ['pending','failed'].includes(r.media?.status) && x.mediaMessage) {
            await this.enviarMidiaRecebida(r.message_id, x.mediaMessage, x.media);
          }
          if (['accepted','duplicate','ignored'].includes(r.result)) { this.filaHistorico.confirmar(item.nome); this.retornosFila.delete(item.nome); }
        } catch (err) {
          const tentativas = (this.retornosFila.get(item.nome)?.tentativas || 0) + 1;
          this.retornosFila.set(item.nome, { tentativas, proxima: Date.now() + atrasoReconexao(tentativas) });
          this.onLog('[motor] Mensagem preservada. Nova tentativa automatica.');
        }
      }
    } finally { this.escoandoHistorico.delete(tipo); }
  }

  async enviarMidiaRecebida(messageId, msg, mediaMeta) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Midia indisponivel; nova tentativa posterior.');
    if (buffer.length > LIMITE_MIDIA_BYTES) throw new Error('Midia acima do limite de 25 MB.');
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

  agendarReconexao(instanceId, opcoes, atraso) {
    clearTimeout(this.reconexoes.get(instanceId));
    const geracao = this.geracoes.get(instanceId);
    this.estados.set(instanceId, { estado: 'reconnecting', desde: this.estados.get(instanceId)?.desde || Date.now(), proxima: Date.now() + atraso });
    const timer = setTimeout(() => {
      this.reconexoes.delete(instanceId);
      if (this.encerrando || this.sessoes.has(instanceId) || this.geracoes.get(instanceId) !== geracao) return;
      this.iniciarConexao(instanceId, opcoes).catch(() => {
        if (!this.encerrando && !this.sessoes.has(instanceId) && this.geracoes.get(instanceId) === geracao + 1)
          this.agendarReconexao(instanceId, { ...opcoes, tentativa: opcoes.tentativa + 1 }, atrasoReconexao(opcoes.tentativa));
      });
    }, atraso);
    this.reconexoes.set(instanceId, timer);
  }

  async pararSessao(instanceId, limparArquivos = false, preservarGeracao = false) {
    if (!preservarGeracao) {
      this.geracoes.set(instanceId, (this.geracoes.get(instanceId) || 0) + 1);
      this.estados.set(instanceId, { estado: 'disconnected' });
    }
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
    const ehComandoDeEnvio = ['send_text','send_media'].includes(cmd.command_type);
    if (ehComandoDeEnvio) this.enviosAtivos++;
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
              recuperarSessao: true,
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
        this.intencoes.definir(cmd.instance_id, false);
        await this.pararSessao(cmd.instance_id, false);
        await this.chamarApi('/api/motor/estado', { instance_id: cmd.instance_id, status: 'disconnected' }).catch(() => undefined);
        await concluir('succeeded');
        return;
      }
      if (cmd.command_type === 'clear_session') {
        this.intencoes.definir(cmd.instance_id, false);
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
        const enviar = async () => {
          envioIniciado = true;
          return registro.sock.sendMessage(jid, { text: texto });
        };
        const enviado = cmd.payload?.admin_alert_delivery_id ? await enviar() : await this.presencaDeResposta.enviar({
          instanceId: cmd.instance_id, sock: registro.sock, jid, tipo: 'text', texto, enviar,
        });
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

        const enviado = await this.presencaDeResposta.enviar({
          instanceId: cmd.instance_id, sock: registro.sock, jid,
          tipo: att.kind === 'audio' && att.is_voice !== false ? 'audio' : 'media',
          enviar: async () => { envioIniciado = true; return registro.sock.sendMessage(jid, payloadWa); },
        });
        const waId = enviado?.key?.id || null;
        await concluir(waId ? 'sent' : 'uncertain', { provider_message_id: waId });
        return;
      }

      await concluir('failed', { error_detail: `Comando desconhecido: ${cmd.command_type}` });
    } catch (err) {
      // Se falhou durante envio sem confirmação clara do socket, marca como incerto para nunca reenviar.
      const ehEnvio = cmd.command_type === 'send_text' || cmd.command_type === 'send_media';
      await concluir(ehEnvio && envioIniciado ? 'uncertain' : 'failed', { error_detail: err.message }).catch(() => undefined);
    } finally {
      if (ehComandoDeEnvio) this.enviosAtivos--;
    }
  }

  async encerrarTudo() {
    this.encerrando = true;
    for (const timer of this.reconexoes.values()) clearTimeout(timer);
    this.reconexoes.clear();
    await Promise.all([...this.sessoes.keys()].map((id) => this.pararSessao(id, false)));
  }
}
