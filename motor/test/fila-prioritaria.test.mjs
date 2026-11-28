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
  const history=supervisor.escoarHistorico({tipo:'history'});
  await new Promise(resolve=>setImmediate(resolve));
  for(let i=0;i<6;i++)supervisor.filaHistorico.guardar('v'+i,valor('v'+i,false));
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
test('ordena por data real decrescente, inclusive apos reinicio, sem depender de hash',()=>{
 const r=tmp();try{let f=abrirFila(r);for(const [id,t] of [['antiga',100],['nova',300],['media',200]]){const v=valor(id,true);const m=JSON.parse(v.msg);m.messageTimestamp=t;v.msg=JSON.stringify(m);f.guardar(id,v);}
 f=abrirFila(r);assert.deepEqual(f.listar(3,'history').map(x=>JSON.parse(x.valor.msg).key.id),['nova','media','antiga']);
 }finally{fs.rmSync(r,{recursive:true,force:true});}
});
test('nova entrada fura a rodada anterior, retentativa nao deixa entradas antigas morrerem',()=>{
 const r=tmp();try{const f=abrirFila(r);for(let i=1;i<=3;i++){const v=valor('m'+i,false);const m=JSON.parse(v.msg);m.messageTimestamp=i;v.msg=JSON.stringify(m);f.guardar('m'+i,v);}
 assert.equal(JSON.parse(f.listar(1,'live')[0].valor.msg).key.id,'m3');const v=valor('recentissima',false);const m=JSON.parse(v.msg);m.messageTimestamp=99;v.msg=JSON.stringify(m);f.guardar('z',v);
 assert.equal(JSON.parse(f.listar(1,'live')[0].valor.msg).key.id,'recentissima');assert.deepEqual(f.listar(2,'live').map(x=>JSON.parse(x.valor.msg).key.id),['m2','m1']);
 }finally{fs.rmSync(r,{recursive:true,force:true});}
});
test('grupos novos nao entram; legados sao preservados fora da fila ativa',()=>{
 const r=tmp();try{const v=valor('g',false);const m=JSON.parse(v.msg);m.key.remoteJid='12345@g.us';v.msg=JSON.stringify(m);
 const f=abrirFila(r);assert.equal(f.guardar('g',v),false);fs.writeFileSync(path.join(r,'a'.repeat(64)+'.json'),JSON.stringify(v));
 assert.deepEqual(abrirFila(r).contagem(),{live:0,history:0});assert.equal(fs.readdirSync(r+'-nao-individuais').length,1);
 }finally{fs.rmSync(r,{recursive:true,force:true});fs.rmSync(r+'-nao-individuais',{recursive:true,force:true});}
});
test('historico cede ao live e retoma durante backoff de identidade sem perder a entrada',async()=>{
 const r=tmp();try{const calls=[];const s=new SupervisorDeSessoes({rootDir:r,panelUrl:'https://example.invalid',deviceToken:'x',onLog:()=>{},fetchFn:async(_,o)=>{calls.push(JSON.parse(o.body));return new Response(JSON.stringify({result:'accepted'}));}});s.sessoes.set('inst',{sock:{}});
 const unresolved=valor('lid',false);const msg=JSON.parse(unresolved.msg);delete msg.key.remoteJidAlt;unresolved.msg=JSON.stringify(msg);s.filaHistorico.guardar('lid',unresolved);s.filaHistorico.guardar('hist',valor('hist',true));
 await s.escoarHistorico({tipo:'history'});assert.equal(calls.length,0);await s.escoarHistorico({tipo:'live'});await s.escoarHistorico({tipo:'history'});
 assert.equal(calls.length,1);assert.equal(calls[0].historical,true);assert.equal(s.filaHistorico.contagem().live,1);assert.equal(s.diagnosticoOperacional().identidadesPendentes,1);
 }finally{fs.rmSync(r,{recursive:true,force:true});}
});
test('entrada de chip sem socket é preservada sem bloquear histórico de chip conectado',async()=>{
 const root=tmp();try{
  let chamadas=0;const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'teste',onLog:()=>{},fetchFn:async()=>{chamadas++;return new Response(JSON.stringify({result:'accepted'}));}});
  s.sessoes.set('inst',{sock:{}});
  s.filaHistorico.guardar('sem-sessao',{...valor('orfa',false),instanceId:'outro-chip'});
  s.filaHistorico.guardar('historico',valor('historico',true));
  await s.escoarHistorico({tipo:'history'});assert.equal(chamadas,1);
  await s.escoarHistorico({tipo:'live'});assert.deepEqual(s.filaHistorico.contagem(),{history:0,live:1});
  const d=s.diagnosticoOperacional();assert.equal(d.pendenciasPorMotivo.aguardando_sessao,1);assert.deepEqual(d.filasPorInstancia['outro-chip'],{live:1,history:0});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('mensagem JSON inválida fica preservada e não interrompe o lote seguinte',async()=>{
 const root=tmp();try{
  let chamadas=0;const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'teste',onLog:()=>{},fetchFn:async()=>{chamadas++;return new Response(JSON.stringify({result:'accepted'}));}});
  s.sessoes.set('inst',{sock:{}});s.filaHistorico.guardar('corrompida',{instanceId:'inst',historical:false,msg:'{'});s.filaHistorico.guardar('valida',valor('valida',false));
  await s.escoarHistorico({tipo:'live'});assert.equal(chamadas,1);assert.equal(s.filaHistorico.contagem().live,1);assert.equal(s.diagnosticoOperacional().pendenciasPorMotivo.arquivo_invalido_preservado,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
