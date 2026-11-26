import {prepararSupervisor} from './ajudar-supervisor.mjs';import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {aplicarAtualizacaoAtomica,atualizacaoPendente,confirmarSaudeDaAtualizacao,reverterAtualizacaoSemSaude,recuperarAtualizacaoInterrompida} from '../src/atualizador.mjs';
import {supervisionar,adquirirTrava} from '../src/supervisor.mjs';import {criarZipDeTeste} from './ajudar-zip.mjs';
const antigo="import fs from 'node:fs';fs.writeFileSync('data/voltou','ok');";
async function temp(fn){const r=fs.mkdtempSync(path.join(os.tmpdir(),'motor-saude-'));try{fs.mkdirSync(path.join(r,'src'));fs.mkdirSync(path.join(r,'data'));fs.writeFileSync(path.join(r,'data/creds'),'preservar');fs.writeFileSync(path.join(r,'src/index.mjs'),antigo);fs.writeFileSync(path.join(r,'package.json'),'{"type":"module"}');prepararSupervisor(r,path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));await fn(r);}finally{fs.rmSync(r,{recursive:true,force:true});}}
function instalar(r,novo){aplicarAtualizacaoAtomica({rootDir:r,zipBuffer:criarZipDeTeste([{path:'ienvia-motor/src/index.mjs',content:novo}]),aguardarSaude:true,newVersion:'6.4.0'});}
test('backup de atualizacao permanece ate confirmacao de saude',()=>temp(async r=>{
 instalar(r,'// nova');assert.ok(atualizacaoPendente(r));assert.equal(recuperarAtualizacaoInterrompida(r),false);assert.ok(atualizacaoPendente(r));assert.equal(confirmarSaudeDaAtualizacao(r),true);assert.equal(atualizacaoPendente(r),null);assert.equal(fs.readFileSync(path.join(r,'data/creds'),'utf8'),'preservar');
}));
test('falha antes da saude volta a versao anterior sem apagar dados',()=>temp(async r=>{
 instalar(r,"throw Error('falha simulada');");const c=await supervisionar({rootDir:r,preparar:async()=>{},onLog:()=>{},saudeMs:20,inicioMs:500});assert.equal(c,0);assert.equal(fs.readFileSync(path.join(r,'src/index.mjs'),'utf8'),antigo);assert.equal(fs.readFileSync(path.join(r,'data/creds'),'utf8'),'preservar');assert.equal(fs.readFileSync(path.join(r,'data/voltou'),'utf8'),'ok');assert.equal(JSON.parse(fs.readFileSync(path.join(r,'.runtime/ienvia-versao-rejeitada.json'))).version,'6.4.0');
}));
test('processo pronto e estavel confirma nova versao',()=>temp(async r=>{
 instalar(r,"process.send({type:'ienvia-ready'});setTimeout(()=>{},150);");const c=await supervisionar({rootDir:r,preparar:async()=>{},onLog:()=>{},saudeMs:20,inicioMs:500});assert.equal(c,0);assert.equal(atualizacaoPendente(r),null);assert.equal(fs.existsSync(path.join(r,'data/voltou')),false);
}));
test('processo que trava antes do sinal pronto sofre rollback',()=>temp(async r=>{
 instalar(r,'setInterval(()=>{},1000);');const c=await supervisionar({rootDir:r,preparar:async()=>{},onLog:()=>{},saudeMs:20,inicioMs:100});assert.equal(c,0);assert.equal(fs.readFileSync(path.join(r,'src/index.mjs'),'utf8'),antigo);
}));
test('segunda instancia e bloqueada; trava e liberada e trava obsoleta recuperada',()=>temp(async r=>{
 const free=adquirirTrava(r);assert.throws(()=>adquirirTrava(r),/ja esta aberto/);free();fs.writeFileSync(path.join(r,'.runtime/ienvia-motor.lock'),'{"pid":999999999}');adquirirTrava(r)();
}));
test('reversao explicita preserva sessoes e nao reverte duas vezes',()=>temp(async r=>{
 instalar(r,'// nova');assert.equal(reverterAtualizacaoSemSaude(r),true);assert.equal(reverterAtualizacaoSemSaude(r),false);assert.equal(fs.readFileSync(path.join(r,'src/index.mjs'),'utf8'),antigo);
}));
test('bootstrap continua disponivel apos rollback de primeiro upgrade e reinicia offline',()=>temp(async r=>{
 const motor=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const added=['supervisor.mjs','dependencias.mjs','bootstrap.mjs'];for(const f of added)fs.unlinkSync(path.join(r,'src',f));
 const files=[{path:'ienvia-motor/src/index.mjs',content:"throw Error('nova falha');"},...added.map(f=>({path:'ienvia-motor/src/'+f,content:fs.readFileSync(path.join(motor,'src',f))}))];
 aplicarAtualizacaoAtomica({rootDir:r,zipBuffer:criarZipDeTeste(files),aguardarSaude:true,newVersion:'6.4.0'});
 assert.equal(await supervisionar({rootDir:r,preparar:async()=>{},onLog:()=>{},saudeMs:20,inicioMs:500}),0);
 assert.equal(fs.existsSync(path.join(r,'src/supervisor.mjs')),false);assert.equal(fs.existsSync(path.join(r,'.runtime/ienvia-bootstrap/supervisor.mjs')),true);
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[path.join(r,'.runtime/ienvia-bootstrap/supervisor.mjs')],{cwd:r,stdio:'pipe'});let err='';child.stderr.on('data',b=>{err+=b;});const c=await new Promise(resolve=>child.once('exit',resolve));assert.equal(c,0,err);
}));
test('candidata com saida 42 antes da saude sofre rollback em vez de loop',()=>temp(async r=>{
 instalar(r,'process.exit(42);');assert.equal(await supervisionar({rootDir:r,preparar:async()=>{},onLog:()=>{},saudeMs:20,inicioMs:500}),0);assert.equal(fs.readFileSync(path.join(r,'src/index.mjs'),'utf8'),antigo);
}));
