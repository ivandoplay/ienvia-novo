import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
for (const [nome, vp, extra] of [['desktop',{width:1440,height:900},{}],['celular',{width:390,height:844},{isMobile:true,hasTouch:true,deviceScaleFactor:2}]]) {
  const p=await (await b.newContext({viewport:vp,locale:'pt-BR',...extra})).newPage();
  await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  await p.goto(`${BASE}/visao-geral`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  const m = await p.evaluate(`(() => { const el=document.querySelector('.status-pill > span:last-child'); if(!el) return null;
    return { texto: el.textContent, cortado: el.scrollWidth > el.clientWidth+1, precisa: el.scrollWidth, tem: el.clientWidth }; })()`);
  console.log(`[${nome}]`, JSON.stringify(m));
  await p.screenshot({path:`/home/user/ienvia/auditoria-visual/conectado/${nome}-topo-pilula.png`});
}
await b.close();
