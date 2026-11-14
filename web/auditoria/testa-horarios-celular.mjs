import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,locale:'pt-BR'})).newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2500);
await p.goto(`${BASE}/seguranca`,{waitUntil:'networkidle'}); await p.waitForTimeout(2000);
// abas são role=tab
const aba = p.getByRole('tab', { name: /Horário & Alertas/i });
console.log('aba encontrada?', await aba.count());
await aba.click(); await p.waitForTimeout(1500);
const mudou = await p.evaluate(()=>!!document.querySelector('#sec-sched-mode'));
console.log('aba Horários abriu?', mudou);
if (mudou) {
  await p.selectOption('#sec-sched-mode','business_hours_only'); await p.waitForTimeout(400);
  await p.fill('#sec-sched-start','09:00'); await p.fill('#sec-sched-end','20:00'); await p.waitForTimeout(300);
  await p.locator('.f5-dia').nth(0).click(); await p.waitForTimeout(300);
  await p.screenshot({path:'/home/user/ienvia/auditoria-visual/final/celular-horarios.png'});
  const salvar = p.getByRole('button',{name:/Salvar horário e alertas/i});
  console.log('botão salvar existe?', await salvar.count(), 'visível?', await salvar.isVisible().catch(()=>false));
  await salvar.scrollIntoViewIfNeeded();
  await salvar.click(); await p.waitForTimeout(3000);
  console.log('aviso:', await p.evaluate(()=>[...document.querySelectorAll('[role="alert"],.aviso')].map(e=>e.textContent.trim().slice(0,80))));
  await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  await p.getByRole('tab',{name:/Horário & Alertas/i}).click(); await p.waitForTimeout(1200);
  console.log('depois de recarregar:', await p.evaluate(()=>({modo:document.querySelector('#sec-sched-mode')?.value, ini:document.querySelector('#sec-sched-start')?.value, fim:document.querySelector('#sec-sched-end')?.value})));
}
await b.close();
