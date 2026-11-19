import {test,expect} from '@playwright/test';
import {entrar} from './apoio/sessao';
test('biblioteca e editor de áudio responsivos com identificação correta da Groq',async({page},info)=>{
 await entrar(page,'inbox');await page.goto('/audios');
 for(const width of info.project.name==='celular'?[320,390]:[1024,1440]){
  await page.setViewportSize({width,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Novo áudio estratégico',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Grave ou envie um arquivo para habilitar a transcrição com a Groq/)).toBeVisible();
  expect(await dialog.innerText()).not.toContain('Gemini');
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await expect(dialog.getByRole('button',{name:'Transcrever áudio',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'Salvar áudio',exact:true}).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button',{name:'Salvar áudio',exact:true})).toBeInViewport();
  await page.screenshot({path:`../auditoria/editor-ia/audios-layout-${width}.png`});
  await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();await expect(dialog).toHaveCount(0);
 }
});
