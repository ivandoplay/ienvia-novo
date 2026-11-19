import {test,expect} from '@playwright/test';
import {entrar} from './apoio/sessao';
test('simulador: seleção local de provedor e rolagem única da conversa',async({page})=>{
 await entrar(page,'inbox');await page.goto('/simulador');
 const select=page.getByLabel('Provedor desta simulação');await expect(select).toHaveValue('automatico');
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:844});
  for(const provider of ['gemini','openrouter','nvidia','automatico']){await select.selectOption(provider);await expect(select).toHaveValue(provider);}
  await expect(page.locator('.f6-sim-mensagens')).toHaveCSS('overflow-y','visible');
  await expect(page.locator('.f6-sim-chat')).toHaveCSS('max-height','none');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 await expect(page.locator('input[type="file"]')).toHaveAttribute('accept',/audio\/ogg/);
});
