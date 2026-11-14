import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100'; const SAIDA='/home/user/ienvia/auditoria-visual/conectado';
import { mkdirSync } from 'node:fs'; mkdirSync(SAIDA,{recursive:true});
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
for (const [nome, vp, extra] of [['desktop',{width:1440,height:900},{}],['celular',{width:390,height:844},{isMobile:true,hasTouch:true,deviceScaleFactor:2}]]) {
  const p=await (await b.newContext({viewport:vp,locale:'pt-BR',...extra})).newPage();
  await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  await p.goto(`${BASE}/inbox`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  await p.locator('button, [role="button"], li, a').filter({hasText:'Maria Santos'}).first().click(); await p.waitForTimeout(2500);
  await p.screenshot({path:`${SAIDA}/${nome}-conversa.png`});
  const m = await p.evaluate(`(() => {
    const campo=document.querySelector('.inbox-escrever-campo'); const enviar=[...document.querySelectorAll('button')].find(b=>/enviar/i.test(b.textContent));
    const r=campo?.getBoundingClientRect();
    return { campo: r?{largura:Math.round(r.width),altura:Math.round(r.height),visivel:r.bottom<window.innerHeight+1}:null,
      enviarVisivel: enviar? enviar.getBoundingClientRect().height>0 : null,
      botaoEnviarTxt: enviar?.textContent.trim().slice(0,20),
      avisoChipDesconectado: /desconectad/i.test(document.querySelector('main')?.innerText||''),
      bolhas: [...document.querySelectorAll('[class*="inbox-balao"]')].filter(e=>e.getBoundingClientRect().height>20 && !e.querySelector('[class*="inbox-balao"]')).length };
  })()`);
  console.log(`[${nome}]`, JSON.stringify(m));
}
await b.close();
