import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:390,height:844},locale:'pt-BR'});
const p=await c.newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2000);
await p.goto(`${BASE}/inbox`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
await p.locator('button,[role="button"],li,a').filter({hasText:'Lucas Martins'}).first().click(); await p.waitForTimeout(1500);
await p.screenshot({path:'/home/user/ienvia/auditoria-visual/inbox/07-celular-composer-corrigido.png'});
const m = await p.evaluate(`(() => { const t=document.querySelector('.inbox-escrever-campo').getBoundingClientRect();
 return {campo:Math.round(t.width), topo:Math.round(t.top), base:Math.round(t.bottom), janela:window.innerHeight,
  dica: (()=>{const d=document.querySelector('.inbox-escrever-dica')?.getBoundingClientRect(); return d?{topo:Math.round(d.top),base:Math.round(d.bottom)}:null})(),
  linha: (()=>{const l=document.querySelector('.inbox-escrever-linha')?.getBoundingClientRect(); return l?{altura:Math.round(l.height),base:Math.round(l.bottom)}:null})()}; })()`);
console.log(JSON.stringify(m,null,1));
await b.close();
