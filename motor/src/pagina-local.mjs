/**
 * Página inicial do Motor local.
 *
 * Substitui o "só terminal": quando a pessoa roda o motor, esta página abre no navegador
 * (http://127.0.0.1:PORTA) e ela escolhe como ligar o aparelho:
 *   1) e-mail (ou usuário) + senha da conta Ienvia  → POST /api/motor/parear-senha
 *   2) código de pareamento IENV-XXXX-XXXX          → POST /api/motor/parear
 *
 * Regra do produto: aqui só se liga o APARELHO ao sistema. Conectar chip/WhatsApp (QR ou código
 * de 8 dígitos) acontece exclusivamente no painel. Esta página não mostra QR nem pede senha do WhatsApp.
 *
 * Segurança: escuta apenas em 127.0.0.1 e exige o token local em cabeçalho — assim outra página
 * aberta no mesmo computador não consegue reinventar o aparelho sem conhecer o token.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const CORPO_MAXIMO = 32 * 1024;

export function lerTokenLocal(rootDir) {
  const arquivo = path.join(rootDir, 'data', 'local-web.json');
  try {
    const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    if (typeof salvo?.token === 'string' && salvo.token.length >= 32) return { token: salvo.token, arquivo };
  } catch {
    /* primeiro uso */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 });
  fs.writeFileSync(arquivo, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
  return { token, arquivo };
}

