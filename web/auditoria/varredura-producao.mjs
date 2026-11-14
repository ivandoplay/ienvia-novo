/** Varredura contra o build de produção (next start), que é o que o cliente usa. */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3100';
const SAIDA = '/home/user/ienvia/auditoria-visual/producao';
mkdirSync(SAIDA, { recursive: true });

const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));

const TELAS = ['/visao-geral','/inbox','/conexoes','/instancias','/campanhas','/catalogo','/treinamento','/inteligencia-artificial','/audios','/simulador','/seguranca','/configuracoes','/contas'];

const problemas = [];
const anotar = (tela, tipo, detalhe) => { problemas.push({ tela, tipo, detalhe }); console.log(`   ⚠ [${tela}] ${tipo}: ${String(detalhe).slice(0,200)}`); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
const p = await ctx.newPage();
const erros = [];
p.on('pageerror', e => erros.push(`pageerror ${e.message}`));
p.on('console', m => { if (m.type()==='error') erros.push(m.text()); });
p.on('response', r => { if (r.status()>=500) erros.push(`HTTP ${r.status()} ${r.url().replace(BASE,'').slice(0,120)}`); });

await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button', { name: /entrar|acessar/i }).first().click();
await p.waitForTimeout(2500);

for (const rota of TELAS) {
  erros.length = 0;
  const nome = rota.replace('/','');
  await p.goto(`${BASE}${rota}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  // fullPage falha em página muito alta neste Chromium; a dobra basta para ver o corte, e a rolagem é medida.
  await p.screenshot({ path: `${SAIDA}/${nome}.png` }).catch((e) => console.log(`   (print falhou em ${rota}: ${String(e).slice(0, 60)})`));
  const m = await p.evaluate(`(() => {
    const d = document.documentElement;
    const janela = window.innerWidth;
    const fora = [...document.querySelectorAll('main *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > janela + 2 || r.left < -2);
    }).slice(0,5).map(el => (el.textContent||'').trim().slice(0,40));
    const campo = document.querySelector('.inbox-escrever-campo');
    return { estouro: d.scrollWidth - janela, fora, altura: d.scrollHeight, campo: campo ? Math.round(campo.getBoundingClientRect().width) : null };
  })()`);
  const texto = (await p.locator('main').innerText()).replace(/\s+/g,' ').slice(0, 70);
  console.log(`${rota.padEnd(26)} ${String(m.altura).padStart(4)}px · estouro ${m.estouro}px · ${texto}`);
  if (m.estouro > 2) anotar(nome, 'rolagem lateral', `${m.estouro}px`);
  if (m.fora.length) anotar(nome, 'elemento fora da tela', m.fora.join(' | '));
  for (const e of [...new Set(erros)]) anotar(nome, 'erro', e.slice(0,200));
}

// celular
await p.setViewportSize({ width: 390, height: 844 });
for (const rota of ['/visao-geral','/inbox','/instancias','/treinamento']) {
  await p.goto(`${BASE}${rota}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);
  await p.locator('button, [role="button"], li, a').filter({ hasText: '+' }).first().count();
  await p.screenshot({ path: `${SAIDA}/celular-${rota.replace('/','')}.png` }).catch(() => {});
}

writeFileSync(`${SAIDA}/relatorio.json`, JSON.stringify(problemas, null, 2));
console.log(`\n${problemas.length} problemas registrados`);
await b.close();
