import {test,expect} from '@playwright/test';
import {entrar} from './apoio/sessao';
import {CONVERSAS_DA_INBOX} from './apoio/dados.mjs';
const paths=['/visao-geral','/treinamento','/audios','/simulador','/inteligencia-artificial','/catalogo','/instancias','/conexoes','/seguranca','/configuracoes','/inbox','/inbox?aba=contatos','/inbox?aba=kanban','/campanhas'];
test('rolagem global: telas do workspace sem segundo scroll nem conteúdo inacessível',async({page})=>{
 test.setTimeout(120000);await entrar(page,'inbox');
 for(const path of paths){
  await page.goto(path);await expect(page.locator('.casca')).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('overflow-y','hidden');
  await expect(page.locator('.content-area')).toHaveCSS('min-height','0px');
  await expect(page.locator('body')).toHaveCSS('overflow-y','hidden');
  expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),path+' altura externa').toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),path+' largura externa').toBe(true);
  const main=page.locator('.content-area');await main.hover();await page.mouse.wheel(0,600);
  expect(await page.evaluate(()=>window.scrollY),path+' scroll externo').toBe(0);
  expect(await main.evaluate(el=>{el.scrollTop=el.scrollHeight;return el.scrollHeight-el.clientHeight-el.scrollTop<2;}),path+' fim acessível').toBe(true);
 }
});
test('conversa longa: digitação e navegação não movem a página externa',async({page,request},info)=>{
 await request.post('http://127.0.0.1:54399/controle/reiniciar-inbox');await entrar(page,'inbox');
 for(const width of info.project.name==='celular'?[320,390]:[1024,1366,1440]){
  await page.setViewportSize({width,height:844});await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
  const field=page.locator('textarea[placeholder="Mensagem"]');await field.fill('Rascunho de teste sem envio.');await expect(field).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1)).toBe(true);
  expect(await page.evaluate(()=>window.scrollY)).toBe(0);
 }
});
