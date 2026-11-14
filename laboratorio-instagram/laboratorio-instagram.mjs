/**
 * Laboratório do Instagram — v2, com login OAuth completo.
 *
 * O que faz:
 *   GET  /                 → painel: token, eventos recebidos, botão "Conectar Instagram"
 *   GET  /oauth/iniciar    → redireciona para o login oficial do Instagram
 *   GET  /oauth/callback   → recebe o `code`, troca por token, salva no .env
 *   GET  /webhook          → responde o desafio da Meta (hub.challenge)
 *   POST /webhook          → recebe DMs, story replies e comentários
 *   POST /enviar           → manda uma DM pela API oficial
 *   GET  /renovar          → troca o token por outro de 60 dias
 *   GET  /saude, /eventos  → inspeção em JSON
 *
 * Roda com: node laboratorio-instagram.mjs
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// ---------- configuração (lê /home/user/.env) ----------
function lerEnv(caminho = '/home/user/.env') {
  try {
    const texto = readFileSync(caminho, 'utf8');
    for (const linha of texto.split('\n')) {
      const m = linha.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const valor = m[2].trim().replace(/^["']|["']$/g, '');
      if (valor && !process.env[m[1]]) process.env[m[1]] = valor;
    }
  } catch { /* segue com o que já estiver no ambiente */ }
}
lerEnv();

const PORTA = Number(process.env.PORTA ?? 3000);
const VERSAO_DA_API = process.env.VERSAO_DA_API ?? 'v23.0';
const APP_ID = process.env.META_APP_ID ?? '';
const APP_SECRET = process.env.META_APP_SECRET ?? '';
const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN ?? '';
const PERMISSOES = process.env.IG_PERMISSOES
  ?? 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';

/** Preenchidos no OAuth (ou vindos do .env). */
const credenciais = {
  token: process.env.IG_TOKEN ?? '',
  igUserId: process.env.IG_USER_ID ?? '',
  obtidoEm: process.env.IG_TOKEN ? 'carregado do .env' : '',
  expiraEm: '',
};

/** Salva token e IGSID no /home/user/.env, preservando o resto do arquivo. */
function salvarNoEnv(pares) {
  const caminho = '/home/user/.env';
  let texto = '';
  try { texto = readFileSync(caminho, 'utf8'); } catch { return; }
  for (const [chave, valor] of Object.entries(pares)) {
    const linha = `${chave}=${valor}`;
    const regex = new RegExp(`^${chave}=.*$`, 'm');
    texto = regex.test(texto) ? texto.replace(regex, linha) : `${texto.trimEnd()}\n${linha}\n`;
  }
  writeFileSync(caminho, texto, { mode: 0o600 });
}

const evento = {
  iniciadoEm: new Date().toISOString(),
  ultimoDesafio: null,
  ultimaAssinatura: null,
  mensagens: [],
  envios: [],
  erros: [],
  oauth: [],
};

const agora = () => new Date().toISOString().slice(11, 19);
const log = (...p) => console.log(`[${agora()}]`, ...p);

/** O endereço público que a Meta vai chamar: vem do proxy do ambiente ou da variável. */
function basePublica(req) {
  const fixo = process.env.URL_PUBLICA;
  if (fixo) return fixo.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? `127.0.0.1:${PORTA}`;
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  return `${proto}://${host}`;
}

function assinaturaConfere(corpoCru, cabecalho) {
  if (!APP_SECRET) return { valido: null, motivo: 'META_APP_SECRET não configurado' };
  if (!cabecalho) return { valido: false, motivo: 'sem cabeçalho X-Hub-Signature-256' };
  const esperado = `sha256=${createHmac('sha256', APP_SECRET).update(corpoCru).digest('hex')}`;
  const a = Buffer.from(esperado);
  const b = Buffer.from(cabecalho);
  if (a.length !== b.length) return { valido: false, motivo: 'assinatura de tamanho diferente' };
  return { valido: timingSafeEqual(a, b), motivo: '' };
}

async function lerCorpo(req) {
  const partes = [];
  for await (const parte of req) partes.push(parte);
  return Buffer.concat(partes);
}

