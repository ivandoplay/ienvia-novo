import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100'; const SAIDA='/home/user/ienvia/auditoria-visual/celular'; mkdirSync(SAIDA,{recursive:true});
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:390,height:844},locale:'pt-BR',isMobile:true,hasTouch:true,deviceScaleFactor:2})).newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
for (const rota of ['/visao-geral','/inbox','/instancias','/treinamento','/configuracoes']) {
  await p.goto(`${BASE}${rota}`,{waitUntil:'networkidle'}); await p.waitForTimeout(1300);
  const n = rota.replace('/','');
  await p.screenshot({path:`${SAIDA}/${n}-topo.png`});
  await p.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)'); await p.waitForTimeout(700);
  await p.screenshot({path:`${SAIDA}/${n}-fim.png`});
  const v = await p.evaluate(`(() => { const nm=document.querySelector('.nav-menu'); const s=nm?getComputedStyle(nm):null;
    return { navMenuDisplay: s?.display, navMenuVisivel: nm ? nm.getBoundingClientRect().width>0 && getComputedStyle(nm).visibility!=='hidden' : null }; })()`);
  console.log(`${rota.padEnd(18)} menu lateral: display=${v.navMenuDisplay} visível=${v.navMenuVisivel}`);
}
await b.close();
