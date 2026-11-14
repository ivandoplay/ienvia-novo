/**
 * 1) o relógio da Visão geral aparece depois de 20s ou fica travado em --:--?
 * 2) quem come a largura do campo de escrever da Inbox, botão por botão?
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3000';
const env = Object.fromEntries(
  readFileSync('/home/user/.env', 'utf8').split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const navegador = await chromium.launch();
const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
const pagina = await contexto.newPage();

await pagina.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await pagina.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await pagina.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await pagina.getByRole('button', { name: /entrar|acessar/i }).first().click();
await pagina.waitForTimeout(2000);

// ---- 1) relógio ----
await pagina.goto(`${BASE}/visao-geral`, { waitUntil: 'networkidle' });
const amostras = [];
for (const espera of [0, 5_000, 10_000, 15_000, 25_000, 35_000]) {
  if (espera) await pagina.waitForTimeout(espera - (amostras.at(-1)?.em ?? 0));
  amostras.push({ em: espera, texto: (await pagina.locator('.visao-relogio').innerText().catch(() => '(sumiu)')).trim() });
}
console.log('\n=== relógio da Visão geral ===');
for (const a of amostras) console.log(` ${String(a.em / 1000).padStart(3)}s → "${a.texto}"`);

// ---- 2) composer ----
await pagina.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
await pagina.waitForTimeout(1200);
await pagina.locator('button, [role="button"], li, a').filter({ hasText: 'Lucas Martins' }).first().click();
await pagina.waitForTimeout(1500);

const detalhe = await pagina.evaluate(`(() => {
  const linha = document.querySelector('.inbox-escrever-linha');
  const filhos = [...linha.children].map((el) => {
    const r = el.getBoundingClientRect();
    const rotulo = el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24) || el.tagName;
    return { rotulo, tag: el.tagName.toLowerCase(), largura: Math.round(r.width), altura: Math.round(r.height), flex: getComputedStyle(el).flex };
  });
  const r = linha.getBoundingClientRect();
  const coluna = document.querySelector('.inbox-conversa')?.getBoundingClientRect();
  return {
    larguraDaLinha: Math.round(r.width),
    larguraDaColuna: coluna ? Math.round(coluna.width) : null,
    filhos,
    somaDasLarguras: filhos.reduce((s, f) => s + f.largura, 0),
  };
})()`);
console.log('\n=== composer da Inbox (largura por item) ===');
console.log(` linha ${detalhe.larguraDaLinha}px · coluna ${detalhe.larguraDaColuna}px · soma dos itens ${detalhe.somaDasLarguras}px`);
for (const f of detalhe.filhos) {
  const marca = f.tag === 'textarea' ? '  ← CAMPO' : '';
  console.log(`  ${String(f.largura).padStart(4)}px  ${f.tag.padEnd(8)} ${String(f.rotulo).slice(0, 34)}${marca}`);
}

await navegador.close();
