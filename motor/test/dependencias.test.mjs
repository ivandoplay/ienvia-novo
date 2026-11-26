import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {prepararDependencias,restaurarDependenciasAnteriores,descartarDependenciasAnteriores} from '../src/dependencias.mjs';
async function temp(fn){const r=fs.mkdtempSync(path.join(os.tmpdir(),'motor-deps-'));try{fs.writeFileSync(path.join(r,'package.json'),'{"dependencies":{"exemplo":"1.0.0"}}');fs.mkdirSync(path.join(r,'node_modules'));fs.writeFileSync(path.join(r,'node_modules/anterior'),'ok');await fn(r);}finally{fs.rmSync(r,{recursive:true,force:true});}}
test('falha de download nao remove componentes que ja funcionam',()=>temp(async r=>{
 await assert.rejects(()=>prepararDependencias(r,{onLog:()=>{},executar:async()=>{throw Error('offline');}}),/offline/);assert.equal(fs.readFileSync(path.join(r,'node_modules/anterior'),'utf8'),'ok');
}));
test('instala em staging, reaproveita stamp e permite rollback offline',()=>temp(async r=>{
 let n=0;const run=async(args,stage)=>{n++;assert.ok(args.includes('--ignore-scripts'));assert.ok(fs.existsSync(path.join(r,'node_modules/anterior')));fs.mkdirSync(path.join(stage,'node_modules'));fs.writeFileSync(path.join(stage,'node_modules/novo'),'novo');};
 assert.equal(await prepararDependencias(r,{executar:run,onLog:()=>{}}),true);assert.equal(await prepararDependencias(r,{executar:run,onLog:()=>{}}),false);assert.equal(n,1);assert.equal(restaurarDependenciasAnteriores(r),true);assert.ok(fs.existsSync(path.join(r,'node_modules/anterior')));descartarDependenciasAnteriores(r);
}));
test('queda entre renames recupera componentes antes de tentar download',()=>temp(async r=>{
 const runtime=path.join(r,'.runtime');fs.mkdirSync(runtime);fs.renameSync(path.join(r,'node_modules'),path.join(runtime,'ienvia-componentes-anteriores'));
 await assert.rejects(()=>prepararDependencias(r,{onLog:()=>{},executar:async()=>{assert.ok(fs.existsSync(path.join(r,'node_modules/anterior')));throw Error('offline');}}),/offline/);
 assert.equal(fs.readFileSync(path.join(r,'node_modules/anterior'),'utf8'),'ok');
}));
test('rollback preserva assinatura verdadeira; nao mascara componentes antigos como novos',()=>temp(async r=>{
 fs.writeFileSync(path.join(r,'node_modules/.ienvia-dependencias'),'assinatura-antiga');
 await prepararDependencias(r,{onLog:()=>{},executar:async(_,stage)=>fs.mkdirSync(path.join(stage,'node_modules'))});
 restaurarDependenciasAnteriores(r);assert.equal(fs.readFileSync(path.join(r,'node_modules/.ienvia-dependencias'),'utf8'),'assinatura-antiga');
}));
