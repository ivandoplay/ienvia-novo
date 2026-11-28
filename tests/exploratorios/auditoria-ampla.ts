import {CONVERSAS_DA_INBOX} from '../../web/e2e/apoio/dados.mjs';
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import {entrar} from '../../web/e2e/apoio/sessao';
const pasta='.cache/evidencias/auditoria-ampla';
const rotas=['/visao-geral','/inbox','/inbox?aba=contatos','/inbox?aba=kanban','/campanhas','/treinamento','/catalogo','/audios','/simulador','/inteligencia-artificial','/instancias','/conexoes','/configuracoes','/seguranca'];
test('auditoria de rotas, acessibilidade e viewport compacta',async({page,isMobile},info)=>{
 test.setTimeout(240000);fs.mkdirSync(pasta,{recursive:true});
 await page.setViewportSize(isMobile?{width:360,height:640}:{width:1366,height:768});
 await page.emulateMedia({reducedMotion:'reduce'});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(page.url()+' :: '+e.message));
 const resultados=[];
 await entrar(page,'inbox');
 for(const rota of rotas){
  const res=await page.goto(rota);await page.locator('main').waitFor();await page.waitForTimeout(300);
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
  const medidas=await page.evaluate(()=>({largura:innerWidth,documento:document.documentElement.scrollWidth,h1:document.querySelectorAll('h1').length,principais:[...document.querySelectorAll('main button, main input, main select,main summary')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&r.top<innerHeight&&r.bottom>0}).map(el=>{const r=el.getBoundingClientRect();return {nome:el.getAttribute('aria-label')||el.textContent?.trim().slice(0,70)||el.getAttribute('placeholder'),x:r.x,direita:r.right,w:r.width,h:r.height}})}));
  resultados.push({rota,status:res?.status(),...medidas,acessibilidade:axe.violations.map(v=>({id:v.id,impacto:v.impact,descricao:v.help,nodes:v.nodes.map(n=>({alvo:n.target,resumo:n.failureSummary}))}))});
  await page.screenshot({path:`${pasta}/${info.project.name}-${rota.replace(/[^a-z0-9]/gi,'_')}.png`});
 }
 await page.context().clearCookies();await entrar(page,'master@exemplo.com');await page.goto('/contas');await expect(page.getByRole('heading',{name:'Clientes SaaS',exact:true})).toBeVisible();
 resultados.push({rota:'/contas',status:200,acessibilidade:(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations.map(v=>({id:v.id,impacto:v.impact,descricao:v.help,nodes:v.nodes.map(n=>({alvo:n.target,resumo:n.failureSummary}))}))});
 fs.writeFileSync(`${pasta}/${info.project.name}-medicoes.json`,JSON.stringify({viewport:isMobile?'360x640':'1366x768',resultados,errors},null,2));
});

test('auditoria confirma acessos compactos da Inbox sem enviar mensagens',async({page,isMobile})=>{
 test.skip(!isMobile,'Verificacao especifica do menu compacto');
 await entrar(page,'inbox');await page.goto('/inbox?c='+CONVERSAS_DA_INBOX.ana);
 await page.getByRole('button',{name:'Mais',exact:true}).click();
 await page.getByRole('button',{name:'Dados do contato',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Dados do contato'})).toBeVisible();
 await page.keyboard.press('Escape');
 const anexo=page.getByRole('button',{name:'Anexar arquivo',exact:true});
 if(!await anexo.isVisible())await page.getByLabel('Abrir ferramentas de envio').click();
 await expect(anexo).toBeVisible();await expect(page.getByRole('button',{name:'Rascunho da IA',exact:true})).toBeVisible();
 await page.getByLabel('Abrir ferramentas de envio').click();
 const balao=page.getByRole('log',{name:'Mensagens da conversa'}).locator('.balao').filter({hasText:'Vocês entregam no centro?'}).first();
 await balao.getByLabel('Opções da mensagem').click();await balao.getByRole('button',{name:'Responder citando',exact:true}).click();
 await expect(page.locator('.inbox-respondendo')).toBeVisible();await expect(page.getByLabel('Mensagem',{exact:true})).toBeEmpty();
});
