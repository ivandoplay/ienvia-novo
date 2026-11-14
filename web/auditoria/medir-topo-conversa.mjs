import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { abrirConversa } from './abrir-conversa.mjs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
for (const [nome, vp, extra] of [['desktop',{width:1440,height:900},{}],['notebook',{width:1280,height:800},{}],['celular',{width:390,height:844},{isMobile:true,hasTouch:true,deviceScaleFactor:2}]]) {
  const p=await (await b.newContext({viewport:vp,locale:'pt-BR',...extra})).newPage();
  await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  await p.goto(`${BASE}/inbox`,{waitUntil:'networkidle'});
  const ok = await abrirConversa(p, 'Maria Santos');
  await p.waitForTimeout(1500);
  const m = await p.evaluate(`(() => {
    const topo=document.querySelector('.inbox-conversa-topo');
    const quem=document.querySelector('.inbox-conversa-quem');
    const h2=quem?.querySelector('h2'); const pEl=quem?.querySelector('p');
    const acoes=document.querySelector('.inbox-conversa-acoes');
    const r=(el)=>el?{w:Math.round(el.getBoundingClientRect().width),h:Math.round(el.getBoundingClientRect().height)}:null;
    return { abriu: !!topo, topo:r(topo), quem:r(quem), nome:r(h2), nomeTexto:h2?.textContent?.trim(),
      nomeCortado: h2 ? h2.scrollWidth > h2.clientWidth+1 : null,
      linhasDoTelefone: pEl ? Math.round(pEl.getBoundingClientRect().height / parseFloat(getComputedStyle(pEl).lineHeight||'16')) : null,
      acoes:r(acoes), primeiraLinhaTemAcoes: acoes ? Math.round(acoes.getBoundingClientRect().top) === Math.round(topo.getBoundingClientRect().top)+10 : null };
  })()`);
  console.log(`[${nome}] abriu=${ok}`, JSON.stringify(m));
  await p.screenshot({path:`/home/user/ienvia/auditoria-visual/conectado/${nome}-topo-conversa.png`});
}
await b.close();
