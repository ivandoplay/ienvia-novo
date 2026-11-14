import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const h={apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
const contatos = await (await fetch(`${env.SUPABASE_URL}/rest/v1/contacts?select=id,display_name&workspace_id=eq.${env.TESTE_WORKSPACE}&display_name=eq.Maria%20Santos`,{headers:h})).json();
const cid = contatos[0].id;
const convs = await (await fetch(`${env.SUPABASE_URL}/rest/v1/conversations?select=id&workspace_id=eq.${env.TESTE_WORKSPACE}&contact_id=eq.${cid}`,{headers:h})).json();
const conversa = convs[0].id;
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,locale:'pt-BR'})).newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
await p.goto(`${BASE}/inbox?c=${conversa}`,{waitUntil:'networkidle'}); await p.waitForTimeout(2500);
await p.screenshot({path:'/home/user/ienvia/auditoria-visual/celular/inbox-conversa-direta.png'});
const m = await p.evaluate(`(() => {
  const topo=document.querySelector('.inbox-conversa-topo'); const quem=document.querySelector('.inbox-conversa-quem');
  const h2=quem?.querySelector('h2');
  return { temTopo: !!topo, topoAltura: topo?Math.round(topo.getBoundingClientRect().height):null,
    nome: h2?.textContent?.trim(), nomeCortado: h2? h2.scrollWidth>h2.clientWidth+1 : null,
    rolagemLateral: document.documentElement.scrollWidth - window.innerWidth };
})()`);
console.log(JSON.stringify(m));
await b.close();
