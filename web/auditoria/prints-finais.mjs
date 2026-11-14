/** Gera os prints "antes/depois" finais de cada tela, com o workspace de teste conectado. */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100'; const SAIDA='/home/user/ienvia/auditoria-visual/final'; mkdirSync(SAIDA,{recursive:true});
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const h={apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
const [contato] = await (await fetch(`${env.SUPABASE_URL}/rest/v1/contacts?select=id&workspace_id=eq.${env.TESTE_WORKSPACE}&display_name=eq.Maria%20Santos`,{headers:h})).json();
const [conv] = await (await fetch(`${env.SUPABASE_URL}/rest/v1/conversations?select=id&workspace_id=eq.${env.TESTE_WORKSPACE}&contact_id=eq.${contato.id}`,{headers:h})).json();

const b=await chromium.launch();
const telas = [
  ['visao-geral','/visao-geral',null],
  ['inbox-lista','/inbox',null],
  ['inbox-conversa','/inbox', conv.id],
  ['instancias','/instancias',null],
  ['treinamento','/treinamento',null],
  ['configuracoes','/configuracoes',null],
];
for (const [nome, vp, extra] of [['desktop',{width:1440,height:900},{}],['celular',{width:390,height:844},{isMobile:true,hasTouch:true,deviceScaleFactor:2}]]) {
  const p=await (await b.newContext({viewport:vp,locale:'pt-BR',...extra})).newPage();
  await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  for (const [rotulo, rota, idConversa] of telas) {
    const url = idConversa ? `${BASE}${rota}?c=${idConversa}` : `${BASE}${rota}`;
    await p.goto(url,{waitUntil:'networkidle'}); await p.waitForTimeout(1600);
    await p.screenshot({path:`${SAIDA}/${nome}-${rotulo}.png`});
    console.log(`${nome}-${rotulo}`);
  }
}
await b.close();
