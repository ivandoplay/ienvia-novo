/** Confere a área de Contas como administrador da plataforma e testa excluir + desfazer num cliente de teste. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:1440,height:1000},locale:'pt-BR'})).newPage();
p.on('pageerror', e=>console.log('pageerror:', e.message));
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.SUPER_USUARIO ?? 'ivanjeffersong8@gmail.com');
await p.getByLabel(/senha/i).first().fill(env.SUPER_SENHA ?? env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(3000);
await p.goto(`${BASE}/contas`,{waitUntil:'networkidle'}); await p.waitForTimeout(2000);
const titulo = (await p.locator('main').innerText()).slice(0,80).replace(/\s+/g,' ');
console.log('tela:', titulo);
const excluir = p.getByRole('button',{name:/Excluir cliente/i});
console.log('botões "Excluir cliente":', await excluir.count());
await p.screenshot({path:'/home/user/ienvia/auditoria-visual/final/contas-admin.png'});
if (await excluir.count()) {
  // pega a linha do cliente de teste
  const linha = p.locator('.conta-item, li, article').filter({hasText:'Teste automático'}).last();
  const btn = linha.getByRole('button',{name:/Excluir cliente/i}).first();
  await btn.click(); await p.waitForTimeout(800);
  const dialogo = await p.locator('dialog[open]').count();
  console.log('janela de confirmação abriu?', dialogo);
  await p.fill('#motivo-exclusao','cliente de teste da auditoria');
  await p.screenshot({path:'/home/user/ienvia/auditoria-visual/final/contas-confirmar-exclusao.png'});
  await p.getByRole('button',{name:/^Excluir cliente$/}).last().click();
  await p.waitForTimeout(3500);
  const aviso = await p.evaluate(()=>[...document.querySelectorAll('[role="alert"], .aviso, .conta-aviso')].map(e=>e.textContent.trim().slice(0,120)));
  console.log('depois de excluir:', JSON.stringify(aviso));
  await p.screenshot({path:'/home/user/ienvia/auditoria-visual/final/contas-depois-de-excluir.png'});
  const desfazer = p.getByRole('button',{name:/Desfazer exclusão/i});
  console.log('botão desfazer:', await desfazer.count());
  if (await desfazer.count()) {
    await desfazer.first().click(); await p.waitForTimeout(3000);
    console.log('depois de desfazer:', JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('[role="alert"], .aviso, .conta-aviso')].map(e=>e.textContent.trim().slice(0,120)))));
  }
}
await b.close();
