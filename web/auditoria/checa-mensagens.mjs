import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
for (const [nome, vp, extra] of [['desktop',{width:1440,height:900},{}],['celular',{width:390,height:844},{isMobile:true,hasTouch:true}]]) {
  const p=await (await b.newContext({viewport:vp,locale:'pt-BR',...extra})).newPage();
  await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  await p.goto(`${BASE}/inbox`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  await p.locator('button, [role="button"], li, a').filter({hasText:'Lucas Martins'}).first().click(); await p.waitForTimeout(2500);
  const m = await p.evaluate(`(() => {
    const classes = ['mensagem','inbox-mensagem','balao','inbox-balao'];
    const bolhas = [...document.querySelectorAll('[class*="mensagem"], [class*="balao"]')].filter(e => e.getBoundingClientRect().height > 10);
    const rolagem = [...document.querySelectorAll('main *')].filter(e => { const s=getComputedStyle(e); return ['auto','scroll'].includes(s.overflowY) && e.scrollHeight > e.clientHeight + 5; })
      .map(e => ({ classe: String(e.className).slice(0,30), alturaVisivel: Math.round(e.clientHeight), alturaTotal: Math.round(e.scrollHeight), scrollTop: Math.round(e.scrollTop) }));
    return { bolhas: bolhas.length, primeira: bolhas[0]?.textContent?.trim().slice(0,40), ultima: bolhas.at(-1)?.textContent?.trim().slice(0,40), areasComRolagem: rolagem };
  })()`);
  console.log(`\n[${nome}] bolhas na tela: ${m.bolhas}`);
  console.log(`  primeira: "${m.primeira}" · última: "${m.ultima}"`);
  console.log('  áreas com rolagem:', JSON.stringify(m.areasComRolagem));
}
await b.close();
