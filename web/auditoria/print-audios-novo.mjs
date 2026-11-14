import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:1440,height:1000},locale:'pt-BR'})).newPage();
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2500);
await p.goto(`${BASE}/audios`,{waitUntil:'networkidle'}); await p.waitForTimeout(1800);
const novo = p.getByRole('button',{name:/Novo áudio|Adicionar|criar áudio/i}).first();
if (await novo.count()) { await novo.click(); await p.waitForTimeout(1200); }
const temBotao = await p.getByRole('button',{name:/Transcrever automaticamente/i}).count();
console.log('botão de transcrição automática na tela:', temBotao);
const desativado = temBotao ? await p.getByRole('button',{name:/Transcrever automaticamente/i}).first().isDisabled() : null;
console.log('desativado sem arquivo (correto):', desativado);
await p.screenshot({path:'/home/user/ienvia/auditoria-visual/final/audios-transcricao.png'});
await b.close();
