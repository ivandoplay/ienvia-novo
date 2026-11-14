// Laboratório do Instagram — Edge Function (Deno/Supabase).
// Endereço FIXO, serve para webhook da Meta e para o redirect do OAuth.
//
// Rotas (tudo depois de /functions/v1/lab-instagram):
//   GET  /              → painel
//   GET  /oauth/iniciar → manda para o login do Instagram
//   GET  /oauth/callback→ recebe o code, troca por token, salva no banco
//   GET  /webhook       → responde o desafio da Meta
//   POST /webhook       → recebe DMs, story replies e comentários
//   POST /enviar        → manda DM pela API oficial
//   GET  /renovar       → renova o token (60 dias)
//   GET  /saude         → estado em JSON
//   GET  /eventos       → eventos em JSON

const APP_ID = Deno.env.get('META_APP_ID') ?? '';
const APP_SECRET = Deno.env.get('META_APP_SECRET') ?? '';
const VERIFY_TOKEN = Deno.env.get('IG_VERIFY_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BASE_URL = Deno.env.get('BASE_URL') ?? `${SUPABASE_URL}/functions/v1/lab-instagram`;
const VERSAO = Deno.env.get('VERSAO_DA_API') ?? 'v23.0';
const TAMANHO_MAX = 200;

// ---------------- banco (guarda token e eventos) ----------------
async function db(caminho: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const texto = await r.text();
  try { return JSON.parse(texto); } catch { return { bruto: texto }; }
}

async function lerEstado<T>(chave: string, padrao: T): Promise<T> {
  const dados = await db(`lab_instagram_estado?chave=eq.${chave}&select=valor`);
  if (Array.isArray(dados) && dados[0]?.valor) return dados[0].valor as T;
  return padrao;
}

async function gravarEstado(chave: string, valor: unknown) {
  await db('lab_instagram_estado', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ chave, valor, atualizado_em: new Date().toISOString() }),
  });
}

async function registrarEvento(tipo: string, dados: unknown) {
  await db('lab_instagram_eventos', {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ tipo, dados }),
  });
}

async function lerEventos(limite = 40) {
  const dados = await db(`lab_instagram_eventos?select=*&order=criado_em.desc&limit=${limite}`);
  return Array.isArray(dados) ? dados : [];
}

// ---------------- assinatura da Meta ----------------
async function assinaturaConfere(corpoCru: string, cabecalho: string | null) {
  if (!APP_SECRET) return { valido: null, motivo: 'META_APP_SECRET ausente' };
  if (!cabecalho) return { valido: false, motivo: 'sem X-Hub-Signature-256' };
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const assinatura = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(corpoCru));
  const esperado = 'sha256=' + Array.from(new Uint8Array(assinatura)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (esperado.length !== cabecalho.length) return { valido: false, motivo: 'tamanho diferente' };
  let igual = 0;
  for (let i = 0; i < esperado.length; i++) igual |= esperado.charCodeAt(i) ^ cabecalho.charCodeAt(i);
  return { valido: igual === 0, motivo: igual === 0 ? '' : 'assinatura não confere' };
}

