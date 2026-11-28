import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {abrirDiagnosticoConexao} from '../src/diagnostico-conexao.mjs';
test('registro de conexão sobrevive ao restart, limita eventos e remove campos privados',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'motor-diag-'));try{
  const d=abrirDiagnosticoConexao(root);for(let i=0;i<25;i++)d.registrar('chip',{evento:'close',em:i,codigo:428,reconexaoAutomatica:true,error:'SEGREDO',token:'TOKEN'});
  const restored=abrirDiagnosticoConexao(root).resumo();assert.equal(restored.chip.length,20);assert.equal(restored.chip.at(-1).codigo,428);assert.ok(!JSON.stringify(restored).includes('SEGREDO'));assert.ok(!JSON.stringify(restored).includes('TOKEN'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
