// Laboratório do Instagram — Cloudflare Worker.
// Endereço fixo (workers.dev), serve de webhook da Meta e de redirect do OAuth.
//
// Rotas:
//   GET  /                → painel
//   GET  /oauth/iniciar   → manda para o login do Instagram (?escopo=antigo troca a lista)
//   GET  /oauth/callback  → recebe o code, troca por token, guarda no KV
//   GET  /webhook         → responde o desafio da Meta (hub.challenge)
//   POST /webhook         → recebe DMs, story replies e comentários
//   POST /enviar          → manda DM pela API oficial
//   GET  /renovar         → renova o token (60 dias)
//   GET  /saude           → estado em JSON
//   GET  /eventos         → eventos em JSON
//   GET  /limpar          → apaga eventos e conexão

const TTL_TOKEN = 60 * 24 * 60 * 60; // 60 dias
const VERSAO_FB = 'v23.0';

// ---------- utilidades ----------
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const html = (corpo, status = 200) => new Response(pagina(corpo), {
  status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});
const json = (dados, status = 200) => new Response(JSON.stringify(dados, null, 2), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function hex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function assinaturaConfere(corpoCru, cabecalho, segredo) {
  if (!segredo) return { valido: null, motivo: 'META_APP_SECRET ausente' };
  if (!cabecalho) return { valido: false, motivo: 'sem X-Hub-Signature-256' };
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const esperado = 'sha256=' + hex(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(corpoCru)));
  if (esperado.length !== cabecalho.length) return { valido: false, motivo: 'tamanho diferente' };
  let igual = 0;
  for (let i = 0; i < esperado.length; i++) igual |= esperado.charCodeAt(i) ^ cabecalho.charCodeAt(i);
  return { valido: igual === 0, motivo: igual === 0 ? '' : 'assinatura não confere' };
}

async function registrar(env, tipo, dados) {
  const chave = `ev:${String(Date.now()).padStart(14, '0')}:${Math.random().toString(36).slice(2, 8)}`;
  await env.LAB.put(chave, JSON.stringify({ tipo, dados, criado_em: new Date().toISOString() }), { expirationTtl: 7 * 24 * 60 * 60 });
}

async function lerEventos(env, limite = 40) {
  const lista = await env.LAB.list({ prefix: 'ev:', limit: 1000 });
  const chaves = lista.keys.map((k) => k.name).sort().reverse().slice(0, limite);
  const valores = await Promise.all(chaves.map((c) => env.LAB.get(c, 'json')));
  return valores.filter(Boolean);
}

const lerConexao = (env) => env.LAB.get('conexao', 'json');
const gravarConexao = (env, valor) => env.LAB.put('conexao', JSON.stringify(valor), { expirationTtl: TTL_TOKEN });

