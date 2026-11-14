/**
 * Testa o que o usuário relatou: clicar numa conversa e ver o conteúdo.
 * Também percorre as abas do Inbox e os botões principais, registrando o que quebra.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3100';
const SAIDA = '/home/user/ienvia/auditoria-visual/inbox';

const env = Object.fromEntries(
  readFileSync('/home/user/.env', 'utf8').split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

mkdirSync(SAIDA, { recursive: true });

const problemas = [];
const anotar = (o_que, detalhe) => {
  problemas.push({ o_que, detalhe: String(detalhe).slice(0, 600) });
  console.log(` ⚠ ${o_que}: ${String(detalhe).slice(0, 220)}`);
};

const navegador = await chromium.launch();
const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
const pagina = await contexto.newPage();

const erros = [];
pagina.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('hmr')) erros.push(m.text()); });
pagina.on('pageerror', (e) => erros.push(`pageerror: ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`));
pagina.on('response', (r) => {
  if (r.status() >= 500) erros.push(`HTTP ${r.status()} ${r.url().replace(BASE, '').slice(0, 140)}`);
});

// login
await pagina.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await pagina.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await pagina.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await pagina.getByRole('button', { name: /entrar|acessar/i }).first().click();
await pagina.waitForTimeout(2500);

// inbox
await pagina.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
await pagina.waitForTimeout(1500);
await pagina.screenshot({ path: `${SAIDA}/00-lista.png` });

// ---- clicar na primeira conversa ----
console.log('→ clicando na primeira conversa');
const primeira = pagina.locator('button, [role="button"], li, a').filter({ hasText: 'Lucas Martins' }).first();
const existe = await primeira.count();
if (existe === 0) {
  anotar('conversa não encontrada', 'a lista não tem o item "Lucas Martins"');
} else {
  await primeira.click();
  await pagina.waitForTimeout(2500);
  await pagina.screenshot({ path: `${SAIDA}/01-conversa-aberta.png` });

  const painel = await pagina.locator('main').innerText();
  const abriu = /Lucas Martins/.test(painel) && (await pagina.locator('main').innerText()).length > 300;
  const temBalao = /preciso falar com um humano/i.test(painel);
  console.log(`   abriu? ${abriu} · conteúdo da conversa visível? ${temBalao}`);
  if (!temBalao) anotar('conversa não carrega', 'clicou na conversa e as mensagens não apareceram');

  const medidas = await pagina.evaluate(`(() => {
    const main = document.querySelector('main');
    const r = main.getBoundingClientRect();
    const vazio = [...main.querySelectorAll('*')].filter(e => e.textContent.trim() === 'Selecione uma conversa');
    return { largura: Math.round(r.width), altura: Math.round(r.height), aindaMostraVazio: vazio.length > 0 };
  })()`);
  if (medidas.aindaMostraVazio) anotar('painel não trocou', 'a conversa foi clicada mas o painel continua em "Selecione uma conversa"');

  // tentar digitar e enviar
  const caixa = pagina.locator('textarea, [contenteditable="true"], input[placeholder*="mensagem" i]').first();
  if (await caixa.count()) {
    await caixa.fill('Teste de auditoria');
    await pagina.screenshot({ path: `${SAIDA}/02-antes-de-enviar.png` });
    const enviar = pagina.getByRole('button', { name: /enviar/i }).first();
    if (await enviar.count()) {
      const visivel = await enviar.isVisible().catch(() => false);
      console.log(`   botão enviar visível? ${visivel}`);
      if (!visivel) anotar('botão enviar escondido', 'com texto digitado, o botão de enviar não fica visível');
    } else anotar('sem botão enviar', 'não encontrei botão de enviar na conversa');
  } else anotar('sem campo de mensagem', 'a conversa aberta não tem campo para escrever');
}

// ---- abas do inbox (são links ?aba=…, não botões) ----
for (const [aba, url] of [['Contatos', '?aba=contatos'], ['Kanban', '?aba=kanban']]) {
  console.log(`→ aba ${aba}`);
  await pagina.evaluate(`(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); })()`).catch(() => {});
  await pagina.goto(`${BASE}/inbox${url}`, { waitUntil: 'networkidle' });
  await pagina.waitForTimeout(1500);
  const nome = aba.toLowerCase().replace(/[^a-z]/g, '');
  await pagina.screenshot({ path: `${SAIDA}/03-aba-${nome}.png` });
  const texto = (await pagina.locator('main').innerText()).trim();
  const achou = new RegExp(aba, 'i').test(texto);
  console.log(`   renderizou? ${texto.length > 200} · cita "${aba}"? ${achou} · ${texto.length} caracteres`);
  if (texto.length < 200) anotar(`aba ${aba} vazia`, `a tela ficou com ${texto.length} caracteres`);
}

// ---- botão Nova conversa ----
console.log('→ Nova conversa');
const nova = pagina.getByRole('button', { name: /nova conversa/i }).first();
if (await nova.count()) {
  await pagina.evaluate(`(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); })()`).catch(() => {});
  await nova.scrollIntoViewIfNeeded().catch(() => {});
  await nova.click({ force: true });
  await pagina.waitForTimeout(1200);
  await pagina.screenshot({ path: `${SAIDA}/04-nova-conversa.png` });
  const nativo = pagina.locator('dialog[open]');
  const dialogo = await nativo.count();
  if (dialogo === 0) anotar('Nova conversa', 'clicou e nada abriu (nenhum diálogo na tela)');
  else {
    const titulo = (await nativo.first().innerText()).split('\n')[0];
    console.log(`   ✓ diálogo nativo aberto: "${titulo}"`);
    await nativo.first().getByRole('button', { name: /fechar/i }).first().click();
    await pagina.waitForTimeout(500);
  }
}

// ---- versão celular da conversa ----
await pagina.setViewportSize({ width: 390, height: 844 });
await pagina.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
await pagina.waitForTimeout(1200);
await pagina.screenshot({ path: `${SAIDA}/05-celular-lista.png`, fullPage: true });
const primeiraCelular = pagina.locator('button, [role="button"], li, a').filter({ hasText: 'Lucas Martins' }).first();
if (await primeiraCelular.count()) {
  await primeiraCelular.click();
  await pagina.waitForTimeout(1500);
  await pagina.screenshot({ path: `${SAIDA}/06-celular-conversa.png`, fullPage: true });
}

writeFileSync(`${SAIDA}/relatorio.json`, JSON.stringify({ problemas, erros: [...new Set(erros)] }, null, 2));
console.log(`\n${problemas.length} problemas · ${[...new Set(erros)].length} erros de runtime`);
for (const e of [...new Set(erros)].slice(0, 8)) console.log('   ·', e.split('\n')[0].slice(0, 200));
await navegador.close();
