/** Testa de verdade a aba Horário & Alertas: clicar, digitar, trocar dias e salvar. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:1440,height:900},locale:'pt-BR'})).newPage();
const erros=[]; p.on('pageerror',e=>erros.push(e.message));
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
await p.goto(`${BASE}/seguranca?secao=horario`,{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
await p.getByRole('button',{name:/Horário & Alertas/i}).click().catch(()=>{});
await p.waitForTimeout(1200);

const estado = async (rotulo) => {
  const m = await p.evaluate(`(() => {
    const sel=document.querySelector('#sec-sched-mode'); const ini=document.querySelector('#sec-sched-start'); const fim=document.querySelector('#sec-sched-end');
    const dias=[...document.querySelectorAll('.f5-dia')].map(d=>({txt:d.textContent.trim(), ativo:d.classList.contains('ativo'), desativado:d.disabled}));
    const msg=document.querySelector('#sec-off-msg'); const tz=document.querySelector('#sec-tz');
    const salvar=[...document.querySelectorAll('button')].filter(b=>/salvar/i.test(b.textContent)).map(b=>({txt:b.textContent.trim().slice(0,30), desativado:b.disabled}));
    const alerta=document.querySelector('#sec-alert-on');
    return { modo: sel?{valor:sel.value, desativado:sel.disabled}:null, inicio: ini?{valor:ini.value,desativado:ini.disabled}:null,
      fim: fim?{valor:fim.value,desativado:fim.disabled}:null, fuso: tz?{valor:tz.value,desativado:tz.disabled}:null,
      msg: msg?{desativado:msg.disabled, len:msg.value.length}:null, dias, salvar, alerta: alerta?{marcado:alerta.checked,desativado:alerta.disabled}:null };
  })()`);
  console.log(`\n--- ${rotulo} ---`); console.log(JSON.stringify(m));
  return m;
};
await estado('ao abrir');

// 1) trocar modo para horário comercial
await p.selectOption('#sec-sched-mode','business_hours_only');
await p.waitForTimeout(500);
await estado('depois de escolher "somente horário comercial"');

// 2) mudar início/fim
await p.fill('#sec-sched-start','08:30');
await p.fill('#sec-sched-end','19:15');
await p.waitForTimeout(300);
// 3) desligar um dia
const dias = p.locator('.f5-dia');
await dias.nth(0).click();
await p.waitForTimeout(300);
await estado('depois de mudar horário e desligar Domingo');

// 4) escrever mensagem fora do horário
await p.fill('#sec-off-msg','Teste de auditoria: fora do horário respondemos de manhã.');
await p.waitForTimeout(300);
// 5) salvar
const salvar = p.getByRole('button',{name:/salvar/i}).first();
console.log('\ná botão salvar?', await salvar.count(), '· desativado?', await salvar.isDisabled().catch(()=>null));
await salvar.click().catch(e=>console.log('clique falhou:', String(e).slice(0,120)));
await p.waitForTimeout(3000);
const aviso = await p.evaluate(`(() => [...document.querySelectorAll('[role="alert"], .aviso, .f5-aviso-topo')].map(e=>e.textContent.trim().slice(0,120)))()`);
console.log('avisos na tela:', JSON.stringify(aviso));
await p.screenshot({path:'/home/user/ienvia/auditoria-visual/final/horarios-depois-de-salvar.png'});

// 6) recarregar e ver se persistiu
await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(1500);
await p.getByRole('button',{name:/Horário & Alertas/i}).click().catch(()=>{});
await p.waitForTimeout(1000);
await estado('depois de recarregar');
console.log('\nerros de runtime:', erros.length ? erros.slice(0,3) : 'nenhum');
await b.close();
