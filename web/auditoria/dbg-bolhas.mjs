import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1440,height:900},locale:'pt-BR'})).newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
await p.goto(`${BASE}/inbox`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
const linhas = await p.evaluate(()=>[...document.querySelectorAll('.inbox-conversa-linha, [class*="conversa-linha"], li')].slice(0,8).map(e=>e.textContent.replace(/\s+/g,' ').trim().slice(0,60)));
console.log('linhas da lista:', JSON.stringify(linhas.slice(0,6),null,1));
// clica em Maria Santos
await p.locator('button, [role="button"], li, a').filter({hasText:'Maria Santos'}).first().click(); await p.waitForTimeout(2500);
console.log('bolhas:', await p.evaluate(()=>[...document.querySelectorAll('[class*="balao"]')].filter(e=>e.getBoundingClientRect().height>10).map(e=>e.textContent.replace(/\s+/g,' ').trim().slice(0,45))));
await b.close();