function registrarEvento(corpo) {
  for (const entrada of Array.isArray(corpo?.entry) ? corpo.entry : []) {
    for (const m of entrada.messaging ?? []) {
      const msg = m.message ?? {};
      const item = {
        tipo: 'mensagem',
        quando: new Date(Number(m.timestamp) || Date.now()).toISOString(),
        de: m.sender?.id ?? '',
        igsidDoNegocio: m.recipient?.id ?? '',
        texto: msg.text ?? (msg.attachments ? `[anexo: ${msg.attachments.map((a) => a.type).join(', ')}]` : ''),
        idDaMensagem: msg.mid ?? '',
        respondendoStory: Boolean(msg.reply_to?.story),
        eco: Boolean(msg.is_echo),
      };
      evento.mensagens.push(item);
      log(`✉️  DM de ${item.de}: ${JSON.stringify(item.texto).slice(0, 120)}${item.respondendoStory ? ' (story reply)' : ''}`);
    }
    for (const c of entrada.changes ?? []) {
      if (c.field !== 'comments') continue;
      const v = c.value ?? {};
      evento.mensagens.push({
        tipo: 'comentario',
        quando: new Date(Number(v.created_time) * 1000 || Date.now()).toISOString(),
        de: v.from?.id ?? '',
        usuario: v.from?.username ?? '',
        texto: v.text ?? '',
        idDoComentario: v.id ?? '',
      });
      log(`💬 COMENTÁRIO de @${v.from?.username}: ${JSON.stringify(v.text ?? '').slice(0, 120)}`);
    }
  }
}

// ---------- troca de code por token (login unificado) ----------
async function trocarCodigoPorToken(code, redirectUri) {
  const corpo = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const resposta = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: corpo,
  });
  return { status: resposta.status, json: await resposta.json().catch(() => ({})) };
}

