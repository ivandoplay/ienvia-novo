import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='https://app.ienvia.online'; const SAIDA='/home/user/ienvia/auditoria-visual/celular';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const h={apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
const [contato] = await (await fetch(`${env.SUPABASE_URL}/rest/v1/contacts?select=id&workspace_id=eq.${env.TESTE_WORKSPACE}&display_name=eq.Maria%20Santos`,{headers:h})).json();
const [conv] = await (await fetch(`${env.SUPABASE_URL}/rest/v1/conversations?select=id&workspace_id=eq.${env.TESTE_WORKSPACE}&contact_id=eq.${contato.id}`,{headers:h})).json();
const b=await chromium.launch();
for (const [nome, vp, extra] of [['desktop',{width:1440,height:900},{}],['celular',{width:390,height:844},{isMobile:true,hasTouch:true,deviceScaleFactor:2}]]) {
  const p=await (await b.newContext({viewport:vp,locale:'pt-BR',...extra})).newPage();
  await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  await p.goto(`${BASE}/inbox?c=${conv.id}`,{waitUntil:'networkidle'}); await p.waitForTimeout(2500);
  const m = await p.evaluate(`(() => {
    const campo=document.querySelector('.inbox-escrever-campo');
    const linha=campo?.closest('.inbox-escrever-linha');
    const r=campo?.getBoundingClientRect(); const rl=linha?.getBoundingClientRect();
    const dica=document.querySelector('.inbox-escrever-dica');
    const acoes=document.querySelector('.inbox-conversa-acoes');
    return { campo: r?{w:Math.round(r.width),h:Math.round(r.height),base:Math.round(r.bottom)}:null,
      linha: rl?{h:Math.round(rl.height),base:Math.round(rl.bottom)}:null,
      dicaTopo: dica?Math.round(dica.getBoundingClientRect().top):null,
      campoNaTela: r ? r.bottom <= window.innerHeight+1 : null,
      acoesAltura: acoes?Math.round(acoes.getBoundingClientRect().height):null,
      rolagemLateral: document.documentElement.scrollWidth - window.innerWidth };
  })()`);
  console.log(`[${nome}]`, JSON.stringify(m));
  await p.screenshot({path:`${SAIDA}/${nome}-conversa-conectada.png`});
}
await b.close();
