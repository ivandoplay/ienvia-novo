import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const motor=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function write(p,s){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s,{mode:0o755});}
async function temp(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'motor-linux-node-'));try{await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
const linux={skip:process.platform!=='linux',timeout:15000};
function env(root){return {...process.env,PATH:path.join(root,'bin')+':/usr/bin:/bin',TERMUX_VERSION:'',PREFIX:''};}
function preserve(root){write(path.join(root,'data/wa_auth/chip/creds.json'),'preservar');write(path.join(root,'data/fila-historico/item.json'),'preservar');}
function intact(root){assert.equal(fs.readFileSync(path.join(root,'data/wa_auth/chip/creds.json'),'utf8'),'preservar');assert.equal(fs.readFileSync(path.join(root,'data/fila-historico/item.json'),'utf8'),'preservar');}
test('Linux: iniciar recusa Node 22 e usa runtime 24 preparado sem apagar sessão',linux,()=>temp(async root=>{
 preserve(root);write(path.join(root,'scripts/iniciar.sh'),fs.readFileSync(path.join(motor,'scripts/iniciar.sh')));
 write(path.join(root,'bin/node'),'#!/usr/bin/env bash\nexit 1\n');
 write(path.join(root,'scripts/setup-linux.sh'),`#!/usr/bin/env bash\nset -e\ncd "$(dirname "$0")/.."\nmkdir -p .runtime/node/bin\nprintf '#!/usr/bin/env bash\\nexec "${process.execPath}" "$@"\\n' > .runtime/node/bin/node\nchmod +x .runtime/node/bin/node\ntouch preparado\n`);
 write(path.join(root,'src/index.mjs'),`import fs from 'node:fs';fs.writeFileSync('rodou',process.versions.node);`);
 const r=spawnSync('bash',[path.join(root,'scripts/iniciar.sh')],{cwd:root,env:env(root),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(root,'preparado')),true);assert.ok(Number(fs.readFileSync(path.join(root,'rodou'),'utf8').split('.')[0])>=24);intact(root);
}));
test('Linux: runtime portátil velho não vence Node 24 válido do PATH',linux,()=>temp(async root=>{
 preserve(root);write(path.join(root,'scripts/setup-linux.sh'),fs.readFileSync(path.join(motor,'scripts/setup-linux.sh')));write(path.join(root,'scripts/iniciar.sh'),'#!/bin/bash\n');write(path.join(root,'package.json'),'{"dependencies":{}}');
 const old='#!/bin/sh\nexit 1\n';write(path.join(root,'.runtime/node/bin/node'),old);
 write(path.join(root,'bin/node'),`#!/bin/sh\nexec "${process.execPath}" "$@"\n`);write(path.join(root,'bin/npm'),'#!/bin/sh\nmkdir -p node_modules\ntouch npm-usado\n');write(path.join(root,'bin/curl'),'#!/bin/sh\necho NAO-DEVERIA-BAIXAR >&2\nexit 90\n');
 const r=spawnSync('bash',[path.join(root,'scripts/setup-linux.sh')],{cwd:root,env:env(root),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(root,'npm-usado')),true);assert.equal(fs.readFileSync(path.join(root,'.runtime/node/bin/node'),'utf8'),old);intact(root);
}));
test('Linux: checksum inválido interrompe instalação antes de substituir runtime antigo',linux,()=>temp(async root=>{
 preserve(root);write(path.join(root,'scripts/setup-linux.sh'),fs.readFileSync(path.join(motor,'scripts/setup-linux.sh')));const old='#!/bin/sh\nexit 1\n';write(path.join(root,'.runtime/node/bin/node'),old);write(path.join(root,'bin/node'),old);
 write(path.join(root,'bin/uname'),'#!/bin/sh\necho x86_64\n');
 write(path.join(root,'bin/curl'),`#!/usr/bin/env bash\nout="\${@: -1}"\nif [[ "$2" == *SHASUMS256.txt ]];then printf '%064d  node-v24.22.3-linux-x64.tar.xz\\n' 0 > "$out";else printf 'arquivo-invalido' > "$out";fi\n`);
 const r=spawnSync('bash',[path.join(root,'scripts/setup-linux.sh')],{cwd:root,env:env(root),encoding:'utf8',timeout:10000});assert.notEqual(r.status,0);assert.equal(fs.readFileSync(path.join(root,'.runtime/node/bin/node'),'utf8'),old);intact(root);
}));