// ---------------- HTML ----------------
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function pagina(conteudo: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Laboratório Instagram · Ienvia</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0b0d10;color:#e8eaed;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
 header{padding:16px 20px;border-bottom:1px solid #1e232b;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
 h1{font-size:16px;margin:0}
 .selo{font-size:12px;padding:3px 8px;border-radius:999px;background:#12241b;color:#4ade80;border:1px solid #1e5238}
 .selo.ruim{background:#2a1414;color:#f87171;border-color:#5b2222}
 main{max-width:900px;margin:0 auto;padding:18px}
 section{border:1px solid #1e232b;border-radius:12px;padding:16px;margin:0 0 14px;background:#0f1216}
 h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#93a1b3;margin:0 0 12px}
 code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 pre{background:#080a0d;border:1px solid #1a1f26;border-radius:8px;padding:10px;overflow:auto;font-size:12.5px;max-height:300px}
 .item{padding:9px 0;border-bottom:1px dashed #1a1f26;font-size:13.5px}
 .item:last-child{border-bottom:0}
 .meta{color:#93a1b3;font-size:12px}
 form{display:flex;gap:8px;flex-wrap:wrap}
 input[type=text]{flex:1;min-width:180px;background:#080a0d;border:1px solid #232a33;color:#e8eaed;border-radius:8px;padding:10px}
 button,.botao{background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:11px 16px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;font-size:15px}
 .ok{color:#4ade80}.ruim{color:#f87171}
 .aviso{background:#1c1508;border:1px solid #5a4410;color:#fbbf24;border-radius:8px;padding:10px;font-size:13px;word-break:break-all}
</style></head><body>${conteudo}</body></html>`;
}

const html = (corpo: string, status = 200) =>
  new Response(pagina(corpo), { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const json = (dados: unknown, status = 200) =>
  new Response(JSON.stringify(dados, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

// ---------------- painel ----------------
async function painel() {
  const estado = await lerEstado('conexao', { token: '', igUserId: '', expiraEm: '', quando: '' });
  const eventos = await lerEventos();
  const conectado = Boolean(estado.token);
  const lista = eventos.length === 0
    ? '<p class="meta">Nada ainda. Mande uma DM de outro perfil para a sua conta (ou responda um story) e atualize.</p>'
    : eventos.map((e: Record<string, unknown>) => {
        const d = (e.dados ?? {}) as Record<string, unknown>;
        return `<div class="item"><strong>${e.tipo === 'comentario' ? '💬 comentário' : '✉️ DM'}</strong>
          <span class="meta">${esc(e.criado_em)}</span><br>de: <code>${esc(d.de)}</code>${d.usuario ? ` (@${esc(d.usuario)})` : ''}
          ${d.respondendoStory ? ' · <em>resposta de story</em>' : ''}<br>
          ${d.texto ? `texto: ${esc(JSON.stringify(d.texto))}` : '<span class="meta">sem texto (anexo)</span>'}<br>
          <span class="meta">mid: <code>${esc(d.mid ?? '')}</code></span></div>`;
      }).join('');

  return html(`
<header><h1>Laboratório Instagram · Ienvia</h1>
<span class="selo ${conectado ? '' : 'ruim'}">${conectado ? 'conectado' : 'não conectado'}</span>
<span class="selo ${APP_SECRET ? '' : 'ruim'}">${APP_SECRET ? 'app secret ok' : 'sem app secret'}</span></header>
<main>
<section><h2>Conexão</h2>
${conectado
    ? `<p class="ok">Token ativo.</p><p class="meta">IGSID: <code>${esc(estado.igUserId)}</code><br>expira: ${esc(estado.expiraEm || '—')}<br>obtido: ${esc(estado.quando)}</p>
       <p><a class="botao" href="renovar">Renovar token (60 dias)</a> <a class="botao" style="background:#161b22;border:1px solid #232a33" href="oauth/iniciar">Reconectar</a></p>`
    : `<p>Um clique e a autorização do Instagram volta para cá. O token é guardado no banco, com URL fixa.</p>
       <p><a class="botao" href="oauth/iniciar">Conectar Instagram</a></p>`}
<p class="aviso">URL de redirecionamento (colar no painel da Meta):<br><code>${BASE_URL}/oauth/callback</code></p>
<p class="meta">Webhook: <code>${BASE_URL}/webhook</code><br>Token de verificação: <code>${esc(VERIFY_TOKEN)}</code></p>
</section>
<section><h2>Enviar DM de teste</h2>
<form method="post" action="enviar">
 <input type="text" name="destinatario" placeholder="IGSID de quem recebe" value="${esc(estado.igUserId)}">
 <input type="text" name="texto" value="Teste do laboratório Ienvia ✅">
 <button type="submit">Enviar pela API</button>
</form>
<p class="meta">Só para quem te escreveu nas últimas 24h. Fora da janela a Meta recusa (erro 10 / 2534022) — e é bom ver isso acontecer.</p>
</section>
<section><h2>O que chegou (${eventos.length})</h2>${lista}</section>
</main>`);
}

// ---------------- servidor ----------------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  // tira o prefixo da função: /functions/v1/lab-instagram/<rota>
  const rota = url.pathname.replace(/^\/functions\/v1\/lab-instagram/, '') || '/';

  try {
    if (req.method === 'GET' && (rota === '/' || rota === '/painel')) return await painel();

    if (rota === '/oauth/iniciar') {
      const antigo = url.searchParams.get('escopo') === 'antigo';
      const escopos = antigo
        ? 'instagram_basic,instagram_manage_messages,instagram_manage_comments,pages_show_list,pages_read_engagement,business_management'
        : 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
      const alvo = 'https://www.instagram.com/oauth/authorize'
        + `?client_id=${encodeURIComponent(APP_ID)}`
        + `&redirect_uri=${encodeURIComponent(BASE_URL + '/oauth/callback')}`
        + `&response_type=code&scope=${encodeURIComponent(escopos)}`
        + (antigo ? '&state=antigo' : '&state=unificado');
      return new Response(null, { status: 302, headers: { location: alvo } });
    }

    if (rota === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const erro = url.searchParams.get('error_description') ?? url.searchParams.get('error_message') ?? url.searchParams.get('error_reason');
      if (!code) {
        await registrarEvento('erro', { onde: 'oauth/callback', erro });
        return html(`<main><section><h2>Não autorizou</h2>
          <p class="ruim">${esc(erro ?? 'A Meta não devolveu o código.')}</p>
          <p><a class="botao" href="oauth/iniciar">Tentar de novo</a>
          <a class="botao" style="background:#161b22;border:1px solid #232a33" href="oauth/iniciar?escopo=antigo">Tentar com escopo antigo</a></p></section></main>`, 400);
      }

      const troca = await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: APP_ID, client_secret: APP_SECRET, grant_type: 'authorization_code',
          redirect_uri: `${BASE_URL}/oauth/callback`, code: code!,
        }),
      });
      const dados = await troca.json().catch(() => ({}));
      if (!dados.access_token) {
        await registrarEvento('erro', { onde: 'code→token', resposta: dados });
        return html(`<main><section><h2>A Meta recusou a troca</h2>
          <p class="meta">O <code>code</code> dura 1 hora e só vale uma vez. Causa comum: redirect URI diferente do cadastrado.</p>
          <pre>${esc(JSON.stringify({ redirectUsado: BASE_URL + '/oauth/callback', resposta: dados }, null, 2))}</pre>
          <p><a class="botao" href="oauth/iniciar">Tentar de novo</a></p></section></main>`, 400);
      }

      let token = dados.access_token as string;
      let expiraEm = '';
      const longo = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(APP_SECRET)}&access_token=${encodeURIComponent(token)}`);
      const dadosLongo = await longo.json().catch(() => ({}));
      if (dadosLongo.access_token) {
        token = dadosLongo.access_token;
        if (dadosLongo.expires_in) expiraEm = new Date(Date.now() + Number(dadosLongo.expires_in) * 1000).toISOString();
      }

      await gravarEstado('conexao', {
        token, igUserId: String(dados.user_id ?? ''), expiraEm,
        quando: new Date().toISOString(), longo: Boolean(dadosLongo.access_token),
      });
      await registrarEvento('oauth', { igUserId: String(dados.user_id ?? ''), longo: Boolean(dadosLongo.access_token), expiraEm });

      return html(`<main><section><h2>Conectado</h2>
        <p class="ok">Token obtido e guardado.</p>
        <p>IGSID: <code>${esc(dados.user_id)}</code>${expiraEm ? `<br><span class="meta">expira em ${esc(expiraEm)}</span>` : ''}</p>
        <p class="meta">Token longo: ${dadosLongo.access_token ? 'sim (60 dias)' : 'não — usando o curto, de 1 hora'}</p>
        <p><a class="botao" href="./">Ir para o painel</a></p></section></main>`);
    }

    if (rota === '/renovar') {
      const estado = await lerEstado('conexao', { token: '' });
      if (!estado.token) return json({ erro: 'sem token' }, 400);
      const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(estado.token)}`);
      const d = await r.json().catch(() => ({}));
      if (d.access_token) {
        await gravarEstado('conexao', { ...estado, token: d.access_token, expiraEm: new Date(Date.now() + Number(d.expires_in ?? 0) * 1000).toISOString() });
      }
      return json(d, d.access_token ? 200 : 400);
    }

    if (rota === '/webhook' && req.method === 'GET') {
      const modo = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const desafio = url.searchParams.get('hub.challenge');
      await registrarEvento('desafio_webhook', { modo, tokenRecebido: token, aceito: modo === 'subscribe' && token === VERIFY_TOKEN });
      if (modo === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
        return new Response(desafio ?? '', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return new Response('forbidden', { status: 403 });
    }

    if (rota === '/webhook' && req.method === 'POST') {
      const corpoCru = await req.text();
      const conferencia = await assinaturaConfere(corpoCru, req.headers.get('x-hub-signature-256'));
      if (conferencia.valido === false) {
        await registrarEvento('erro', { onde: 'POST /webhook', ...conferencia });
        return json({ erro: 'assinatura inválida', motivo: conferencia.motivo }, 401);
      }
      let corpo: Record<string, any> = {};
      try { corpo = JSON.parse(corpoCru || '{}'); } catch { return json({ erro: 'json' }, 400); }

      for (const entrada of corpo.entry ?? []) {
        for (const m of entrada.messaging ?? []) {
          const msg = m.message ?? {};
          await registrarEvento('mensagem', {
            de: m.sender?.id ?? '', igsidDoNegocio: m.recipient?.id ?? '',
            texto: msg.text ?? (msg.attachments ? `[anexo: ${(msg.attachments as any[]).map((a) => a.type).join(', ')}]` : ''),
            mid: msg.mid ?? '', respondendoStory: Boolean(msg.reply_to?.story), eco: Boolean(msg.is_echo),
            quandoDaMeta: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : null,
          });
        }
        for (const c of entrada.changes ?? []) {
          if (c.field !== 'comments') continue;
          const v = c.value ?? {};
          await registrarEvento('comentario', {
            de: v.from?.id ?? '', usuario: v.from?.username ?? '', texto: v.text ?? '',
            mid: v.id ?? '', idDaMidia: v.media?.id ?? '',
          });
        }
      }
      return json({ recebido: true });
    }

    if (rota === '/enviar' && req.method === 'POST') {
      const campos = new URLSearchParams(await req.text());
      const destinatario = (campos.get('destinatario') ?? '').trim();
      const texto = (campos.get('texto') ?? '').trim();
      const estado = await lerEstado('conexao', { token: '' });
      if (!estado.token) return html(`<main><section><h2 class="ruim">Sem token</h2><p>Conecte primeiro.</p><p><a class="botao" href="./">Voltar</a></p></section></main>`, 400);
      if (!destinatario || !texto) return html(`<main><section><h2 class="ruim">Faltou dado</h2><p><a class="botao" href="./">Voltar</a></p></section></main>`, 400);

      const r = await fetch(`https://graph.instagram.com/${VERSAO}/me/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${estado.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: { id: destinatario }, message: { text: texto } }),
      });
      const d = await r.json().catch(() => ({}));
      await registrarEvento(r.ok ? 'envio' : 'erro_envio', { destinatario, texto, status: r.status, resposta: d });
      return html(`<main><section><h2>${r.ok ? '<span class="ok">Enviado</span>' : '<span class="ruim">Não enviou</span>'}</h2>
        <pre>${esc(JSON.stringify(d, null, 2))}</pre>
        <p><a class="botao" href="./">Voltar ao painel</a></p></section></main>`);
    }

    if (rota === '/saude') {
      const estado = await lerEstado('conexao', { token: '', igUserId: '' });
      const eventos = await lerEventos(TAMANHO_MAX);
      return json({
        ok: true, conectado: Boolean(estado.token), igUserId: estado.igUserId ?? '',
        eventos: eventos.length, webhook: `${BASE_URL}/webhook`, redirect: `${BASE_URL}/oauth/callback`,
      });
    }
    if (rota === '/eventos') return json(await lerEventos(TAMANHO_MAX));

    return json({ erro: 'rota não encontrada', rota, base: BASE_URL }, 404);
  } catch (erro) {
    await registrarEvento('erro', { onde: 'geral', erro: String(erro) }).catch(() => {});
    return json({ erro: String(erro) }, 500);
  }
});
