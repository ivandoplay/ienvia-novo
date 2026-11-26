import {prepararSupervisor} from './ajudar-supervisor.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const motor=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const modo of ['shell','guiado'])test(`launcher ${modo} reinicia código 42 sem intervenção`,{timeout:10000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'motor-launcher-'));let child;
 try{
  fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(root,'data/motor.json'),JSON.stringify({deviceToken:'test-salvo',panelUrl:'https://example.invalid'}));
  fs.writeFileSync(path.join(root,'src/index.mjs'),`import fs from 'node:fs';let n=0;try{n=Number(fs.readFileSync('data/starts','utf8'));}catch{}fs.writeFileSync('data/starts',String(n+1));process.exitCode=n===0?42:0;`);
  for(const f of ['src/iniciar-guiado.mjs','src/config.mjs','scripts/iniciar.sh'])fs.copyFileSync(path.join(motor,f),path.join(root,f));
  prepararSupervisor(root,motor);
  const executable=modo==='shell'?'bash':process.execPath;const args=modo==='shell'?[path.join(root,'scripts/iniciar.sh')]:[path.join(root,'src/iniciar-guiado.mjs')];
  child=spawn(executable,args,{cwd:root,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});let text='';child.stderr.on('data',b=>{text+=b;});
  const result=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  assert.equal(result.code,0,text);assert.equal(fs.readFileSync(path.join(root,'data/starts'),'utf8'),'2');
 }finally{child?.kill();fs.rmSync(root,{recursive:true,force:true});}
});
