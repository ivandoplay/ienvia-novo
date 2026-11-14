import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
for (const base of ['http://127.0.0.1:3100']) {
  const p=await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
  await p.goto(`${base}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  await p.goto(`${base}/inbox`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  await p.getByRole('button',{name:/Nova conversa/i}).first().click(); await p.waitForTimeout(1500);
  const d = await p.locator('dialog').count();
  const aberto = d ? await p.locator('dialog').first().evaluate(el=>el.open) : null;
  const visivel = d ? await p.locator('dialog').first().isVisible() : null;
  console.log(`${base.includes('3100')?'PRODUÇÃO':'DESENVOLVIMENTO'} → dialog no DOM: ${d} · open: ${aberto} · visível: ${visivel}`);
  await p.close();
}
await b.close();
