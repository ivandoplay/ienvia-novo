import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {resolverDestinatario} from '../src/destinatario.mjs';import {ondaDoCabecalho,SupervisorDeSessoes} from '../src/sessoes.mjs';
const phone='5586981638438@s.whatsapp.net',canonical='558681638438@s.whatsapp.net';
test('WhatsApp resolve o nono dígito; cache é exclusivo do socket',async()=>{
 let calls=0;const a={onWhatsApp:async j=>{calls++;assert.equal(j,phone);return [{exists:true,jid:canonical}];}};
 assert.equal(await resolverDestinatario(a,phone),canonical);assert.equal(await resolverDestinatario(a,phone),canonical);assert.equal(calls,1);
 let callsB=0;assert.equal(await resolverDestinatario({onWhatsApp:async()=>{callsB++;return [{exists:true,jid:phone}];}},phone),phone);assert.equal(callsB,1);
});
test('não inventa destinatário, não aceita outro número, ausência, ambiguidade ou timeout',async()=>{
 for(const rows of [[],[{exists:false,jid:phone}],[{exists:true,jid:'5511999999999@s.whatsapp.net'}],[{exists:true,jid:canonical},{exists:true,jid:phone}]])await assert.rejects(()=>resolverDestinatario({onWhatsApp:async()=>rows},phone));
 await assert.rejects(()=>resolverDestinatario({onWhatsApp:()=>new Promise(()=>{})},phone,{timeoutMs:5}),/timeout/);
 await assert.rejects(()=>resolverDestinatario({},'grupo@g.us'),/invalido/);
 const foreign={onWhatsApp:async()=>[{exists:true,jid:'441234567890@s.whatsapp.net'}]};assert.equal(await resolverDestinatario(foreign,'441234567890@s.whatsapp.net'),'441234567890@s.whatsapp.net');
});
function temp(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ienvia-recibo-'));return Promise.resolve().then(()=>fn(root)).finally(()=>fs.rmSync(root,{recursive:true,force:true}));}
test('dossiê usa socket local e JID resolvido; falha anterior ao envio não vira sucesso',()=>temp(async root=>{
 const reports=[];const sends=[];
 const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'x',fetchFn:async(u,o)=>{reports.push(JSON.parse(o.body));return new Response('{}');}});
 s.sessoes.set('i',{status:'connected',sock:{onWhatsApp:async()=>[{exists:true,jid:canonical}],sendMessage:async(j,b)=>{sends.push({j,b});return {key:{id:'wa-id'}};}}});
 await s.executarComando({id:'cmd',instance_id:'i',command_type:'send_text',payload:{recipient:phone,body_text:'Dossiê',admin_alert_delivery_id:'alert'}});
 assert.equal(sends.length,1);assert.equal(sends[0].j,canonical);assert.equal(reports[0].provider_message_id,'wa-id');assert.equal(reports[0].outcome,'sent');
 s.sessoes.set('i',{status:'connected',sock:{onWhatsApp:async()=>[],sendMessage:async()=>{throw Error('Não deveria enviar');}}});
 await s.executarComando({id:'bad',instance_id:'i',command_type:'send_text',payload:{recipient:phone,body_text:'Dossiê'}});
 assert.equal(reports.at(-1).outcome,'failed');assert.equal(sends.length,1);
}));
test('falha após iniciar envio é incerta e não tenta outro chip ou destinatário',()=>temp(async root=>{
 let count=0;const reports=[];const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'x',fetchFn:async(u,o)=>{reports.push(JSON.parse(o.body));return new Response('{}');}});
 s.sessoes.set('i',{status:'connected',sock:{onWhatsApp:async()=>[{exists:true,jid:canonical}],sendMessage:async()=>{count++;throw Error('timeout');}}});
 await s.executarComando({id:'cmd',instance_id:'i',command_type:'send_text',payload:{recipient:phone,body_text:'Dossiê'}});
 assert.equal(count,1);assert.equal(reports[0].outcome,'uncertain');
}));
test('recibos duráveis ignoram entrada alheia e sobrevivem a rede/confirmacão precoce',()=>temp(async root=>{
 let confirmed=[];let fail=true;const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'x',fetchFn:async()=>{if(fail)throw Error('offline');return new Response(JSON.stringify({result:'ok',confirmed}));}});
 const sock={ev:new EventEmitter()};s.registrarRecibos(sock,'i');
 sock.ev.emit('messages.update',[{key:{fromMe:false,id:'entrada'},update:{status:4}},{key:{fromMe:true,id:'dossie'},update:{status:3}}]);
 assert.equal(s.filaRecibos.contagem().live,1);await assert.rejects(()=>s.escoarRecibos());assert.equal(s.filaRecibos.contagem().live,1);
 fail=false;s.proximoRecibo=0;await s.escoarRecibos();assert.equal(s.filaRecibos.contagem().live,1);
 confirmed=['dossie'];s.proximoRecibo=0;await s.escoarRecibos();assert.equal(s.filaRecibos.contagem().live,0);
 sock.ev.emit('message-receipt.update',[{key:{fromMe:true,id:'dossie'},receipt:{readTimestamp:123}}]);assert.equal(s.filaRecibos.listar(1,'live')[0].valor.receipt.status,4);
}));

test('onda do WhatsApp preserva 64 amplitudes reais e rejeita entrada inválida',()=>{
 const onda=Buffer.from(Array.from({length:64},(_,i)=>(i*7)%101));
 assert.deepEqual(ondaDoCabecalho(onda.toString('base64')),onda);
 for(const v of [null,'','oops',Buffer.alloc(64,255).toString('base64'),Buffer.alloc(63).toString('base64')])assert.equal(ondaDoCabecalho(v),undefined);
});
test('envia PTT com onda e duração explícitas sem alterar o arquivo de áudio',()=>temp(async root=>{
 const onda=Buffer.from(Array.from({length:64},(_,i)=>i));const audio=Buffer.from('audio-original');let payload;
 const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'x',fetchFn:async(u)=>u.includes('/midia?')?new Response(audio,{headers:{'x-ienvia-audio-waveform':onda.toString('base64')}}):new Response('{}')});
 s.sessoes.set('i',{status:'connected',sock:{onWhatsApp:async()=>[{exists:true,jid:canonical}],sendMessage:async(j,b)=>{payload=b;return {key:{id:'wave-test'}};}}});
 await s.executarComando({id:'cmd-wave',instance_id:'i',message_id:'m',command_type:'send_media',payload:{recipient:phone},attachment:{kind:'audio',content_type:'audio/ogg; codecs=opus',is_voice:true,duration_seconds:13}});
 assert.deepEqual(payload.waveform,onda);assert.deepEqual(payload.audio,audio);assert.equal(payload.ptt,true);assert.equal(payload.seconds,13);
}));