// ---------- HTML ----------
function pagina(conteudo) {
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
 pre{background:#080a0d;border:1px solid #1a1f26;border-radius:8px;padding:10px;overflow:auto;font-size:12.5px;max-height:320px}
 .item{padding:9px 0;border-bottom:1px dashed #1a1f26;font-size:13.5px}
 .item:last-child{border-bottom:0}
 .meta{color:#93a1b3;font-size:12px}
 form{display:flex;gap:8px;flex-wrap:wrap}
 input[type=text]{flex:1;min-width:170px;background:#080a0d;border:1px solid #232a33;color:#e8eaed;border-radius:8px;padding:10px}
 button,.botao{background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:11px 16px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;font-size:15px}
 .ok{color:#4ade80}.ruim{color:#f87171}
 .aviso{background:#1c1508;border:1px solid #5a4410;color:#fbbf24;border-radius:8px;padding:10px;font-size:13px;word-break:break-all}
</style></head><body>${conteudo}</body></html>`;
}

async function painel(env, base) {
  const conexao = await lerConexao(env);
  const eventos = await lerEventos(env);
  const conectado = Boolean(conexao?.token);
  const lista = eventos.length === 0
    ? '<p class="meta">Nada ainda. Mande uma DM de outro perfil para a sua conta (ou responda um story) e atualize.</p>'
    : eventos.map((e) => {
        const d = e.dados ?? {};
        return `<div class="item"><strong>${e.tipo === 'comentario' ? '💬 comentário' : e.tipo.startsWith('erro') ? '⚠️ ' + esc(e.tipo) : '✉️ DM'}</strong>
          <span class="meta">${esc(e.criado_em)}</span><br>de: <code>${esc(d.de)}</code>${d.usuario ? ` (@${esc(d.usuario)})` : ''}
          ${d.respondendoStory ? ' · <em>resposta de story</em>' : ''}<br>
          ${d.texto ? `texto: ${esc(JSON.stringify(d.texto))}` : '<span class="meta">sem texto</span>'}<br>
          <span class="meta">${d.mid ? `mid: <code>${esc(d.mid)}</code>` : esc(JSON.stringify(d).slice(0, 200))}</span></div>`;
      }).join('');

  return html(`
<header><h1>Laboratório Instagram · Ienvia</h1>
<span class="selo ${conectado ? '' : 'ruim'}">${conectado ? 'conectado' : 'não conectado'}</span>
<span class="selo ${env.APP_SECRET ? '' : 'ruim'}">${env.APP_SECRET ? 'app secret ok' : 'sem app secret'}</span></header>
<main>
<section><h2>Conexão</h2>
${conectado
    ? `<p class="ok">Token ativo${conexao.usuario ? ` — @${esc(conexao.usuario)}` : ''}${conexao.tipo === 'facebook' ? ' (via Facebook)' : ''}.</p>
       <p class="meta">IGSID: <code>${esc(conexao.igUserId)}</code>${conexao.paginaNome ? ` · Página: ${esc(conexao.paginaNome)}` : ''}<br>expira: ${esc(conexao.expiraEm || '—')}<br>obtido: ${esc(conexao.quando)}</p>
       <p><a class="botao" href="renovar">Renovar token</a> <a class="botao" style="background:#161b22;border:1px solid #232a33" href="oauth/iniciar">Reconectar</a></p>`
    : `<p>Um clique e a autorização do Instagram volta para cá.</p>
       <p><a class="botao" href="oauth/iniciar">Conectar Instagram</a></p>
       <p><a class="botao" style="background:#161b22;border:1px solid #232a33;font-size:13px" href="oauth/iniciar?escopo=antigo">Tentar com escopo antigo</a></p>`}
<p class="aviso">URL de redirecionamento (colar no painel da Meta):<br><code>${base}/oauth/callback</code></p>
<p class="meta">Webhook: <code>${base}/webhook</code><br>Token de verificação: <code>${esc(env.IG_VERIFY_TOKEN)}</code></p>
</section>
<section><h2>Enviar DM de teste</h2>
<form method="post" action="enviar">
 <input type="text" name="destinatario" placeholder="IGSID de quem recebe" value="${esc(conexao?.igUserId ?? '')}">
 <input type="text" name="texto" value="Teste do laboratório Ienvia ✅">
 <button type="submit">Enviar pela API</button>
</form>
<p class="meta">Só para quem te escreveu nas últimas 24h. Fora da janela a Meta recusa (erro 10 / 2534022).</p>
</section>
<section><h2>O que chegou (${eventos.length})</h2>${lista}</section>
<section><h2>Caminho B · login do Facebook (SUAT)</h2>
<p class="meta">Token de usuário do sistema não expira. Precisa do ativo <strong>Conta do Instagram</strong> anexado na configuração.</p>
<p><a class="botao" style="background:#161b22;border:1px solid #232a33" href="api-sistema">Testar token + ativo</a></p>
<p class="meta">Escopos pedidos por este caminho: <code>instagram_basic</code>, <code>instagram_manage_messages</code>, <code>instagram_manage_comments</code></p>
</section>
<section><h2>Ferramentas</h2><p class="meta"><a href="saude">saude</a> · <a href="eventos">eventos</a> · <a href="limpar">limpar tudo</a></p></section>
</main>`);
}

// ---------- handler ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const rota = url.pathname.replace(/\/+$/, '') || '/';
    const base = env.BASE_URL || url.origin;

    try {
      if (rota === '/' || rota === '/painel') return await painel(env, base);

      if (rota === '/oauth/iniciar') {
        const igAppId = env.IG_APP_ID || env.APP_ID;
        const antigo = url.searchParams.get('escopo') === 'antigo';
        const escopos = antigo
          ? 'instagram_basic,instagram_manage_messages,instagram_manage_comments,pages_show_list,pages_read_engagement,business_management'
          : 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
        const alvo = 'https://www.instagram.com/oauth/authorize'
          + `?client_id=${encodeURIComponent(igAppId)}`
          + `&redirect_uri=${encodeURIComponent(base + '/oauth/callback')}`
          + `&response_type=code&scope=${encodeURIComponent(escopos)}`
          + `&state=${antigo ? 'antigo' : 'unificado'}`;
        return Response.redirect(alvo, 302);
      }

      if (rota === '/fb/iniciar') {
        const alvo = 'https://www.facebook.com/v23.0/dialog/oauth'
          + `?client_id=${encodeURIComponent(env.APP_ID)}`
          + `&config_id=${encodeURIComponent(env.LOGIN_CONFIG_ID || '')}`
          + `&redirect_uri=${encodeURIComponent(base + '/oauth/callback')}`
          + `&response_type=code&state=fb:laboratorio&prompt=login`;
        return Response.redirect(alvo, 302);
      }

      if (rota === '/oauth/callback') {
        const code = url.searchParams.get('code');
        const estado = url.searchParams.get('state') || '';

        // ---- caminho Facebook Login (usuário do sistema NÃO é necessário) ----
        if (estado.startsWith('fb:') && code) {
          const troca = await fetch('https://graph.facebook.com/v23.0/oauth/access_token?'
            + new URLSearchParams({ client_id: env.APP_ID, client_secret: env.APP_SECRET, redirect_uri: `${base}/oauth/callback`, code }));
          const d = await troca.json().catch(() => ({}));
          if (!d.access_token) {
            await registrar(env, 'erro_troca_fb', { resposta: d });
            return html(`<main><section><h2>A Meta recusou (Facebook Login)</h2>
              <pre>${esc(JSON.stringify(d, null, 2))}</pre>
              <p><a class="botao" href="./">Voltar</a></p></section></main>`, 400);
          }

          // token longo (60 dias)
          let token = d.access_token;
          let expiraEm = '';
          try {
            const r = await fetch('https://graph.facebook.com/v23.0/oauth/access_token?'
              + new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: env.APP_ID, client_secret: env.APP_SECRET, fb_exchange_token: token }));
            const dl = await r.json();
            if (dl.access_token) {
              token = dl.access_token;
              if (dl.expires_in) expiraEm = new Date(Date.now() + Number(dl.expires_in) * 1000).toISOString();
            }
          } catch { /* segue com o curto */ }

          // descobre a conta do Instagram ligada às páginas do usuário
          const contas = await (await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`)).json().catch(() => ({}));
          const paginas = (contas.data ?? []).filter((p) => p.instagram_business_account);
          const escolhida = paginas.find((p) => String(p.instagram_business_account.id) === String(env.IG_BUSINESS_ID)) ?? paginas[0];

          if (!escolhida) {
            await registrar(env, 'fb_sem_instagram', { contas });
            return html(`<main><section><h2>Login ok, mas sem conta do Instagram</h2>
              <p class="meta">O Facebook não devolveu nenhuma Página com conta do Instagram vinculada.</p>
              <pre>${esc(JSON.stringify(contas, null, 2))}</pre>
              <p class="meta">Causa comum: a conta do Instagram não está vinculada a uma Página do Facebook.</p>
              <p><a class="botao" href="./">Voltar</a></p></section></main>`, 400);
          }

          const igId = String(escolhida.instagram_business_account.id);
          await gravarConexao(env, { token, igUserId: igId, tipo: 'facebook', paginaId: escolhida.id,
            paginaNome: escolhida.name, usuario: escolhida.instagram_business_account.username,
            expiraEm, quando: new Date().toISOString() });
          await registrar(env, 'oauth_fb_ok', { igUserId: igId, usuario: escolhida.instagram_business_account.username, pagina: escolhida.name });

          return html(`<main><section><h2>Conectado pelo Facebook</h2>
            <p class="ok">@${esc(escolhida.instagram_business_account.username)} · IG <code>${esc(igId)}</code></p>
            <p class="meta">Página: ${esc(escolhida.name)} · token ${expiraEm ? 'longo, expira em ' + esc(expiraEm) : 'curto'}</p>
            <p><a class="botao" href="./">Ir para o painel</a></p></section></main>`);
        }

        const erro = url.searchParams.get('error_description') ?? url.searchParams.get('error_message') ?? url.searchParams.get('error_reason');
        if (!code) {
          await registrar(env, 'erro_oauth', { erro, params: Object.fromEntries(url.searchParams) });
          return html(`<main><section><h2>Não autorizou</h2>
            <p class="ruim">${esc(erro ?? 'A Meta não devolveu o código.')}</p>
            <pre>${esc(JSON.stringify(Object.fromEntries(url.searchParams), null, 2))}</pre>
            <p><a class="botao" href="oauth/iniciar">Tentar de novo</a></p></section></main>`, 400);
        }

        const troca = await fetch('https://api.instagram.com/oauth/access_token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: env.IG_APP_ID || env.APP_ID, client_secret: env.IG_APP_SECRET || env.APP_SECRET,
            grant_type: 'authorization_code', redirect_uri: `${base}/oauth/callback`, code,
          }),
        });
        const dados = await troca.json().catch(() => ({}));
        if (!dados.access_token) {
          await registrar(env, 'erro_troca', { resposta: dados });
          return html(`<main><section><h2>A Meta recusou a troca</h2>
            <p class="meta">O <code>code</code> vale 1 hora e só uma vez. Causa comum: redirect URI diferente do cadastrado.</p>
            <pre>${esc(JSON.stringify({ redirectUsado: base + '/oauth/callback', resposta: dados }, null, 2))}</pre>
            <p><a class="botao" href="oauth/iniciar">Tentar de novo</a></p></section></main>`, 400);
        }

        let token = dados.access_token;
        let expiraEm = '';
        let longo = false;
        try {
          const r = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env.IG_APP_SECRET || env.APP_SECRET)}&access_token=${encodeURIComponent(token)}`);
          const d = await r.json();
          if (d.access_token) {
            token = d.access_token; longo = true;
            if (d.expires_in) expiraEm = new Date(Date.now() + Number(d.expires_in) * 1000).toISOString();
          }
        } catch { /* segue com o token curto */ }

        await gravarConexao(env, { token, igUserId: String(dados.user_id ?? ''), expiraEm, longo, quando: new Date().toISOString() });
        await registrar(env, 'oauth_ok', { igUserId: String(dados.user_id ?? ''), longo, expiraEm });

        return html(`<main><section><h2>Conectado</h2>
          <p class="ok">Token obtido e guardado.</p>
          <p>IGSID: <code>${esc(dados.user_id)}</code>${expiraEm ? `<br><span class="meta">expira em ${esc(expiraEm)}</span>` : ''}</p>
          <p class="meta">Token longo (60 dias): ${longo ? 'sim' : 'não — usando o curto, de 1 hora'}</p>
          <p><a class="botao" href="./">Ir para o painel</a></p></section></main>`);
      }

      if (rota === '/renovar') {
        const conexao = await lerConexao(env);
        if (!conexao?.token) return json({ erro: 'sem token' }, 400);
        const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(conexao.token)}`);
        const d = await r.json().catch(() => ({}));
        if (d.access_token) {
          await gravarConexao(env, { ...conexao, token: d.access_token, expiraEm: new Date(Date.now() + Number(d.expires_in ?? 0) * 1000).toISOString() });
        }
        return json(d, d.access_token ? 200 : 400);
      }

      if (rota === '/webhook' && req.method === 'GET') {
        const modo = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const desafio = url.searchParams.get('hub.challenge');
        const aceito = modo === 'subscribe' && Boolean(env.IG_VERIFY_TOKEN) && token === env.IG_VERIFY_TOKEN;
        await registrar(env, aceito ? 'desafio_ok' : 'desafio_recusado', { modo, tokenRecebido: token });
        if (aceito) return new Response(desafio ?? '', { status: 200, headers: { 'content-type': 'text/plain' } });
        return new Response('forbidden', { status: 403 });
      }

      if (rota === '/webhook' && req.method === 'POST') {
        const corpoCru = await req.text();
        const conf = await assinaturaConfere(corpoCru, req.headers.get('x-hub-signature-256'), env.APP_SECRET);
        if (conf.valido === false) {
          await registrar(env, 'erro_assinatura', { ...conf, tamanho: corpoCru.length });
          return json({ erro: 'assinatura inválida', motivo: conf.motivo }, 401);
        }
        let corpo = {};
        try { corpo = JSON.parse(corpoCru || '{}'); } catch { return json({ erro: 'json' }, 400); }

        for (const entrada of corpo.entry ?? []) {
          for (const m of entrada.messaging ?? []) {
            const msg = m.message ?? {};
            await registrar(env, 'mensagem', {
              de: m.sender?.id ?? '', igsidDoNegocio: m.recipient?.id ?? '',
              texto: msg.text ?? (msg.attachments ? `[anexo: ${msg.attachments.map((a) => a.type).join(', ')}]` : ''),
              mid: msg.mid ?? '', respondendoStory: Boolean(msg.reply_to?.story), eco: Boolean(msg.is_echo),
            });
          }
          for (const c of entrada.changes ?? []) {
            if (c.field !== 'comments') continue;
            const v = c.value ?? {};
            await registrar(env, 'comentario', {
              de: v.from?.id ?? '', usuario: v.from?.username ?? '', texto: v.text ?? '', mid: v.id ?? '',
            });
          }
        }
        return json({ recebido: true });
      }

      if (rota === '/enviar' && req.method === 'POST') {
        const campos = new URLSearchParams(await req.text());
        const destinatario = (campos.get('destinatario') ?? '').trim();
        const texto = (campos.get('texto') ?? '').trim();
        const conexao = await lerConexao(env);
        if (!conexao?.token) return html(`<main><section><h2 class="ruim">Sem token</h2><p><a class="botao" href="./">Voltar</a></p></section></main>`, 400);
        if (!destinatario || !texto) return html(`<main><section><h2 class="ruim">Faltou dado</h2><p><a class="botao" href="./">Voltar</a></p></section></main>`, 400);

        const alvoEnvio = conexao.tipo === 'facebook'
          ? `https://graph.facebook.com/v23.0/${conexao.igUserId}/messages`
          : `https://graph.instagram.com/v23.0/me/messages`;
        const r = await fetch(alvoEnvio, {
          method: 'POST',
          headers: { authorization: `Bearer ${conexao.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ recipient: { id: destinatario }, message: { text: texto } }),
        });
        const d = await r.json().catch(() => ({}));
        await registrar(env, r.ok ? 'envio_ok' : 'erro_envio', { destinatario, texto, status: r.status, resposta: d });
        return html(`<main><section><h2>${r.ok ? '<span class="ok">Enviado</span>' : '<span class="ruim">Não enviou</span>'}</h2>
          <pre>${esc(JSON.stringify({ status: r.status, resposta: d }, null, 2))}</pre>
          <p><a class="botao" href="./">Voltar ao painel</a></p></section></main>`);
      }

      if (rota === '/api-sistema') {
        const token = env.SYSTEM_USER_TOKEN || '';
        const igId = env.IG_BUSINESS_ID || '';
        const appToken = `${env.APP_ID}|${env.APP_SECRET}`;
        const pega = async (u) => { try { const r = await fetch(u); return { status: r.status, corpo: await r.json() }; } catch (e) { return { erro: String(e) }; } };
        const resultado = {
          temToken: Boolean(token),
          debug: token ? await pega(`https://graph.facebook.com/${VERSAO_FB}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`) : null,
          me: token ? await pega(`https://graph.facebook.com/${VERSAO_FB}/me?fields=id,name&access_token=${encodeURIComponent(token)}`) : null,
          paginas: token ? await pega(`https://graph.facebook.com/${VERSAO_FB}/me/accounts?fields=id,name,instagram_business_account&access_token=${encodeURIComponent(token)}`) : null,
          noInstagram: token && igId ? await pega(`https://graph.facebook.com/${VERSAO_FB}/${igId}?fields=id,username&access_token=${encodeURIComponent(token)}`) : null,
        };
        await registrar(env, 'teste_api_sistema', resultado);
        return json(resultado);
      }

      if (rota === '/saude') {
        const conexao = await lerConexao(env);
        const eventos = await lerEventos(env, 5);
        return json({
          ok: true, conectado: Boolean(conexao?.token), igUserId: conexao?.igUserId ?? '',
          expiraEm: conexao?.expiraEm ?? '', temAppSecret: Boolean(env.APP_SECRET),
          webhook: `${base}/webhook`, redirect: `${base}/oauth/callback`, ultimosEventos: eventos.length,
        });
      }
      if (rota === '/eventos') return json(await lerEventos(env, 200));
      if (rota === '/limpar') {
        const lista = await env.LAB.list({ prefix: 'ev:' });
        for (const k of lista.keys) await env.LAB.delete(k.name);
        await env.LAB.delete('conexao');
        return html(`<main><section><h2>Limpo</h2><p class="meta">Eventos e conexão apagados.</p><p><a class="botao" href="./">Voltar</a></p></section></main>`);
      }

      return json({ erro: 'rota não encontrada', rota, base }, 404);
    } catch (erro) {
      await registrar(env, 'erro_geral', { erro: String(erro) }).catch(() => {});
      return json({ erro: String(erro) }, 500);
    }
  },
};
