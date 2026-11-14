import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
p.on('pageerror', e=>console.log('pageerror:', e.message));
await p.goto('http://127.0.0.1:3000/login',{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
await p.goto('http://127.0.0.1:3000/inbox',{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
await p.getByRole('button',{name:/Nova conversa/i}).first().click(); await p.waitForTimeout(2500);
const info = await p.evaluate(()=>{ const d=document.querySelector('dialog'); if(!d) return {semDialogo:true};
  return { open: d.open, pai: d.parentElement?.tagName, irmaos: d.parentElement?.children.length,
    display: getComputedStyle(d).display, visibility: getComputedStyle(d).visibility, rect: (r=>({w:Math.round(r.width),h:Math.round(r.height)}))(d.getBoundingClientRect()) }; });
console.log(JSON.stringify(info));
await b.close();
