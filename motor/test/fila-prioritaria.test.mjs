import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abrirFila } from '../src/fila-historico.mjs';
import { SupervisorDeSessoes } from '../src/sessoes.mjs';
import { iniciarEscoamento } from '../src/escoamento.mjs';
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'ienvia-fila-prioritaria-'));
function valor(id,historical){return {instanceId:'inst',historical,msg:JSON.stringify({key:{id,remoteJid:'123456789@lid',remoteJidAlt:'5586981638438@s.whatsapp.net'},message:{conversation:id},messageTimestamp:1795129652})};}
test('fila legada: 11272 históricas não atrasam as 44 novas; nenhum arquivo perdido no reinício',()=>{
 const root=tmp();try{
  let f=abrirFila(root);
  for(let i=0;i<11272;i++)f.guardar('h'+i,valor('h'+i,true));
  for(let i=0;i<44;i++)f.guardar('v'+i,valor('v'+i,false));
  f=abrirFila(root);assert.deepEqual(f.contagem(),{history:11272,live:44});
  const vistos=new Set();
  for(let i=0;i<5;i++)for(const item of f.listar(10,'live')){assert.equal(item.valor.historical,false);vistos.add(JSON.parse(item.valor.msg).key.id);f.confirmar(item.nome);}
  assert.equal(vistos.size,44);assert.deepEqual(f.contagem(),{history:11272,live:0});
  assert.equal(fs.readdirSync(root).length,11272);
  assert.deepEqual(abrirFila(root).contagem(),{history:11272,live:0});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('novas entradas são indexadas; confirmar é idempotente; arquivo corrompido é preservado',()=>{
 const root=tmp();try{
  const f=abrirFila(root);assert.deepEqual(f.contagem(),{live:0,history:0});
  f.guardar('a',valor('a',false));f.guardar('a',valor('duplicado',false));
  assert.equal(f.listar(10,'live').length,1);const [a]=f.listar(10,'live');f.confirmar(a.nome);f.confirmar(a.nome);
  assert.throws(()=>f.confirmar('../config.json'));
  const bad='a'.repeat(64)+'.json';fs.writeFileSync(path.join(root,bad),'{');
  const restored=abrirFila(root);assert.deepEqual(restored.contagem(),{live:0,history:0});assert.ok(fs.existsSync(path.join(root,bad)));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('cursores independentes: retentativas vivas não impedem progresso do histórico',()=>{
 const root=tmp();try{const f=abrirFila(root);for(let i=0;i<25;i++)f.guardar('v'+i,valor('v'+i,false));f.guardar('h',valor('h',true));
 const vistos=new Set();for(let i=0;i<3;i++)for(const x of f.listar(10,'live'))vistos.add(x.nome);
 assert.equal(vistos.size,25);assert.equal(f.listar(2,'history').length,1);assert.equal(f.contagem().live,25);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('histórico com rede bloqueada não bloqueia as seis mensagens vivas com LID + telefone',async()=>{
 const root=tmp();let liberar;const trava=new Promise(r=>{liberar=r;});
 try{
  const chamadas=[];
  const supervisor=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'teste',onLog:()=>{},fetchFn:async(url,opts)=>{
   const body=JSON.parse(opts.body);chamadas.push(body);
   if(body.historical)await trava;
   return new Response(JSON.stringify({result:'accepted',message_id:body.event_id}),{status:200});
  }});
  supervisor.sessoes.set('inst',{sock:{}});
  supervisor.filaHistorico.guardar('h',valor('h',true));
  for(let i=0;i<6;i++)supervisor.filaHistorico.guardar('v'+i,valor('v'+i,false));
  const history=supervisor.escoarHistorico({tipo:'history'});
  await supervisor.escoarHistorico({tipo:'live'});
  assert.equal(chamadas.filter(x=>!x.historical).length,6);
  assert.ok(chamadas.every(x=>x.sender_jid==='5586981638438@s.whatsapp.net'));
  assert.deepEqual(supervisor.filaHistorico.contagem(),{live:0,history:1});
  liberar();await history;assert.deepEqual(supervisor.filaHistorico.contagem(),{live:0,history:0});
 }finally{liberar();fs.rmSync(root,{recursive:true,force:true});}
});
test('falha de rede preserva arquivo; retomada não duplica item já confirmado',async()=>{
 const root=tmp();try{let falhar=true;let tentativas=0;
 const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'teste',onLog:()=>{},fetchFn:async()=>{tentativas++;if(falhar)throw Error('offline');return new Response(JSON.stringify({result:'duplicate'}));}});
 s.sessoes.set('inst',{sock:{}});s.filaHistorico.guardar('v',valor('v',false));
 await s.escoarHistorico({tipo:'live'});assert.equal(s.filaHistorico.contagem().live,1);
 falhar=false;await s.escoarHistorico({tipo:'live'});assert.equal(tentativas,1); // backoff evita martelar a rede
 for(const espera of s.retornosFila.values())espera.proxima=0;
 await s.escoarHistorico({tipo:'live'});await s.escoarHistorico({tipo:'live'});
 assert.equal(s.filaHistorico.contagem().live,0);assert.equal(tentativas,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('executor independente não sobrepõe lotes do mesmo tipo; parada aguarda tarefas',async()=>{
 let liberar;const trava=new Promise(r=>{liberar=r;});let vivas=0,historicas=0;
 const parar=iniciarEscoamento({escoarHistorico:async({tipo})=>{if(tipo==='history'){historicas++;await trava;}else vivas++;}},{intervaloMs:5});
 try{await new Promise(r=>setTimeout(r,35));assert.equal(historicas,1);assert.ok(vivas>=2);
 const fim=parar();liberar();await fim;const total=vivas;await new Promise(r=>setTimeout(r,20));assert.equal(vivas,total);
 }finally{liberar();await parar();}
});