function responderJson(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(corpo),
    'cache-control': 'no-store',
  });
  res.end(corpo);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', (parte) => {
      total += parte.length;
      if (total > CORPO_MAXIMO) {
        reject(new Error('Corpo grande demais.'));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'));
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

/** Busca o endereço do painel tentando os domínios oficiais, para a pessoa não digitar nada. */
async function descobrirPainel(fetchFn, candidatos) {
  for (const base of candidatos) {
    try {
      const resp = await fetchFn(`${base}/api/motor/versao`, { signal: AbortSignal.timeout(6000) });
      if (resp.ok) {
        const dados = await resp.json().catch(() => ({}));
        if (dados && typeof dados === 'object' && !('erro' in dados)) return base;
      }
    } catch {
      /* tenta o próximo */
    }
  }
  return null;
}

export async function iniciarPaginaLocal({
  rootDir,
  porta = Number(process.env.IENVIA_MOTOR_PORTA || 4599),
  host = '127.0.0.1',
  abrirNavegador = true,
  candidatosDePainel = ['https://app.ienvia.online', 'https://ienvia.online'],
  lerConfiguracao,
  salvarConfiguracao,
  aoParear,
  fetchFn = fetch,
  onLog = console.log,
}) {
  const { token } = lerTokenLocal(rootDir);
  let portaReal = porta;
  const config = lerConfiguracao(rootDir);
  const estado = {
    painel: config.panelUrl || null,
    pareado: Boolean(config.panelUrl && config.deviceToken),
    aparelho: config.displayName || os.hostname(),
    executorId: config.executorId || null,
    erro: null,
    ocupado: false,
  };

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${portaReal}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = paginaHtml({ token, estado });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/estado') {
      responderJson(res, 200, {
        pareado: estado.pareado,
        painel: estado.painel,
        aparelho: estado.aparelho,
        executorId: estado.executorId,
        ocupado: estado.ocupado,
        erro: estado.erro,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-ienvia-local'] !== token) {
        responderJson(res, 403, { erro: 'Requisição não autorizada. Abra a página pelo endereço mostrado no terminal.' });
        return;
      }
      let corpo;
      try {
        corpo = await lerCorpo(req);
      } catch (err) {
        responderJson(res, 400, { erro: err.message });
        return;
      }
      if (estado.ocupado) {
        responderJson(res, 409, { erro: 'Já existe um pareamento em andamento. Aguarde alguns segundos.' });
        return;
      }

      estado.ocupado = true;
      estado.erro = null;
      try {
        if (url.pathname === '/api/parear-senha') {
          const resultado = await parearComSenha({ rootDir, corpo, estado, fetchFn, lerConfiguracao, salvarConfiguracao });
          responderJson(res, resultado.status, resultado.dados);
        } else if (url.pathname === '/api/parear-codigo') {
          const resultado = await parearComCodigo({ rootDir, corpo, estado, fetchFn, lerConfiguracao, salvarConfiguracao });
          responderJson(res, resultado.status, resultado.dados);
        } else if (url.pathname === '/api/recomecar') {
          estado.pareado = false;
          estado.erro = null;
          responderJson(res, 200, { ok: true });
        } else {
          responderJson(res, 404, { erro: 'Rota não encontrada.' });
        }
      } catch (err) {
        estado.erro = err.message;
        responderJson(res, 500, { erro: err.message });
      } finally {
        estado.ocupado = false;
      }
      if (estado.pareado && typeof aoParear === 'function') {
        try {
          aoParear({ painel: estado.painel, aparelho: estado.aparelho });
        } catch {
          /* o loop principal reclama se não conseguir */
        }
      }
      return;
    }

    responderJson(res, 404, { erro: 'Rota não encontrada.' });
  });

  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(porta, host, () => {
      portaReal = servidor.address().port;
      resolve();
    });
  });
  const endereco = `http://${host}:${portaReal}`;

  if (!estado.pareado && abrirNavegador) {
    const painel = await descobrirPainel(fetchFn, candidatosDePainel);
    if (painel) estado.painel = painel;
    abrirNoNavegador(endereco, onLog);
  }

  onLog(`[motor] Página do motor: ${endereco}`);
  if (estado.pareado) onLog(`[motor] Aparelho "${estado.aparelho}" já pareado com ${estado.painel}.`);
  else onLog('[motor] Abra a página acima e ligue o aparelho (senha da conta ou código).');

  return {
    endereco,
    token,
    estado,
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

async function parearComCodigo({ rootDir, corpo, estado, fetchFn, lerConfiguracao, salvarConfiguracao }) {
  const codigo = String(corpo.codigo ?? '').trim();
  const painel = String(corpo.painel ?? estado.painel ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(painel)) {
    return { status: 400, dados: { erro: 'Endereço do painel inválido.' } };
  }
  if (!codigo) return { status: 400, dados: { erro: 'Digite o código de pareamento.' } };

  const resp = await fetchFn(`${painel}/api/motor/parear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: codigo,
      platform: detectarPlataforma(),
      version: lerVersao(rootDir),
      metadata: { hostname: os.hostname(), arch: process.arch, node: process.version, os_release: os.release() },
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);

  if (!resp) return { status: 502, dados: { erro: 'Não consegui falar com o painel. Confira sua internet.' } };
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok || !dados.device_token) {
    return { status: resp.status || 400, dados: { erro: dados.erro || 'Código inválido ou expirado. Gere outro no painel.' } };
  }

  salvarConfiguracao(rootDir, {
    panelUrl: painel,
    deviceToken: dados.device_token,
    executorId: dados.executor_id,
    workspaceId: dados.workspace_id,
    displayName: dados.display_name,
  });
  Object.assign(estado, { pareado: true, painel, aparelho: dados.display_name, executorId: dados.executor_id, erro: null });
  const atual = lerConfiguracao(rootDir);
  return { status: 200, dados: { ok: true, aparelho: atual.displayName, painel } };
}

async function parearComSenha({ rootDir, corpo, estado, fetchFn, lerConfiguracao, salvarConfiguracao }) {
  const painel = String(corpo.painel ?? estado.painel ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(painel)) {
    return { status: 400, dados: { erro: 'Endereço do painel inválido. Use https://app.ienvia.online' } };
  }

  const resp = await fetchFn(`${painel}/api/motor/parear-senha`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: String(corpo.email ?? '').trim(),
      senha: String(corpo.senha ?? ''),
      workspaceId: corpo.workspaceId ? String(corpo.workspaceId) : undefined,
      aparelho: String(corpo.aparelho ?? os.hostname()).slice(0, 80),
    }),
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);

  if (!resp) return { status: 502, dados: { erro: 'Não consegui falar com o painel. Confira sua internet.' } };
  if (resp.status === 404) {
    return {
      status: 404,
      dados: { erro: `O painel ${painel} ainda não tem a entrada por senha. Use o código de pareamento ou atualize o painel.` },
    };
  }
  const dados = await resp.json().catch(() => ({}));

  // A conta administra mais de uma empresa: devolve a lista para a página mostrar o seletor.
  if (dados.precisaEscolherConta) {
    return { status: 200, dados: { precisaEscolherConta: true, contas: dados.contas ?? [] } };
  }
  if (!resp.ok || !dados.device_token) {
    return { status: resp.status || 400, dados: { erro: dados.erro || 'Não foi possível ligar o aparelho.' } };
  }

  salvarConfiguracao(rootDir, {
    panelUrl: painel,
    deviceToken: dados.device_token,
    executorId: dados.executor_id,
    workspaceId: dados.workspace_id,
    displayName: dados.display_name,
  });
  Object.assign(estado, { pareado: true, painel, aparelho: dados.display_name, executorId: dados.executor_id, erro: null });
  const atual = lerConfiguracao(rootDir);
  return { status: 200, dados: { ok: true, aparelho: atual.displayName, painel } };
}

function detectarPlataforma() {
  if (process.env.TERMUX_VERSION || String(process.env.PREFIX || '').includes('com.termux')) return 'android-termux';
  return process.platform;
}

function lerVersao(rootDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version || '6.0.0';
  } catch {
    return '6.0.0';
  }
}

function abrirNoNavegador(endereco, onLog) {
  const comando =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', endereco]]
      : process.platform === 'darwin'
        ? ['open', [endereco]]
        : ['xdg-open', [endereco]];
  try {
    const filho = spawn(comando[0], comando[1], { stdio: 'ignore', detached: true });
    filho.on('error', () => onLog(`[motor] Abra no navegador: ${endereco}`));
    filho.unref();
  } catch {
    onLog(`[motor] Abra no navegador: ${endereco}`);
  }
}

export function paginaHtml({ token, estado }) {
  const painel = estado.painel || 'https://app.ienvia.online';
  const pareado = estado.pareado === true;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ienvia Motor</title>
<style>
:root{--bg:#0b0f10;--card:#12181a;--linha:#20302e;--texto:#e8f2ef;--fraco:#8fa8a2;--mint:#37e0b0;--erro:#ff6b6b}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#123 0,var(--bg) 60%);color:var(--texto);
font-family:"Manrope",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.caixa{width:100%;max-width:520px;background:var(--card);border:1px solid var(--linha);border-radius:20px;padding:28px;
box-shadow:0 24px 60px rgba(0,0,0,.45)}
.marca{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.01em}
.selo{margin-left:auto;font-size:12px;color:var(--fraco);border:1px solid var(--linha);padding:4px 10px;border-radius:999px}
.selo.on{color:var(--mint);border-color:#1d5c4a}
h1{font-size:22px;margin:18px 0 6px}
p.sub{margin:0 0 20px;color:var(--fraco);font-size:14px;line-height:1.5}
.abas{display:flex;gap:8px;background:#0d1415;border:1px solid var(--linha);border-radius:12px;padding:4px;margin-bottom:18px}
.abas button{flex:1;background:transparent;border:0;color:var(--fraco);padding:10px;border-radius:9px;font:inherit;font-size:14px;cursor:pointer}
.abas button.ativa{background:#17211f;color:var(--texto)}
label{display:block;font-size:13px;color:var(--fraco);margin:14px 0 6px}
input,select{width:100%;background:#0d1415;border:1px solid var(--linha);border-radius:11px;padding:13px 14px;color:var(--texto);font:inherit;font-size:15px}
input:focus,select:focus{outline:none;border-color:var(--mint);box-shadow:0 0 0 3px rgba(55,224,176,.12)}
button.principal{width:100%;margin-top:20px;background:var(--mint);color:#04231b;border:0;border-radius:12px;padding:14px;font:inherit;
font-weight:700;font-size:15px;cursor:pointer}
button.principal:disabled{opacity:.55;cursor:default}
.recado{margin-top:16px;padding:12px 14px;border-radius:11px;font-size:14px;line-height:1.45}
.recado.erro{background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.35);color:#ffb3b3}
.recado.ok{background:rgba(55,224,176,.1);border:1px solid rgba(55,224,176,.35);color:#a9f5dd}
.nota{margin-top:18px;font-size:12.5px;color:var(--fraco);line-height:1.5;border-top:1px solid var(--linha);padding-top:14px}
.dado{display:flex;justify-content:space-between;gap:12px;font-size:14px;padding:9px 0;border-bottom:1px dashed var(--linha)}
.dado span:first-child{color:var(--fraco)}
[hidden]{display:none!important}
</style></head>
<body><div class="caixa">
  <div class="marca">∞ Ienvia Motor <span class="selo ${pareado ? 'on' : ''}" id="selo">${pareado ? 'ligado' : 'não ligado'}</span></div>
  <h1 id="titulo">${pareado ? 'Este aparelho já está ligado' : 'Ligue este aparelho à sua conta'}</h1>
  <p class="sub" id="subtitulo">${pareado
    ? 'Está tudo certo: o motor está rodando e recebendo comandos do painel. Para conectar um WhatsApp, use o painel em Conexões / Instâncias.'
    : 'Entre com a mesma conta que você usa no painel. Depois de ligar, os WhatsApps são conectados no painel — aqui não se conecta chip.'}</p>

  <div id="blocoPareado" ${pareado ? '' : 'hidden'}>
    <div class="dado"><span>Aparelho</span><span id="dAparelho">${esc(estado.aparelho)}</span></div>
    <div class="dado"><span>Painel</span><span id="dPainel">${esc(painel)}</span></div>
    <div class="dado"><span>Situação</span><span id="dSituacao">recebendo comandos</span></div>
    <button class="principal" id="bRecomecar" style="margin-top:22px;background:transparent;color:var(--texto);border:1px solid var(--linha)">Ligar outro aparelho</button>
  </div>

  <div id="blocoLigar" ${pareado ? 'hidden' : ''}>
    <div class="abas">
      <button data-aba="senha" class="ativa" id="abaSenha">E-mail e senha</button>
      <button data-aba="codigo" id="abaCodigo">Código de pareamento</button>
    </div>

    <div id="painelSenha">
      <label for="email">E-mail ou usuário da conta</label>
      <input id="email" type="text" autocomplete="username" placeholder="voce@empresa.com">
      <label for="senha">Senha</label>
      <input id="senha" type="password" autocomplete="current-password" placeholder="sua senha do painel">
      <label for="conta" id="rotuloConta" hidden>Qual conta?</label>
      <select id="conta" hidden></select>
      <button class="principal" id="bSenha">Ligar este aparelho</button>
    </div>

    <div id="painelCodigo" hidden>
      <label for="codigo">Código gerado no painel</label>
      <input id="codigo" type="text" placeholder="IENV-XXXX-XXXX" autocapitalize="characters" spellcheck="false">
      <button class="principal" id="bCodigo">Ligar com código</button>
      <p class="nota">O código é criado em <strong>Conexões / Motor</strong>, no painel, e vale 15 minutos.</p>
    </div>
  </div>

  <div id="recado" class="recado erro" hidden></div>

  <p class="nota">A senha serve só para ligar o aparelho agora — o motor não guarda senha, guarda um token próprio.
  Conectar WhatsApp (QR ou código de 8 dígitos) é feito exclusivamente no painel do Ienvia.</p>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const PAINEL = ${JSON.stringify(painel)};
const q = (s) => document.querySelector(s);
function recado(texto, tipo){
  const el = q('#recado');
  el.hidden = !texto; el.className = 'recado ' + (tipo || 'erro'); el.textContent = texto || '';
}
q('#abaSenha').onclick = () => trocarAba('senha');
q('#abaCodigo').onclick = () => trocarAba('codigo');
function trocarAba(qual){
  q('#abaSenha').classList.toggle('ativa', qual === 'senha');
  q('#abaCodigo').classList.toggle('ativa', qual === 'codigo');
  q('#painelSenha').hidden = qual !== 'senha';
  q('#painelCodigo').hidden = qual !== 'codigo';
  recado('');
}
async function enviar(rota, corpo, botao){
  botao.disabled = true;
  recado('');
  try {
    const resp = await fetch(rota, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ienvia-local': TOKEN },
      body: JSON.stringify(corpo),
    });
    return await resp.json();
  } catch (e) {
    return { erro: 'Não consegui falar com o motor. Ele ainda está rodando?' };
  } finally {
    botao.disabled = false;
  }
}
q('#bSenha').onclick = async () => {
  const botao = q('#bSenha');
  const email = q('#email').value.trim();
  const senha = q('#senha').value;
  if (!email || !senha) { recado('Digite o e-mail (ou usuário) e a senha.'); return; }
  const dados = await enviar('/api/parear-senha', { email, senha, painel: PAINEL, workspaceId: q('#conta').value || undefined, aparelho: ${JSON.stringify(os.hostname())} }, botao);
  if (dados.precisaEscolherConta) {
    const sel = q('#conta');
    sel.innerHTML = (dados.contas || []).map(c => '<option value="' + c.id + '">' + c.name + '</option>').join('');
    sel.hidden = false; q('#rotuloConta').hidden = false;
    recado('Sua conta administra mais de uma empresa. Escolha qual usar e clique de novo.', 'ok');
    return;
  }
  if (dados.ok) { ligado(dados); return; }
  recado(dados.erro || 'Não foi possível ligar o aparelho.');
  q('#senha').value = '';
};
q('#bCodigo').onclick = async () => {
  const botao = q('#bCodigo');
  const codigo = q('#codigo').value.trim();
  if (!codigo) { recado('Digite o código de pareamento.'); return; }
  const dados = await enviar('/api/parear-codigo', { codigo, painel: PAINEL }, botao);
  if (dados.ok) { ligado(dados); return; }
  recado(dados.erro || 'Código inválido ou expirado.');
};
q('#bRecomecar').onclick = async () => {
  await fetch('/api/recomecar', { method: 'POST', headers: { 'x-ienvia-local': TOKEN } }).catch(() => null);
  q('#blocoPareado').hidden = true; q('#blocoLigar').hidden = false;
  q('#titulo').textContent = 'Ligue este aparelho à sua conta';
};
function ligado(dados){
  q('#dAparelho').textContent = dados.aparelho || '';
  q('#dPainel').textContent = dados.painel || PAINEL;
  q('#blocoLigar').hidden = true; q('#blocoPareado').hidden = false;
  q('#titulo').textContent = 'Aparelho ligado!';
  q('#selo').textContent = 'ligado'; q('#selo').classList.add('on');
  q('#subtitulo').textContent = 'O motor já está recebendo comandos. Conecte seus WhatsApps no painel.';
  recado('Tudo certo. Você já pode fechar esta aba — mas deixe o motor aberto no computador.', 'ok');
}
</script></body></html>`;
}
