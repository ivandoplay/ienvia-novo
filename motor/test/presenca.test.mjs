import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PresencaDeResposta } from '../src/presenca.mjs';
const jid = '558681638438@s.whatsapp.net';
const key = (id='entrada') => ({ id, fromMe:false, remoteJid:jid });
async function temp(fn) { const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'presenca-'));try { await fn(rootDir); } finally { fs.rmSync(rootDir,{recursive:true,force:true}); } }
test('texto: digitando antes, visto só após confirmação e limpa presença',()=>temp(async rootDir=>{
 const events=[];const p=new PresencaDeResposta({rootDir,wait:async ms=>events.push(['wait',ms])});p.receber('i',{key:key()});
 const sock={sendPresenceUpdate:async (s,j)=>events.push([s,j]),readMessages:async keys=>events.push(['read',keys])};
 await p.enviar({instanceId:'i',sock,jid,tipo:'text',texto:'Oi',enviar:async()=>{events.push(['send']);return {key:{id:'out'}};}});
 assert.deepEqual(events.map(e=>e[0]),['composing','wait','send','read','paused']);assert.equal(p.fila.contagem().live,0);
}));
test('voz: gravando antes do envio, sem composing',()=>temp(async rootDir=>{
 const events=[];const p=new PresencaDeResposta({rootDir,wait:async()=>{}});
 await p.enviar({instanceId:'i',sock:{sendPresenceUpdate:async s=>events.push(s)},jid,tipo:'audio',enviar:async()=>{events.push('send');return {key:{id:'out'}};}});
 assert.deepEqual(events,['recording','send','paused']);
}));
test('envio falha: não marca visto e limpa indicador, sem nova tentativa de envio',()=>temp(async rootDir=>{
 const events=[];const p=new PresencaDeResposta({rootDir,wait:async()=>{}});p.receber('i',{key:key()});
 await assert.rejects(()=>p.enviar({instanceId:'i',jid,tipo:'text',sock:{sendPresenceUpdate:async s=>events.push(s),readMessages:async()=>events.push('read')},enviar:async()=>{events.push('send');throw Error('falhou');}}),/falhou/);
 assert.deepEqual(events,['composing','send','paused']);assert.equal(p.fila.contagem().live,1);
}));
test('erros de indicador e leitura não invalidam o envio confirmado',()=>temp(async rootDir=>{
 const p=new PresencaDeResposta({rootDir,wait:async()=>{}});p.receber('i',{key:key()});let sends=0;
 const r=await p.enviar({instanceId:'i',jid,tipo:'text',sock:{sendPresenceUpdate:async()=>{throw Error('presence');},readMessages:async()=>{throw Error('read');}},enviar:async()=>{sends++;return {key:{id:'out'}};}});
 assert.equal(r.key.id,'out');assert.equal(sends,1);assert.equal(p.fila.contagem().live,1);
}));
test('isola chip e contato, ignora grupos, mensagens próprias e status',()=>temp(async rootDir=>{
 const p=new PresencaDeResposta({rootDir,wait:async()=>{}});
 for(const k of [{...key(),fromMe:true},{...key(),remoteJid:'123@g.us'},{...key(),remoteJid:'status@broadcast'}])p.receber('i',{key:k});
 assert.equal(p.fila.contagem().live,0);p.receber('outro',{key:key('outro-chip')});p.receber('i',{key:{...key('outro-contato'),remoteJid:'5511999999999@s.whatsapp.net'}});
 assert.equal(p.selecionar('i',jid).length,0);
}));
test('chave LID preservada, com telefone alternativo e leitura durável após reinício',()=>temp(async rootDir=>{
 let p=new PresencaDeResposta({rootDir});const k={...key(),remoteJid:'12345@lid',remoteJidAlt:'5586981638438@s.whatsapp.net'};p.receber('i',{key:k});
 p=new PresencaDeResposta({rootDir});const rows=p.selecionar('i',jid);assert.equal(rows.length,1);assert.deepEqual(rows[0].valor.key,k);
}));
test('mensagem que chega durante o envio não é marcada como lida',()=>temp(async rootDir=>{
 const p=new PresencaDeResposta({rootDir,wait:async()=>{}});p.receber('i',{key:key('antes')});let read;
 await p.enviar({instanceId:'i',jid,tipo:'text',sock:{readMessages:async keys=>{read=keys;}},enviar:async()=>{p.receber('i',{key:key('depois')});return {key:{id:'out'}};}});
 assert.deepEqual(read.map(k=>k.id),['antes']);assert.equal(p.fila.contagem().live,1);
}));
test('sem ID de confirmação não marca leitura; mídia comum não simula gravação',()=>temp(async rootDir=>{
 const p=new PresencaDeResposta({rootDir});p.receber('i',{key:key()});const events=[];
 await p.enviar({instanceId:'i',jid,tipo:'media',sock:{sendPresenceUpdate:async()=>events.push('presence'),readMessages:async()=>events.push('read')},enviar:async()=>({})});
 assert.deepEqual(events,[]);assert.equal(p.fila.contagem().live,1);
}));
