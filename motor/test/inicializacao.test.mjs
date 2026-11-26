import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {planoInicializacao,instalarInicializacao} from '../src/inicializacao.mjs';
test('Windows gera tarefa sem senha, com diretorio correto e sem limite de execucao',()=>{
 const p=planoInicializacao({rootDir:'C:\\Meu Motor & Testes',node:'C:\\Node\\node.exe',platform:'win32',termux:false,user:'PC\\Jefferson'});assert.equal(p.kind,'windows');assert.ok(p.content.includes('&amp;'));assert.ok(p.content.includes('PT0S'));assert.ok(p.content.includes('InteractiveToken'));assert.ok(p.content.includes('supervisor.mjs'));
});
test('Linux escapa caminhos e nao presume acesso de administrador',()=>{
 const p=planoInicializacao({rootDir:'/home/eu/Ienvia % nome',node:'/usr/bin/node',platform:'linux',termux:false,home:'/home/eu'});assert.ok(p.content.includes('%%'));assert.ok(p.content.includes('Restart=on-failure'));assert.ok(p.file.includes('.config/systemd/user'));
});
test('Termux preserva aspas no caminho e informa dependencia de Boot',()=>{
 const p=planoInicializacao({rootDir:"/data/data/com.termux/files/home/Joao's Motor",platform:'linux',termux:true});assert.ok(p.content.includes("'\\''"));assert.ok(p.aviso.includes('Termux:Boot'));assert.ok(p.content.includes('termux-wake-lock'));
});
test('caminho com quebra de linha nao pode injetar diretivas',()=>{
 assert.throws(()=>planoInicializacao({rootDir:'/tmp/a\nExecStart=malicioso'}),/invalido/);
});
test('sem systemd nao grava arquivo; arquivo existente nunca e sobrescrito',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'motor-auto-'));try{
 const p=planoInicializacao({rootDir:root,platform:'linux',home:root,termux:false});assert.throws(()=>instalarInicializacao(p,{executar:()=>({status:1})}),/indisponivel/);assert.equal(fs.existsSync(p.file),false);
 const termux=planoInicializacao({rootDir:root,home:root,termux:true});instalarInicializacao(termux);assert.throws(()=>instalarInicializacao(termux),/preservado/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
