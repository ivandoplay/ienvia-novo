/**
 * Varredura visual do painel: entra com o usuário de teste, abre cada tela,
 * tira print (desktop e celular) e coleta erros de console, de página e de requisição.
 *
 * Rodar:  node auditoria/login-e-varredura.mjs [--so=inbox] [--sem-semear]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const SAIDA = '/home/user/ienvia/auditoria-visual';

// credenciais de teste vêm do .env da raiz do workspace
const env = Object.fromEntries(
  readFileSync('/home/user/.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const USUARIO = env.TESTE_USUARIO;
const SENHA = env.TESTE_SENHA;

const TELAS = [
  { rota: '/visao-geral', nome: 'visao-geral', titulo: 'Visão geral' },
  { rota: '/inbox', nome: 'inbox', titulo: 'Inbox / conversas' },
  { rota: '/conexoes', nome: 'conexoes', titulo: 'Conexões' },
  { rota: '/instancias', nome: 'instancias', titulo: 'Instâncias' },
  { rota: '/campanhas', nome: 'campanhas', titulo: 'Campanhas' },
  { rota: '/catalogo', nome: 'catalogo', titulo: 'Catálogo' },
  { rota: '/treinamento', nome: 'treinamento', titulo: 'Treinamento' },
  { rota: '/inteligencia-artificial', nome: 'ia', titulo: 'Inteligência artificial' },
  { rota: '/crm', nome: 'crm', titulo: 'CRM' },
  { rota: '/audios', nome: 'audios', titulo: 'Áudios' },
  { rota: '/simulador', nome: 'simulador', titulo: 'Simulador' },
  { rota: '/seguranca', nome: 'seguranca', titulo: 'Segurança' },
  { rota: '/configuracoes', nome: 'configuracoes', titulo: 'Configurações' },
  { rota: '/contas', nome: 'contas', titulo: 'Contas' },
];

const argumentos = process.argv.slice(2);
const so = argumentos.find((a) => a.startsWith('--so='))?.split('=')[1];

mkdirSync(SAIDA, { recursive: true });

const problemas = [];
const registrar = (tela, tipo, detalhe) => {
  problemas.push({ tela, tipo, detalhe: String(detalhe).slice(0, 800) });
  console.log(`   ⚠ ${tipo}: ${String(detalhe).slice(0, 200)}`);
};

/** Detecta o que o olho humano chamaria de "quebrado": conteúdo cortado, rolagem lateral, elemento vazando. */
const MEDIDAS = `(() => {
  const doc = document.documentElement;
  const larguraJanela = window.innerWidth;
  const estourou = doc.scrollWidth - larguraJanela;

  // elementos que passam da borda direita ou ficam com largura zero onde deveriam ter conteúdo
  const culpados = [];
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > larguraJanela + 2 || r.left < -2) {
      const texto = (el.textContent || '').trim().slice(0, 60);
      if (texto) culpados.push({ tag: el.tagName.toLowerCase(), classe: String(el.className).slice(0, 80), texto, left: Math.round(r.left), right: Math.round(r.right) });
    }
  }

  // texto cortado por altura fixa
  const cortados = [];
  for (const el of document.querySelectorAll('main *')) {
    const s = getComputedStyle(el);
    if (s.overflow === 'hidden' && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 0) {
      const texto = (el.textContent || '').trim().slice(0, 60);
      if (texto) cortados.push({ tag: el.tagName.toLowerCase(), classe: String(el.className).slice(0, 80), texto, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    }
  }

  return {
    estourou,
    larguraDocumento: doc.scrollWidth,
    larguraJanela,
    culpados: culpados.slice(0, 8),
    cortados: cortados.slice(0, 8),
    alturaDocumento: doc.scrollHeight,
  };
})()`;

