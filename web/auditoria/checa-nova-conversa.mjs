import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
await p.goto(`${BASE}/inbox`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
await p.getByRole('button',{name:/Nova conversa/i}).first().click(); await p.waitForTimeout(1500);
const dial = await p.locator('[role="dialog"]').count();
console.log('diálogos abertos:', dial);
if (dial) {
  console.log('título:', (await p.locator('[role="dialog"]').first().innerText()).slice(0,160).replace(/\n/g,' | '));
}
await p.screenshot({path:'/home/user/ienvia/auditoria-visual/inbox/08-nova-conversa.png'});
// as abas
for (const aba of ['Contatos','Kanban']) {
  const link = p.getByRole('link',{name:new RegExp(aba,'i')}).first();
  console.log(`aba ${aba}: links encontrados = ${await link.count()}`);
  if (await link.count()) { await link.click(); await p.waitForTimeout(1500); console.log(`  url: ${p.url().replace(BASE,'')} · texto: ${(await p.locator('main').innerText()).replace(/\s+/g,' ').slice(0,80)}`); await p.screenshot({path:`/home/user/ienvia/auditoria-visual/inbox/09-aba-${aba.toLowerCase()}.png`}); }
}
await b.close();
