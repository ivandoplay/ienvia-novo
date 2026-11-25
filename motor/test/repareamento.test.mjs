import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invalidarAcessoRevogado, pedirNovoCodigo } from '../src/repareamento.mjs';
import { salvarConfiguracao, lerConfiguracao } from '../src/config.mjs';
async function temp(fn) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'reparear-'));try { await fn(root); } finally { fs.rmSync(root,{recursive:true,force:true}); } }
test('revogação remove somente credenciais do painel e preserva sessão e filas',()=>temp(async root=>{
 salvarConfiguracao(root,{panelUrl:'https://example.invalid',deviceToken:'revogado',executorId:'old',workspaceId:'w',displayName:'Meu aparelho'});
 for(const file of ['data/wa_auth/chip/creds.json','data/fila-historico/pendente.json','data/leituras-pendentes/entrada.json']){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'preservar');}
 const env={IENVIA_MOTOR_TOKEN:'revogado'};invalidarAcessoRevogado(root,'https://example.invalid',env);
 const cfg=lerConfiguracao(root);assert.equal(cfg.deviceToken,'');assert.equal(cfg.executorId,'');assert.equal(cfg.workspaceId,'');assert.equal(cfg.displayName,'Meu aparelho');assert.equal(env.IENVIA_MOTOR_TOKEN,undefined);
 for(const file of ['data/wa_auth/chip/creds.json','data/fila-historico/pendente.json','data/leituras-pendentes/entrada.json'])assert.equal(fs.readFileSync(path.join(root,file),'utf8'),'preservar');
}));
test('pede novo código; erro de formato não chama rede e código expirado permite tentar novamente',async()=>{
 const codes=['errado','IENV-AAAA-BBBB','IENV-CCCC-DDDD'];const sent=[];let closed=0;const logs=[];
 const ok=await pedirNovoCodigo({createInterface:()=>({question:async()=>codes.shift(),close:()=>closed++}),onLog:m=>logs.push(m),parear:async code=>{sent.push(code);if(sent.length===1)throw Error('expirado');}});
 assert.equal(ok,true);assert.deepEqual(sent,['IENV-AAAA-BBBB','IENV-CCCC-DDDD']);assert.equal(closed,1);assert.ok(logs.some(l=>l.includes('inválido')));assert.ok(logs.some(l=>l.includes('expirado')));
});
test('Ctrl+C cancela pergunta e remove listeners, sem vincular novamente',async()=>{
 const before=process.listenerCount('SIGINT');let called=false;let closed=false;
 const ok=await pedirNovoCodigo({createInterface:()=>({question:async(_,{signal})=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{code:'ABORT_ERR'})));queueMicrotask(()=>process.emit('SIGINT'));}),close:()=>{closed=true;}}),onLog:()=>{},parear:async()=>{called=true;}});
 assert.equal(ok,false);assert.equal(called,false);assert.equal(closed,true);assert.equal(process.listenerCount('SIGINT'),before);
});
test('stdin fechado termina sem loop de código inválido',async()=>{
 let calls=0;const ok=await pedirNovoCodigo({createInterface:()=>({question:async()=>{throw Object.assign(Error('closed'),{code:'ERR_USE_AFTER_CLOSE'});},close:()=>{}}),onLog:()=>{},parear:async()=>{calls++;}});assert.equal(ok,false);assert.equal(calls,0);
});
