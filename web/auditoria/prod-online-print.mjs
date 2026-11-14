import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='https://app.ienvia.online';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,locale:'pt-BR'})).newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(3000);
await p.goto(`${BASE}/inbox`,{waitUntil:'networkidle'}); await p.waitForTimeout(2000);
await p.screenshot({path:'/home/user/ienvia/auditoria-visual/final/online-celular-inbox.png'});
const m = await p.evaluate(`(() => ({ pilula:[...document.querySelectorAll('.status-pill > span:last-child')].map(e=>({t:e.textContent,cortado:e.scrollWidth>e.clientWidth+1})),
  etiquetas:[...document.querySelectorAll('.inbox-crm-acoes .btn')].map(e=>e.innerText),
  conversas: document.querySelectorAll('[class*="conversa-linha"], li').length }))()`);
console.log(JSON.stringify(m));
await b.close();