async function main() {
  const navegador = await chromium.launch();
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
  const pagina = await contexto.newPage();

  const errosDaPagina = [];
  pagina.on('console', (m) => { if (m.type() === 'error') errosDaPagina.push(m.text()); });
  pagina.on('pageerror', (e) => errosDaPagina.push(`pageerror: ${e.message}`));
  pagina.on('requestfailed', (r) => {
    const url = r.url();
    if (url.startsWith(BASE) || url.includes('supabase')) {
      errosDaPagina.push(`requestfailed ${r.method()} ${url.replace(BASE, '')} → ${r.failure()?.errorText}`);
    }
  });
  pagina.on('response', async (r) => {
    if (r.status() >= 500 && (r.url().startsWith(BASE) || r.url().includes('supabase'))) {
      errosDaPagina.push(`HTTP ${r.status()} ${r.url().replace(BASE, '').slice(0, 120)}`);
    }
  });

  // ---------- login ----------
  console.log('→ login');
  await pagina.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await pagina.screenshot({ path: `${SAIDA}/00-login.png` });

  const campoUsuario = pagina.getByLabel(/usuário|usuario|e-mail|email/i).first();
  const campoSenha = pagina.getByLabel(/senha/i).first();
  await campoUsuario.fill(USUARIO);
  await campoSenha.fill(SENHA);
  await pagina.getByRole('button', { name: /entrar|acessar/i }).first().click();
  await pagina.waitForTimeout(3000);
  await pagina.screenshot({ path: `${SAIDA}/01-depois-do-login.png` });

  const urlAtual = pagina.url();
  console.log(`   caiu em: ${urlAtual.replace(BASE, '')}`);
  if (urlAtual.includes('/login')) {
    registrar('login', 'bloqueio', 'não saiu da tela de login — não foi possível auditar as outras telas');
    writeFileSync(`${SAIDA}/relatorio.json`, JSON.stringify({ problemas, errosDaPagina }, null, 2));
    await navegador.close();
    return;
  }

  // ---------- varredura ----------
  const telas = so ? TELAS.filter((t) => t.nome === so || t.rota === `/${so}`) : TELAS;

  for (const [indice, tela] of telas.entries()) {
    errosDaPagina.length = 0;
    console.log(`→ ${tela.titulo} (${tela.rota})`);
    const inicio = Date.now();
    try {
      await pagina.goto(`${BASE}${tela.rota}`, { waitUntil: 'networkidle', timeout: 45000 });
    } catch (e) {
      registrar(tela.nome, 'não carregou', String(e).slice(0, 200));
      continue;
    }
    await pagina.waitForTimeout(1500);
    const duracao = Date.now() - inicio;

    await pagina.screenshot({ path: `${SAIDA}/${String(indice + 2).padStart(2, '0')}-${tela.nome}.png`, fullPage: true });
    await pagina.screenshot({ path: `${SAIDA}/${String(indice + 2).padStart(2, '0')}-${tela.nome}-dobra.png` });

    const medidas = await pagina.evaluate(MEDIDAS);
    const texto = (await pagina.locator('main').innerText().catch(() => '')).slice(0, 400);

    if (medidas.estourou > 2) registrar(tela.nome, 'rolagem lateral', `${medidas.estourou}px além da janela (documento ${medidas.larguraDocumento}px em janela de ${medidas.larguraJanela}px)`);
    for (const c of medidas.culpados) registrar(tela.nome, 'elemento fora da tela', `${c.tag}.${c.classe} [${c.left}..${c.right}] "${c.texto}"`);
    for (const c of medidas.cortados) registrar(tela.nome, 'texto cortado', `${c.tag}.${c.classe} "${c.texto}" (${c.scrollHeight}px em caixa de ${c.clientHeight}px)`);
    for (const e of [...new Set(errosDaPagina)]) registrar(tela.nome, 'erro de console/rede', e);

    console.log(`   ${duracao}ms · ${medidas.alturaDocumento}px de altura · ${texto.replace(/\s+/g, ' ').slice(0, 90)}…`);

    // versão celular
    await pagina.setViewportSize({ width: 390, height: 844 });
    await pagina.waitForTimeout(800);
    await pagina.screenshot({ path: `${SAIDA}/${String(indice + 2).padStart(2, '0')}-${tela.nome}-celular.png`, fullPage: true });
    const medidasCelular = await pagina.evaluate(MEDIDAS);
    if (medidasCelular.estourou > 2) registrar(tela.nome, 'rolagem lateral no celular', `${medidasCelular.estourou}px além da janela`);
    await pagina.setViewportSize({ width: 1440, height: 900 });
  }

  writeFileSync(`${SAIDA}/relatorio.json`, JSON.stringify({ problemas, telas: telas.map((t) => t.rota) }, null, 2));
  console.log(`\n${problemas.length} problemas registrados em ${SAIDA}/relatorio.json`);
  await navegador.close();
}

main().catch((e) => { console.error('falhou:', e); process.exit(1); });
