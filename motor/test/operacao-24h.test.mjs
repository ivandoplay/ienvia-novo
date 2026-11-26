import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { atrasoReconexao, podeRetomarSessao, ehMensagemHistorica } from '../src/operacao.mjs';
import { linhasDoPainel, iniciarPainelTerminal, textoSeguro } from '../src/painel-terminal.mjs';
import { IntencoesDeConexao } from '../src/intencoes.mjs';
import { SupervisorDeSessoes } from '../src/sessoes.mjs';
const tick=()=>new Promise(setImmediate);
async function temp(fn) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'motor-24h-'));try{await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});} }
function supervisor(root, registrada=true) {
 const sockets=[];const reports=[];const options=[];
 const s=new SupervisorDeSessoes({rootDir:root,panelUrl:'https://example.invalid',deviceToken:'test',onLog:()=>{},
 fetchFn:async(u,o)=>{const body=o.body?JSON.parse(o.body):{};reports.push({u,body});return new Response(JSON.stringify({result:'accepted',message_id:'test-message'}));},
 authFactory:async()=>({state:{creds:{registered:registrada}},saveCreds:async()=>{}}),versionFactory:async()=>({version:[2,3000,1]}),
 socketFactory:opts=>{options.push(opts);const sock={ev:new EventEmitter(),end:()=>{}};sockets.push(sock);return sock;}});
 return {s,sockets,reports,options};
}
function close(sock, code=428){sock.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:code}}}});}
test('backoff cresce e fica limitado a cinco minutos',()=>{
 assert.deepEqual([0,1,2,3,4,5,6,100].map(atrasoReconexao),[4000,8000,16000,32000,64000,128000,256000,300000]);
});
test('logout, substituição e erro de credencial não causam loop infinito',()=>{
 for(const status of [401,403,411,440,500])assert.equal(podeRetomarSessao(status,true),false);
 for(const status of [408,428,515,undefined])assert.equal(podeRetomarSessao(status,true),true);
 assert.equal(podeRetomarSessao(428,false),false);
});
test('histórico append e notify antigo não viram conversa nova; mensagem atual continua live',()=>{
 const now=Date.now();assert.equal(ehMensagemHistorica('append',{},now),true);
 assert.equal(ehMensagemHistorica('notify',{messageTimestamp:Math.floor(now/1000)-3600},now),true);
 assert.equal(ehMensagemHistorica('notify',{messageTimestamp:Math.floor(now/1000)},now),false);
 assert.equal(ehMensagemHistorica('notify',{},now),false);
});
test('intenção de conexão sobrevive a restart; desconexão manual também',()=>temp(async root=>{
 const a=new IntencoesDeConexao(root);a.definir('chip',true);assert.equal(new IntencoesDeConexao(root).tem('chip'),true);
 a.definir('chip',false);assert.equal(new IntencoesDeConexao(root).tem('chip'),false);
 assert.throws(()=>a.definir('../escape',true));
}));
test('sessão registrada continua reconectando além da antiga tentativa 2', t=>temp(async root=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const {s,sockets}=supervisor(root);
 try {
  await s.iniciarConexao('chip');
  for(let n=0;n<5;n++) {close(sockets.at(-1));await tick();assert.equal(s.reconexoes.size,1);assert.equal(s.estados.get('chip').estado,'reconnecting');t.mock.timers.tick(atrasoReconexao(n));await tick();}
  assert.equal(sockets.length,6);
 } finally {await s.encerrarTudo();t.mock.timers.reset();}
}));
test('reconectar com sucesso zera o backoff e preserva sessão', t=>temp(async root=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const {s,sockets}=supervisor(root);
 try {await s.iniciarConexao('chip',{tentativa:7});sockets[0].ev.emit('connection.update',{connection:'open'});await tick();close(sockets[0]);await tick();assert.equal(s.estados.get('chip').proxima-Date.now(),4000);assert.equal(s.intencoes.tem('chip'),true);}
 finally{await s.encerrarTudo();t.mock.timers.reset();}
}));
test('401 registrado não arquiva nem apaga credenciais para se reconectar sozinho',()=>temp(async root=>{
 const {s,sockets}=supervisor(root);try {await s.iniciarConexao('chip');const p=path.join(root,'data/wa_auth/chip/creds.json');fs.writeFileSync(p,'preservar');close(sockets[0],401);await tick();assert.equal(s.reconexoes.size,0);assert.equal(s.intencoes.tem('chip'),false);assert.equal(fs.readFileSync(p,'utf8'),'preservar');}finally{await s.encerrarTudo();}
}));
test('disconnect explícito cancela tentativa e intenção de retomada', t=>temp(async root=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const {s,sockets}=supervisor(root);
 try {await s.iniciarConexao('chip');sockets[0].ev.emit('connection.update',{connection:'open'});await tick();close(sockets[0]);await tick();await s.executarComando({id:'test',instance_id:'chip',command_type:'disconnect'});t.mock.timers.tick(500000);await tick();assert.equal(sockets.length,1);assert.equal(s.intencoes.tem('chip'),false);}
 finally{await s.encerrarTudo();t.mock.timers.reset();}
}));
test('disconnect durante preparo assíncrono não ressuscita socket',()=>temp(async root=>{
 const {s,sockets}=supervisor(root);let liberar;s.authFactory=()=>new Promise(resolve=>{liberar=()=>resolve({state:{creds:{registered:true}},saveCreds:async()=>{}});});
 const p=s.iniciarConexao('chip');await tick();await s.pararSessao('chip');liberar();await p;assert.equal(sockets.length,0);await s.encerrarTudo();
}));
test('Web compativel solicita historico completo, append histórico e notify novo vão às filas corretas',()=>temp(async root=>{
 const {s,sockets,options,reports}=supervisor(root);try{
 await s.iniciarConexao('chip');assert.equal(options[0].syncFullHistory,true);assert.equal(options[0].shouldSyncHistoryMessage({}),true);assert.ok(options[0].browser.includes('Chrome'));
 const msg=id=>({key:{id,remoteJid:'5586981638438@s.whatsapp.net',fromMe:false},message:{conversation:'teste'},messageTimestamp:Math.floor(Date.now()/1000)});
 sockets[0].ev.emit('messaging-history.set',{messages:[msg('antiga')],contacts:[{id:'5586981638438@s.whatsapp.net',name:'Contato teste'}]});
 sockets[0].ev.emit('messages.upsert',{type:'append',messages:[msg('append')]});sockets[0].ev.emit('messages.upsert',{type:'notify',messages:[msg('nova')]});
 assert.deepEqual(s.filaHistorico.contagem(),{history:2,live:1});await s.escoarHistorico({tipo:'live'});assert.equal(reports.filter(r=>r.u.endsWith('/eventos')).length,1);assert.equal(reports.at(-1).body.historical,false);
 await s.escoarHistorico({tipo:'history'});assert.equal(reports.filter(r=>r.u.endsWith('/eventos')&&r.body.historical===true).length,2);assert.deepEqual(s.filaHistorico.contagem(),{history:0,live:0});
 }finally{await s.encerrarTudo();}
}));
test('painel cabe em terminal móvel e mantém ação de saída',()=>{
 const lines=linhasDoPainel({versao:'6.3.0',painel:'Conectado',chips:[{nome:'Comercial',estado:'connected'}],aviso:'Conexao caiu. Tentando novamente.'},32,14);
 assert.ok(lines.length<=13);assert.ok(lines.every(l=>l.length<=32));assert.ok(lines.at(-1).includes('Ctrl+C'));
 assert.equal(textoSeguro('\x1b[2JNome\nsegredo',100),'Nomesegredo');
});
test('saída não interativa não repete status e não expõe console de bibliotecas',()=>{
 const writes=[];const fake={log(){},info(){},warn(){},error(){},debug(){},trace(){}};const original=fake.log;
 const ui=iniciarPainelTerminal({obterVisao:()=>({versao:'6.3.0',painel:'Conectado',chips:[]}),output:{isTTY:false,write:s=>writes.push(s)},consoleAlvo:fake});
 try{fake.log('rootKey: SECRET');ui.atualizar();ui.atualizar();assert.equal(writes.length,1);assert.equal(writes.join('').includes('SECRET'),false);}finally{ui.parar();}assert.equal(fake.log,original);
});
test('painel fixo redesenha apenas região usada, sem limpar tela inteira',()=>{
 const env=process.env.TERM;process.env.TERM='xterm';let state='Conectado';const writes=[];const fake={log(){},info(){},warn(){},error(){},debug(){},trace(){}};
 const ui=iniciarPainelTerminal({obterVisao:()=>({versao:'6.3.0',painel:state,chips:[]}),output:{isTTY:true,rows:40,columns:80,write:s=>writes.push(s)},consoleAlvo:fake});
 try{const n=writes.length;ui.atualizar();assert.equal(writes.length,n);state='Sem comunicacao';ui.atualizar();assert.ok(writes.join('').includes('\x1b['));assert.equal(writes.join('').includes('\x1b[2J'),false);}finally{ui.parar();if(env===undefined)delete process.env.TERM;else process.env.TERM=env;}
});

test('encerramento cancela até timers longos, sem atrasar restart de atualização',()=>temp(async root=>{
 const {s}=supervisor(root);s.geracoes.set('chip',1);s.agendarReconexao('chip',{mode:'qr',tentativa:9},300000);assert.equal(s.reconexoes.size,1);await s.encerrarTudo();assert.equal(s.reconexoes.size,0);
}));
