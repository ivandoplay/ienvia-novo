/** Mede a área de mensagens da conversa aberta nas duas larguras. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
const out={};
for (const [nome, vp, extra] of [['desktop',{width:1440,height:900},{}],['celular',{width:390,height:844},{isMobile:true,hasTouch:true}]]) {
  const p=await (await b.newContext({viewport:vp,locale:'pt-BR',...extra})).newPage();
  await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  await p.goto(`${BASE}/inbox`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  await p.screenshot({path:`/home/user/ienvia/auditoria-visual/celular/${nome}-antes-abrir.png`});
  await p.locator('button, [role="button"], li, a').filter({hasText:'Lucas Martins'}).first().click(); await p.waitForTimeout(2500);
  out[nome] = await p.evaluate(`(() => {
    const alvos = [...document.querySelectorAll('main *')].filter(e => { const r=e.getBoundingClientRect(); return r.height>80 && r.width>150 && /Hoje|preciso falar|Claro, Lucas/.test(e.textContent||''); });
    const menor = alvos.sort((a,b)=>a.getBoundingClientRect().height-b.getBoundingClientRect().height)[0];
    const rolagem = [...document.querySelectorAll('main *')].filter(e => { const s=getComputedStyle(e); return ['auto','scroll'].includes(s.overflowY) && e.scrollHeight > e.clientHeight+5; })
      .map(e => ({ classe: String(e.className).slice(0,32), visivel: Math.round(e.clientHeight), total: Math.round(e.scrollHeight), topo: Math.round(e.getBoundingClientRect().top) }));
    return { rolagem, conversa: menor ? { classe: String(menor.className).slice(0,32), altura: Math.round(menor.getBoundingClientRect().height) } : null,
      dialogoAberto: !!document.querySelector('dialog[open]'), url: location.href };
  })()`);
  await p.screenshot({path:`/home/user/ienvia/auditoria-visual/celular/${nome}-conversa.png`});
}
console.log(JSON.stringify(out,null,1));
await b.close();
