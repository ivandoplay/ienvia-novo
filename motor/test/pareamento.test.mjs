import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorDeSessoes } from '../src/sessoes.mjs';
async function cenario(fn) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ienvia-par-')); const reports=[];const sockets=[];
 const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'fake',onLog:()=>{},
 fetchFn:async(u,o)=>{reports.push({u,...JSON.parse(o.body)});return new Response('{}');},
 authFactory:async()=>({state:{creds:{registered:false}},saveCreds:async()=>{}}),versionFactory:async()=>({version:[2,3000,1]}),
 socketFactory:()=>{const sock={ev:new EventEmitter(),end:()=>{},requestPairingCode:async(phone)=>{assert.equal(phone,'5586981638438');return 'ABCD1234';}};sockets.push(sock);return sock;}});
 try{await fn({s,reports,sockets,root});}finally{s.encerrando=true;for(const t of s.reconexoes.values())clearTimeout(t);fs.rmSync(root,{recursive:true,force:true});}
}
const tick=()=>new Promise(r=>setTimeout(r,20));
const cmd={id:'cmd',instance_id:'i',command_type:'connect_qr',payload:{}};
test('não conclui antes de entregar QR ao painel',()=>cenario(async({s,reports,sockets})=>{
 const p=s.executarComando(cmd);await tick();assert.equal(reports.some(r=>r.outcome),false);
 sockets[0].ev.emit('connection.update',{qr:'teste-qr'});await p;
 assert.ok(reports.find(r=>r.pairing_qr?.startsWith('data:image/png')));assert.equal(reports.at(-1).outcome,'succeeded');
}));
test('código mantém telefone e só conclui após publicação',()=>cenario(async({s,reports,sockets})=>{
 const p=s.executarComando({...cmd,command_type:'connect_code',payload:{phone:'5586981638438'}});await tick();
 sockets[0].ev.emit('connection.update',{qr:'token'});await p;assert.equal(reports.find(r=>r.pairing_code)?.pairing_code,'ABCD1234');assert.equal(reports.at(-1).outcome,'succeeded');
}));
test('logout antes do QR reporta falha com status em vez de sucesso falso',()=>cenario(async({s,reports,sockets})=>{
 const p=s.executarComando(cmd);await tick();sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await tick();sockets[1].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await p;
 assert.equal(reports.at(-1).outcome,'failed');assert.match(reports.at(-1).error_detail,/401/);
}));
test('limpeza cancela reconexão pendente e não ressuscita socket antigo',()=>cenario(async({s,sockets})=>{
 await s.iniciarConexao('i');sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});await tick();assert.equal(s.reconexoes.size,1);
 await s.pararSessao('i',true);assert.equal(s.reconexoes.size,0);
}));
test('reinício 515 preserva modo código e funciona sem creds.json',()=>cenario(async({s,reports,sockets})=>{
 const p=s.executarComando({...cmd,command_type:'connect_code',payload:{phone:'5586981638438'}});await tick();sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
 await new Promise(r=>setTimeout(r,4100));assert.equal(sockets.length,2);sockets[1].ev.emit('connection.update',{qr:'token-novo'});await p;
 assert.ok(reports.find(r=>r.pairing_code==='ABCD1234'));assert.equal(reports.at(-1).outcome,'succeeded');
}));

test('falha HTTP ao publicar QR não vira sucesso',()=>cenario(async({s,reports,sockets})=>{
 s.fetchFn=async(u,o)=>{const r=JSON.parse(o.body);reports.push({u,...r});return new Response('{}',{status:r.pairing_qr?503:200});};
 const p=s.executarComando(cmd);await tick();sockets[0].ev.emit('connection.update',{qr:'qr-realista-de-teste'});await p;
 assert.equal(reports.at(-1).outcome,'failed');assert.equal(reports.some(r=>r.outcome==='succeeded'),false);
}));
test('recusa de código no WhatsApp é falha explícita',()=>cenario(async({s,reports,sockets})=>{
 const p=s.executarComando({...cmd,command_type:'connect_code',payload:{phone:'5586981638438'}});await tick();
 sockets[0].requestPairingCode=async()=>{throw Error('rejected');};sockets[0].ev.emit('connection.update',{qr:'token'});await p;
 assert.equal(reports.at(-1).outcome,'failed');assert.match(reports.at(-1).error_detail,/código/);
}));
test('código vazio não é considerado pareamento gerado',()=>cenario(async({s,reports,sockets})=>{
 const p=s.executarComando({...cmd,command_type:'connect_code',payload:{phone:'5586981638438'}});await tick();
 sockets[0].requestPairingCode=async()=>'';sockets[0].ev.emit('connection.update',{qr:'token'});await p;
 assert.equal(reports.at(-1).outcome,'failed');
}));
test('eventos de socket substituído são ignorados',()=>cenario(async({s,reports,sockets})=>{
 await s.iniciarConexao('i');const antigo=sockets[0];await s.iniciarConexao('i');
 antigo.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});antigo.ev.emit('connection.update',{qr:'antigo'});await tick();
 assert.equal(s.reconexoes.size,0);assert.equal(reports.length,0);assert.equal(s.sessoes.get('i').sock,sockets[1]);
}));
test('conexão aberta confirma tentativa sem exigir QR novo',()=>cenario(async({s,reports,sockets})=>{
 const p=s.executarComando(cmd);await tick();sockets[0].user={id:'5586981638438:1@s.whatsapp.net'};sockets[0].ev.emit('connection.update',{connection:'open'});await p;
 assert.equal(s.sessoes.get('i').status,'connected');assert.ok(reports.some(r=>r.status==='connected'));assert.equal(reports.at(-1).outcome,'succeeded');
}));
test('silêncio do WhatsApp termina em timeout e não em sucesso',(t)=>cenario(async({s,reports})=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const p=s.executarComando(cmd);await new Promise(r=>setImmediate(r));t.mock.timers.tick(45001);await p;
 assert.equal(reports.at(-1).outcome,'failed');assert.match(reports.at(-1).error_detail,/45 segundos/);t.mock.timers.reset();
}));

test('sessão recusada 401 é arquivada uma única vez e QR novo é publicado sem apagar arquivos',()=>cenario(async({s,reports,sockets,root})=>{
 const p=s.executarComando(cmd);await tick();const pasta=s.pastaDaSessao('i');fs.writeFileSync(path.join(pasta,'creds.json'),'credencial-recuperavel');
 sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await tick();
 assert.equal(sockets.length,2);assert.equal(reports.at(-1).status,'connecting');
 const arquivo=path.join(root,'data','wa_auth_recusadas');const dirs=fs.readdirSync(arquivo);assert.equal(dirs.length,1);assert.equal(fs.readFileSync(path.join(arquivo,dirs[0],'creds.json'),'utf8'),'credencial-recuperavel');
 sockets[1].ev.emit('connection.update',{qr:'qr-recuperado'});await p;assert.equal(reports.at(-1).outcome,'succeeded');
}));
test('recuperação de 401 preserva modo código e telefone',()=>cenario(async({s,reports,sockets})=>{
 const p=s.executarComando({...cmd,command_type:'connect_code',payload:{phone:'5586981638438'}});await tick();
 sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await tick();sockets[1].ev.emit('connection.update',{qr:'novo-token'});await p;
 assert.equal(reports.find(r=>r.pairing_code)?.pairing_code,'ABCD1234');assert.equal(reports.at(-1).outcome,'succeeded');
}));
