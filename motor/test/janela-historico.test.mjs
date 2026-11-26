import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {foraDaJanelaHistorica} from '../src/janela-historico.mjs';import {abrirFila} from '../src/fila-historico.mjs';
test('limite exato 30 dias, segundos, milissegundos, Long e timestamp desconhecido',()=>{
 const now=1800000000000;const old=now-31*86400000;assert.equal(foraDaJanelaHistorica({messageTimestamp:old/1000},now),true);assert.equal(foraDaJanelaHistorica({messageTimestamp:old},now),true);assert.equal(foraDaJanelaHistorica({messageTimestamp:now-30*86400000},now),false);assert.equal(foraDaJanelaHistorica({},now),false);assert.equal(foraDaJanelaHistorica({messageTimestamp:{low:old/1000,high:0}},now),true);
});
test('arquiva historico antigo sem apagar, conserva novas antigas e timestamp desconhecido',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'janela-'));try{
 const dir=path.join(root,'fila');const f=abrirFila(dir);const old={messageTimestamp:Math.floor(Date.now()/1000)-31*86400};f.guardar('antiga',{historical:true,msg:JSON.stringify(old)});f.guardar('nova',{historical:false,msg:JSON.stringify(old)});f.guardar('semhora',{historical:true,msg:'{}'});
 const atual=abrirFila(dir,{diasHistorico:30});assert.deepEqual(atual.contagem(),{live:1,history:1});assert.equal(fs.readdirSync(dir+'-fora-da-janela').length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir+'-fora-da-janela',fs.readdirSync(dir+'-fora-da-janela')[0]),'utf8')).msg,JSON.stringify(old));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
