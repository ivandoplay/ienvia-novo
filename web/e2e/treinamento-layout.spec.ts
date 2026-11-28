import {test,expect} from '@playwright/test';
import {entrar} from './apoio/sessao';
test('treinamento: oito seções visíveis, salvar sem sobreposição e chat responsivo',async({page},info)=>{
 await entrar(page,'inbox'); await page.goto('/treinamento');
 for(const width of info.project.name==='celular'?[320,390,768]:[1024,1440]){
  await page.setViewportSize({width,height:844});
  const tabs=page.getByRole('tablist',{name:'Partes do treinamento'}).getByRole('tab');
  await expect(tabs).toHaveCount(8);
  for(let i=0;i<8;i++){
   await tabs.nth(i).click();
   await expect(tabs.nth(i)).toHaveAttribute('aria-selected','true');
   expect(await tabs.nth(i).evaluate(el=>{const a=el.getBoundingClientRect();return a.left>=0&&a.right<=innerWidth;})).toBe(true);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   if(i<6){
    const bar=page.locator('.barra-de-salvar');
    await expect(bar).toHaveCSS('position','static');
    expect(await bar.evaluate(el=>{const prev=el.previousElementSibling;return !prev||prev.getBoundingClientRect().bottom<=el.getBoundingClientRect().top;})).toBe(true);
   }else await expect(page.locator('.barra-de-salvar')).toHaveCount(0);
  }
  await page.locator('.treino-chat').scrollIntoViewIfNeeded();
  await page.screenshot({path:`.cache/evidencias/editor-ia/layout-treinamento-${width}.png`,fullPage:true});
 }
 await page.getByRole('tab',{name:'Regras',exact:true}).click();
 const rules=page.getByLabel('Regras de ouro');const original=await rules.inputValue();
 await rules.fill('Revisão visual: salvar continua funcionando.');
 const save=page.getByRole('button',{name:'Salvar treinamento',exact:true});await expect(save).toBeEnabled();await save.click();
 await expect(save).toBeDisabled();await page.reload();await page.getByRole('tab',{name:'Regras',exact:true}).click();
 await expect(rules).toHaveValue('Revisão visual: salvar continua funcionando.');
 await rules.fill(original);await page.getByRole('button',{name:'Desfazer',exact:true}).click();await expect(rules).toHaveValue('Revisão visual: salvar continua funcionando.');
});
