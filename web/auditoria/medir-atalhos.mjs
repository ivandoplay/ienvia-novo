import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})).newPage();
await p.goto('http://127.0.0.1:3100/login',{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
await p.goto('http://127.0.0.1:3100/inbox',{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
const r = await p.evaluate(`(() => {
  const topo=document.querySelector('.inbox-crm-topo');
  const acoes=document.querySelector('.inbox-crm-acoes');
  const abas=document.querySelector('.crm-abas');
  const btns=[...(acoes?.querySelectorAll('.btn')||[])];
  const g=(el)=>{const r=el.getBoundingClientRect(); return {x:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height),overflow:getComputedStyle(el).overflow,ws:getComputedStyle(el).whiteSpace,larguraTexto:Math.round(el.scrollWidth)}};
  return {topo:g(topo), abas:g(abas), acoes:g(acoes), botoes:btns.map(el=>({txt:el.textContent.trim().slice(0,20),...g(el)}))};
})()`);
console.log(JSON.stringify(r,null,1));
await b.close();
