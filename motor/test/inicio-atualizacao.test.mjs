import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {serializarManifestoCanonico} from '../src/assinatura.mjs';import {intervaloDeAtualizacao,CADENCIA_ATUALIZACAO_MS} from '../src/agenda-atualizacao.mjs';
const motor=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('cadencia de 15 minutos com dispersao menor que 1 minuto',()=>{assert.equal(CADENCIA_ATUALIZACAO_MS,900000);assert.equal(intervaloDeAtualizacao(()=>0),900000);assert.ok(intervaloDeAtualizacao(()=>1)<960000);});
for(const offline of [false,true])test(`consulta de inicio ocorre antes de heartbeat; servidor ${offline?'indisponivel':'assinado'}`,{timeout:12000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'motor-inicio-'));let child;let timer;
 const seen=[];let pulse;
 const chegou=new Promise(resolve=>{pulse=resolve;});
 const keys=crypto.generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const manifest={version:JSON.parse(fs.readFileSync(path.join(motor,'package.json'),'utf8')).version,sha256:'a'.repeat(64),size:100,published_at:'2026-11-12T00:00:00Z',min_node_major:24};
 const server=http.createServer((req,res)=>{seen.push(req.url);res.setHeader('content-type','application/json');if(req.url==='/api/motor/versao'){res.statusCode=offline?503:200;res.end(JSON.stringify({manifest,algorithm:'ed25519',signature:crypto.sign(null,Buffer.from(serializarManifestoCanonico(manifest)),keys.privateKey).toString('base64')}));}else{res.end(JSON.stringify({result:'ok',instances:[],commands:[]}));if(req.url==='/api/motor/pulso')pulse();}});
 try{
 fs.cpSync(path.join(motor,'src'),path.join(root,'src'),{recursive:true});fs.copyFileSync(path.join(motor,'package.json'),path.join(root,'package.json'));fs.symlinkSync(path.join(motor,'node_modules'),path.join(root,'node_modules'),'junction');
 fs.writeFileSync(path.join(root,'src/chave-publica.mjs'),`export const CHAVE_PUBLICA_ATUALIZACAO_MOTOR=${JSON.stringify(keys.publicKey)};`);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/motor.json'),JSON.stringify({deviceToken:'dummy-test',panelUrl:url}));
 child=spawn(process.execPath,[path.join(root,'src/index.mjs'),'--sem-pagina'],{cwd:root,env:{...process.env,IENVIA_SUPERVISIONADO:'1'},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',b=>{err+=b;});child.stdout.resume();
 await Promise.race([chegou,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Sem heartbeat: '+err)),8000);})]);assert.equal(seen[0],'/api/motor/versao');assert.ok(seen.includes('/api/motor/pulso'));
 child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
 }finally{clearTimeout(timer);child?.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
