import {test,expect} from '@playwright/test';
import {entrar} from './apoio/sessao';
import {CONVERSAS_DA_INBOX} from './apoio/dados.mjs';
test('conversa desktop: histórico amplo, campo acessível e ferramentas sob demanda',async({page,request})=>{
 test.setTimeout(90000);
 await request.post('http://127.0.0.1:54399/controle/reiniciar-inbox');
 await entrar(page,'inbox');
 for(const [width,height] of [[1024,768],[1366,768],[1440,900]] as const){
  await page.setViewportSize({width,height});await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
  const log=page.getByRole('log',{name:'Mensagens da conversa'});await expect(log).toBeVisible();
  expect(await log.evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThan(280);
  await expect(page.getByRole('complementary',{name:'Dados do contato',exact:true})).toBeHidden();
  const field=page.locator('textarea[placeholder="Mensagem"]');await field.fill('Conferindo espaço para digitar.');await expect(field).toBeInViewport();
  await expect(page.getByRole('button',{name:'Enviar',exact:true})).toBeInViewport();
  await page.getByRole('button',{name:'Contato',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Dados do contato',exact:true});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Fechar',exact:true}).click();
  const search=page.getByRole('searchbox',{name:'Procurar nesta conversa',exact:true});await expect(search).toBeHidden();await page.getByRole('button',{name:'Buscar na conversa',exact:true}).click();await expect(search).toBeVisible();await page.getByRole('button',{name:'Fechar busca na conversa',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});
