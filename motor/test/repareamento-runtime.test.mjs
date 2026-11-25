import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const motor=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for (const origem of ['pulso','comandos']) {
  test(`runtime: 401 em ${origem} pede novo código no mesmo processo e salva novo vínculo`, {timeout:20000}, async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'motor-runtime-reparear-'));let server;let child;const requests=[];
    try {
      fs.cpSync(path.join(motor,'src'),path.join(root,'src'),{recursive:true});fs.copyFileSync(path.join(motor,'package.json'),path.join(root,'package.json'));
      fs.symlinkSync(path.join(motor,'node_modules'),path.join(root,'node_modules'),'junction');
      server=http.createServer(async(req,res)=>{
        let raw='';for await(const chunk of req)raw+=chunk;requests.push({url:req.url,token:req.headers['x-ienvia-motor-token'],body:raw?JSON.parse(raw):null});
        const old=req.headers['x-ienvia-motor-token']==='old-test-token';
        if(old&&req.url===`/api/motor/${origem}`){res.writeHead(401,{'content-type':'application/json'});res.end('{"erro":"revogado"}');return;}
        if(req.url==='/api/motor/parear'){res.setHeader('content-type','application/json');res.end(JSON.stringify({device_token:'new-test-token',executor_id:'new-executor',workspace_id:'same-workspace',display_name:'Teste'}));return;}
        if(req.url==='/api/motor/versao'){res.writeHead(503);res.end('{}');return;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({instances:[],commands:[],result:'ok',confirmed:[]}));
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
      fs.mkdirSync(path.join(root,'data/wa_auth/chip'),{recursive:true});fs.writeFileSync(path.join(root,'data/wa_auth/chip/creds.json'),'preservado');
      fs.writeFileSync(path.join(root,'data/motor.json'),JSON.stringify({panelUrl:url,deviceToken:'old-test-token',executorId:'old-executor',workspaceId:'same-workspace'}));
      const code=`import {rodarLoopPrincipal} from ${JSON.stringify(pathToFileURL(path.join(root,'src/index.mjs')).href)}; process.stdin.isTTY=true; const args={url:${JSON.stringify(url)},semPagina:true,once:false}; const r=await rodarLoopPrincipal(args); if(r!=='reparear')throw Error('nao voltou ao pareamento'); await rodarLoopPrincipal({...args,once:true});`;
      const env={...process.env};delete env.IENVIA_MOTOR_TOKEN;delete env.IENVIA_PANEL_URL;
      child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:root,env,stdio:['pipe','pipe','pipe']});let output='';let asked=false;
      child.stdout.on('data',chunk=>{output+=chunk; if(!asked&&output.includes('Cole o novo código')){asked=true;child.stdin.write('IENV-AAAA-BBBB\n');}});child.stderr.on('data',chunk=>{output+=chunk;});
      const timer=setTimeout(()=>child.kill('SIGKILL'),15000);let result;try {result=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));} finally{clearTimeout(timer);}
      assert.equal(result.code,0,output);assert.equal(asked,true,output);const cfg=JSON.parse(fs.readFileSync(path.join(root,'data/motor.json'),'utf8'));assert.equal(cfg.deviceToken,'new-test-token');assert.equal(cfg.executorId,'new-executor');assert.equal(fs.readFileSync(path.join(root,'data/wa_auth/chip/creds.json'),'utf8'),'preservado');
      assert.equal(requests.filter(r=>r.url==='/api/motor/parear').length,1);assert.ok(requests.some(r=>r.url==='/api/motor/pulso'&&r.token==='new-test-token'));
    } finally {child?.kill();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
  });
}
