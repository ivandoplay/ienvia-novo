/**
 * Um "Supabase de mentira" para os testes de ponta a ponta.
 *
 * Os testes do painel não podem depender do banco de verdade (nem escrever nele).
 * Este servidor imita só o pedacinho do Supabase que o painel usa:
 *   - login, sessão e sair            (/auth/v1/...)
 *   - leitura simples de tabelas       (/rest/v1/<tabela>?coluna=eq.valor)
 *   - contagem de linhas               (HEAD + Prefer: count=exact)
 *
 * Ele respeita a regra mais importante do banco real: cada pessoa só enxerga as linhas
 * dos workspaces de que participa. As regras de verdade (RLS) são testadas à parte,
 * em supabase/tests, contra as migrações reais.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { PARTICIPACOES, SENHA_DE_TESTE, USUARIOS, WORKSPACES, criarTabelas } from './dados.mjs';

const PORTA = Number(process.env.PORTA_SUPABASE_FALSO ?? 54399);
const SEGREDO_JWT = 'segredo-so-para-testes';
const UMA_HORA = 3600;

const tabelas = criarTabelas();
/** token de acesso → id do usuário */
const sessoes = new Map();
/** token de renovação → id do usuário */
const renovacoes = new Map();

const base64url = (valor) => Buffer.from(valor).toString('base64url');

function criarJwt(usuario) {
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const corpo = base64url(
    JSON.stringify({
      sub: usuario.id,
      email: usuario.email,
      role: 'authenticated',
      aud: 'authenticated',
      iat: agora,
      exp: agora + UMA_HORA,
      session_id: crypto.randomUUID(),
    }),
  );
  const assinatura = crypto.createHmac('sha256', SEGREDO_JWT).update(`${cabecalho}.${corpo}`).digest('base64url');
  return `${cabecalho}.${corpo}.${assinatura}`;
}

function usuarioPublico(usuario) {
  return {
    id: usuario.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: usuario.email,
    email_confirmed_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function abrirSessao(usuario) {
  const access_token = criarJwt(usuario);
  const refresh_token = crypto.randomBytes(12).toString('hex');
  sessoes.set(access_token, usuario.id);
  renovacoes.set(refresh_token, usuario.id);
  return {
    access_token,
    token_type: 'bearer',
    expires_in: UMA_HORA,
    expires_at: Math.floor(Date.now() / 1000) + UMA_HORA,
    refresh_token,
    user: usuarioPublico(usuario),
  };
}

function usuarioDaRequisicao(req) {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const id = sessoes.get(token);
  return id ? USUARIOS.find((usuario) => usuario.id === id) : undefined;
}

function workspacesDoUsuario(usuario) {
  return PARTICIPACOES.filter((p) => p.user_id === usuario.id && p.status === 'active').map((p) => p.workspace_id);
}

/** Entende os filtros simples do PostgREST: eq, gte e is.null. */
function passaNoFiltro(linha, coluna, expressao) {
  const valor = linha[coluna];
  if (expressao.startsWith('eq.')) return String(valor) === expressao.slice(3);
  if (expressao.startsWith('gte.')) return String(valor) >= expressao.slice(4);
  if (expressao === 'is.null') return valor === null || valor === undefined;
  throw new Error(`Filtro não suportado pelo Supabase de mentira: ${coluna}=${expressao}`);
}

function lerCorpo(req) {
  return new Promise((resolve) => {
    let texto = '';
    req.on('data', (parte) => (texto += parte));
    req.on('end', () => {
      try {
        resolve(texto ? JSON.parse(texto) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function responder(res, status, corpo, cabecalhos = {}) {
  const texto = corpo === undefined ? '' : JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cabecalhos });
  res.end(texto);
}

const naoAutorizado = (res) => responder(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });

async function rotasDeLogin(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
    const corpo = await lerCorpo(req);
    const tipo = url.searchParams.get('grant_type');

    if (tipo === 'password') {
      const usuario = USUARIOS.find((u) => u.email === String(corpo.email ?? '').toLowerCase());
      if (!usuario || corpo.password !== SENHA_DE_TESTE) {
        return responder(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      return responder(res, 200, abrirSessao(usuario));
    }

    if (tipo === 'refresh_token') {
      const id = renovacoes.get(corpo.refresh_token);
      const usuario = USUARIOS.find((u) => u.id === id);
      if (!usuario) {
        return responder(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      }
      renovacoes.delete(corpo.refresh_token);
      return responder(res, 200, abrirSessao(usuario));
    }
  }

  if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
    const usuario = usuarioDaRequisicao(req);
    return usuario ? responder(res, 200, usuarioPublico(usuario)) : naoAutorizado(res);
  }

  if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    sessoes.delete(token);
    res.writeHead(204);
    return res.end();
  }

  return responder(res, 404, { msg: `Rota de login não imitada: ${req.method} ${url.pathname}` });
}

function rotasDeDados(req, res, url) {
  const usuario = usuarioDaRequisicao(req);
  if (!usuario) return naoAutorizado(res);
  const permitidos = workspacesDoUsuario(usuario);
  const recurso = url.pathname.replace('/rest/v1/', '');

  if (req.method === 'POST' && recurso === 'rpc/is_my_platform_master') {
    return responder(res, 200, usuario.master === true);
  }

  if (recurso === 'workspace_memberships') {
    const linhas = PARTICIPACOES.filter((p) => p.user_id === usuario.id && p.status === 'active').map((p) => ({
      role: p.role,
      workspaces: WORKSPACES.find((w) => w.id === p.workspace_id) ?? null,
    }));
    return responder(res, 200, linhas);
  }

  if (recurso === 'profiles') {
    const linhas = usuario.nome ? [{ display_name: usuario.nome }] : [];
    const querUmObjeto = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
    if (!querUmObjeto) return responder(res, 200, linhas);
    return linhas.length === 1
      ? responder(res, 200, linhas[0])
      : responder(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
  }

  const tabela = tabelas[recurso];
  if (!tabela) return responder(res, 404, { message: `Tabela não imitada: ${recurso}` });

  let linhas = tabela.filter((linha) => permitidos.includes(linha.workspace_id));
  try {
    for (const [coluna, expressao] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(coluna)) continue;
      linhas = linhas.filter((linha) => passaNoFiltro(linha, coluna, expressao));
    }
  } catch (erro) {
    return responder(res, 400, { message: erro.message });
  }

  const faixa = linhas.length === 0 ? `*/${linhas.length}` : `0-${linhas.length - 1}/${linhas.length}`;
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-range': faixa, 'content-type': 'application/json; charset=utf-8' });
    return res.end();
  }
  return responder(res, 200, linhas, { 'content-range': faixa });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (url.pathname === '/saude') return responder(res, 200, { ok: true });
    if (url.pathname.startsWith('/auth/v1/')) return await rotasDeLogin(req, res, url);
    if (url.pathname.startsWith('/rest/v1/')) return rotasDeDados(req, res, url);
    return responder(res, 404, { message: `Rota não imitada: ${req.method} ${url.pathname}` });
  } catch (erro) {
    console.error('[supabase de mentira] erro:', erro);
    return responder(res, 500, { message: String(erro) });
  }
});

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log(`Supabase de mentira ouvindo em http://127.0.0.1:${PORTA}`);
});