async function trocarPorTokenLongo(tokenCurto) {
  const url = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(APP_SECRET)}&access_token=${encodeURIComponent(tokenCurto)}`;
  const resposta = await fetch(url);
  return { status: resposta.status, json: await resposta.json().catch(() => ({})) };
}

// ---------- HTML ----------
const estilo = `
 :root{color-scheme:dark}
 body{margin:0;background:#0b0d10;color:#e8eaed;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
 header{padding:16px 22px;border-bottom:1px solid #1e232b;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
 h1{font-size:16px;margin:0}
 .selo{font-size:12px;padding:3px 8px;border-radius:999px;background:#12241b;color:#4ade80;border:1px solid #1e5238}
 .selo.ruim{background:#2a1414;color:#f87171;border-color:#5b2222}
 main{max-width:920px;margin:0 auto;padding:20px}
 section{border:1px solid #1e232b;border-radius:12px;padding:16px;margin:0 0 16px;background:#0f1216}
 h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#93a1b3;margin:0 0 12px}
 code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 pre{background:#080a0d;border:1px solid #1a1f26;border-radius:8px;padding:10px;overflow:auto;font-size:12.5px;max-height:300px}
 .item{padding:9px 0;border-bottom:1px dashed #1a1f26;font-size:13.5px}
 .item:last-child{border-bottom:0}
 .meta{color:#93a1b3;font-size:12px}
 form{display:flex;gap:8px;flex-wrap:wrap}
 input[type=text]{flex:1;min-width:200px;background:#080a0d;border:1px solid #232a33;color:#e8eaed;border-radius:8px;padding:10px}
 button,.botao{background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
 .ok{color:#4ade80}.ruim{color:#f87171}
 .aviso{background:#1c1508;border:1px solid #5a4410;color:#fbbf24;border-radius:8px;padding:10px;font-size:13px}
`;

function pagina(conteudo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Laboratório Instagram · Ienvia</title>
<style>${estilo}</style></head><body>${conteudo}</body></html>`;
}

function painel(req) {
  const base = basePublica(req);
  const conectado = Boolean(credenciais.token);
  const lista = evento.mensagens.length === 0
    ? '<p class="meta">Nada ainda. Mande uma DM para a sua conta de outro perfil (ou responda um story) e atualize esta página.</p>'
    : evento.mensagens.slice().reverse().map((m) => `<div class="item"><strong>${m.tipo === 'comentario' ? '💬 comentário' : '✉️ DM'}</strong>
        <span class="meta">${m.quando}</span><br>de: <code>${m.de}</code>${m.usuario ? ` (@${m.usuario})` : ''}${m.respondendoStory ? ' · <em>resposta de story</em>' : ''}<br>
        ${m.texto ? `texto: ${JSON.stringify(m.texto)}` : '<span class="meta">sem texto (anexo)</span>'}<br>
        <span class="meta">mid: <code>${m.idDaMensagem ?? m.idDoComentario ?? ''}</code></span></div>`).join('');

  return pagina(`
<header><h1>Laboratório Instagram · Ienvia</h1>
<span class="selo ${conectado ? '' : 'ruim'}">${conectado ? 'conectado' : 'não conectado'}</span>
<span class="selo ${APP_SECRET ? '' : 'ruim'}">${APP_SECRET ? 'app secret ok' : 'sem app secret'}</span>
<span class="meta">app ${APP_ID || '—'}</span></header>
<main>
<section><h2>Conexão</h2>
${conectado
    ? `<p class="ok">Token ativo.</p><p class="meta">IGSID: <code>${credenciais.igUserId}</code> · obtido: ${credenciais.obtidoEm}${credenciais.expiraEm ? ` · expira: ${credenciais.expiraEm}` : ''}</p>
       <p><a class="botao" href="/renovar">Renovar token (60 dias)</a></p>`
    : `<p>Clique para autorizar o seu Instagram. O laboratório recebe o código, troca por token e salva no <code>.env</code>.</p>
       <p><a class="botao" href="/oauth/iniciar">Conectar Instagram</a></p>`}
<p class="aviso">URL de redirecionamento para colar no painel da Meta:<br><code>${base}/oauth/callback</code></p>
<p class="meta">Webhook: <code>${base}/webhook</code> · token de verificação: <code>${VERIFY_TOKEN || '(defina IG_VERIFY_TOKEN)'}</code></p>
</section>
<section><h2>Enviar DM de teste</h2>
<form method="post" action="/enviar">
 <input type="text" name="destinatario" placeholder="IGSID de quem vai receber" value="${credenciais.igUserId}">
 <input type="text" name="texto" placeholder="texto" value="Teste do laboratório Ienvia ✅">
 <button type="submit">Enviar pela API</button>
</form>
<p class="meta">Só funciona para quem te escreveu nas últimas 24h. Fora da janela a Meta recusa (erro 10 / 2534022) — e é bom ver isso acontecer.</p>
</section>
<section><h2>O que chegou (${evento.mensagens.length})</h2>${lista}</section>
<section><h2>Envios (${evento.envios.length})</h2><pre>${evento.envios.length ? JSON.stringify(evento.envios.slice(-5), null, 2) : 'nenhum envio ainda'}</pre></section>
<section><h2>Erros (${evento.erros.length})</h2><pre>${evento.erros.length ? JSON.stringify(evento.erros.slice(-8), null, 2) : 'nenhum erro'}</pre></section>
</main>`);
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const responder = (codigo, tipo, corpo, extra = {}) => {
    res.writeHead(codigo, { 'content-type': tipo, 'cache-control': 'no-store', ...extra });
    res.end(corpo);
  };

  // ---------- painel ----------
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/painel')) {
    return responder(200, 'text/html; charset=utf-8', painel(req));
  }

  // ---------- OAuth: passo 1, manda para o Instagram ----------
  if (url.pathname === '/oauth/iniciar') {
    const redirectUri = `${basePublica(req)}/oauth/callback`;
    const autorizacao = 'https://www.instagram.com/oauth/authorize'
      + `?client_id=${encodeURIComponent(APP_ID)}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + '&response_type=code'
      + `&scope=${encodeURIComponent(PERMISSOES)}`;
    log('→ redirecionando para o login do Instagram; redirect_uri =', redirectUri);
    return responder(302, 'text/plain', '', { location: autorizacao });
  }

  // ---------- OAuth: passo 2, recebe o code ----------
  if (url.pathname === '/oauth/callback') {
    const code = url.searchParams.get('code');
    const erroMeta = url.searchParams.get('error_description') ?? url.searchParams.get('error_reason');
    const redirectUri = `${basePublica(req)}/oauth/callback`;

    if (!code) {
      evento.erros.push({ onde: 'oauth/callback', motivo: erroMeta ?? 'sem code' });
      return responder(400, 'text/html; charset=utf-8', pagina(`<main><section><h2>Não autorizou</h2>
        <p class="ruim">${erroMeta ?? 'A Meta não devolveu o código de autorização.'}</p>
        <p><a class="botao" href="/">Voltar</a></p></section></main>`));
    }

    const curto = await trocarCodigoPorToken(code, redirectUri);
    evento.oauth.push({ quando: new Date().toISOString(), etapa: 'code→token', status: curto.status, resposta: curto.json });

    if (!curto.json.access_token) {
      evento.erros.push({ onde: 'oauth/callback', motivo: 'troca do code falhou', resposta: curto.json });
      return responder(400, 'text/html; charset=utf-8', pagina(`<main><section><h2>A Meta recusou a troca</h2>
        <p class="meta">O <code>code</code> dura 1 hora e só pode ser usado uma vez. O mais comum é o redirect URI não ser idêntico ao cadastrado.</p>
        <pre>${JSON.stringify({ redirectUriUsado: redirectUri, resposta: curto.json }, null, 2)}</pre>
        <p><a class="botao" href="/oauth/iniciar">Tentar de novo</a></p></section></main>`));
    }

    credenciais.token = curto.json.access_token;
    credenciais.igUserId = String(curto.json.user_id ?? '');
    credenciais.obtidoEm = new Date().toISOString();

    // token longo (60 dias) — se falhar, seguimos com o curto (1 hora)
    const longo = await trocarPorTokenLongo(credenciais.token);
    evento.oauth.push({ quando: new Date().toISOString(), etapa: 'token→longo', status: longo.status, resposta: longo.json });
    if (longo.json.access_token) {
      credenciais.token = longo.json.access_token;
      const segundos = Number(longo.json.expires_in ?? 0);
      if (segundos) credenciais.expiraEm = new Date(Date.now() + segundos * 1000).toISOString();
    }

    salvarNoEnv({ IG_TOKEN: credenciais.token, IG_USER_ID: credenciais.igUserId });
    log('✔ conectado. IGSID =', credenciais.igUserId, '· token salvo no .env');

    return responder(200, 'text/html; charset=utf-8', pagina(`<main>
      <section><h2>Conectado</h2>
      <p class="ok">Token obtido e salvo no <code>.env</code>.</p>
      <p>IGSID: <code>${credenciais.igUserId}</code>${credenciais.expiraEm ? `<br><span class="meta">expira em ${credenciais.expiraEm}</span>` : ''}</p>
      <p class="meta">Token longo: ${longo.json.access_token ? 'sim (60 dias)' : 'não — usando o curto, que dura 1 hora'}</p>
      <p><a class="botao" href="/">Ir para o painel</a></p></section></main>`));
  }

  // ---------- renovar token ----------
  if (url.pathname === '/renovar') {
    if (!credenciais.token) return responder(400, 'text/plain', 'sem token para renovar');
    const url2 = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(credenciais.token)}`;
    const r = await fetch(url2);
    const json = await r.json().catch(() => ({}));
    if (json.access_token) {
      credenciais.token = json.access_token;
      if (json.expires_in) credenciais.expiraEm = new Date(Date.now() + json.expires_in * 1000).toISOString();
      salvarNoEnv({ IG_TOKEN: credenciais.token });
      log('✔ token renovado até', credenciais.expiraEm);
    } else {
      evento.erros.push({ onde: '/renovar', status: r.status, resposta: json });
    }
    return responder(json.access_token ? 200 : 400, 'application/json', JSON.stringify(json, null, 2));
  }

  // ---------- verificação do webhook ----------
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const modo = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const desafio = url.searchParams.get('hub.challenge');
    evento.ultimoDesafio = { quando: new Date().toISOString(), modo, tokenRecebido: token, desafio };
    if (modo === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      log('✔ desafio do webhook conferido');
      return responder(200, 'text/plain', desafio ?? '');
    }
    log('✘ desafio recusado');
    evento.erros.push({ onde: 'GET /webhook', motivo: 'token de verificação não confere', recebido: token });
    return responder(403, 'text/plain', 'forbidden');
  }

  // ---------- eventos ----------
  if (req.method === 'POST' && url.pathname === '/webhook') {
    const corpoCru = await lerCorpo(req);
    const conferencia = assinaturaConfere(corpoCru, req.headers['x-hub-signature-256']);
    evento.ultimaAssinatura = { quando: new Date().toISOString(), ...conferencia };
    if (conferencia.valido === false) {
      log('✘ assinatura inválida');
      evento.erros.push({ onde: 'POST /webhook', motivo: conferencia.motivo || 'assinatura inválida' });
      return responder(401, 'application/json', JSON.stringify({ erro: 'assinatura inválida' }));
    }
    let corpo = {};
    try { corpo = JSON.parse(corpoCru.toString('utf8') || '{}'); }
    catch { return responder(400, 'application/json', JSON.stringify({ erro: 'JSON inválido' })); }
    if (!corpo.object || ['instagram', 'page'].includes(corpo.object)) registrarEvento(corpo);
    else log('evento ignorado (object =', corpo.object, ')');
    return responder(200, 'application/json', JSON.stringify({ recebido: true }));
  }

  // ---------- envio ----------
  if (req.method === 'POST' && url.pathname === '/enviar') {
    const campos = new URLSearchParams((await lerCorpo(req)).toString('utf8'));
    const destinatario = (campos.get('destinatario') ?? '').trim();
    const texto = (campos.get('texto') ?? '').trim();
    const voltar = (r) => responder(200, 'text/html; charset=utf-8', pagina(`<main><section><h2>${r.ok ? '<span class="ok">Enviado</span>' : '<span class="ruim">Não enviou</span>'}</h2>
      <pre>${JSON.stringify(r, null, 2)}</pre><p><a class="botao" href="/">Voltar</a></p></section></main>`));

    if (!credenciais.token) return voltar({ ok: false, erro: 'sem token — conecte primeiro' });
    if (!destinatario || !texto) return voltar({ ok: false, erro: 'informe destinatário e texto' });

    const resposta = await fetch(`https://graph.instagram.com/${VERSAO_DA_API}/me/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credenciais.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: destinatario }, message: { text: texto } }),
    });
    const json = await resposta.json().catch(() => ({}));
    const registro = { quando: new Date().toISOString(), destinatario, texto, status: resposta.status, resposta: json };
    evento.envios.push(registro);
    if (!resposta.ok) evento.erros.push({ onde: 'POST /enviar', status: resposta.status, resposta: json });
    log(resposta.ok ? '✔ DM enviada' : '✘ falha no envio', resposta.status);
    return voltar({ ok: resposta.ok, ...registro });
  }

  // ---------- inspeção ----------
  if (url.pathname === '/saude') {
    return responder(200, 'application/json', JSON.stringify({
      ok: true, conectado: Boolean(credenciais.token), igUserId: credenciais.igUserId,
      mensagens: evento.mensagens.length, enviados: evento.envios.length,
      webhook: `${basePublica(req)}/webhook`,
    }));
  }
  if (url.pathname === '/eventos') {
    const { token, ...semToken } = credenciais;
    return responder(200, 'application/json', JSON.stringify({ ...evento, credenciais: semToken }, null, 2));
  }

  responder(404, 'text/plain', 'não encontrado');
});

servidor.listen(PORTA, '0.0.0.0', () => {
  log(`laboratório no ar na porta ${PORTA}`);
  log(`app id: ${APP_ID || 'FALTANDO'} · app secret: ${APP_SECRET ? 'ok' : 'FALTANDO'} · verify token: ${VERIFY_TOKEN ? 'ok' : 'FALTANDO'}`);
  log(`já conectado: ${credenciais.token ? 'sim' : 'não'}`);
});

process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
process.on('SIGINT', () => servidor.close(() => process.exit(0)));
