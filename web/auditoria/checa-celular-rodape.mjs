import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:390,height:844},locale:'pt-BR'})).newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
for (const rota of ['/visao-geral','/instancias','/configuracoes']) {
  await p.goto(`${BASE}${rota}`,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  const m = await p.evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label], .casca-barra-inferior, .barra-inferior, nav');
    const alturas = [...document.querySelectorAll('nav')].map(n => ({classe: n.className, topo: Math.round(n.getBoundingClientRect().top), altura: Math.round(n.getBoundingClientRect().height), posicao: getComputedStyle(n).position}));
    const main = document.querySelector('main');
    const ultimo = main ? [...main.querySelectorAll('*')].filter(e=>e.textContent.trim()).at(-1) : null;
    const r = ultimo?.getBoundingClientRect();
    const paddingBaixo = main ? getComputedStyle(main).paddingBottom : null;
    return { navegacao: alturas, mainPaddingBaixo: paddingBaixo, ultimoElemento: r ? {topo: Math.round(r.top), base: Math.round(r.bottom), texto: ultimo.textContent.trim().slice(0,40)} : null, janela: window.innerHeight, alturaTotal: document.documentElement.scrollHeight };
  })()`);
  console.log(`\n${rota}`);
  console.log(' navs:', JSON.stringify(m.navegacao));
  console.log(` padding-bottom do main: ${m.mainPaddingBaixo} · último elemento base: ${m.ultimoElemento?.base} · janela ${m.janela}`);
}
await b.close();
