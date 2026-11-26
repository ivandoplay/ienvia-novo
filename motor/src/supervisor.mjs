import {prepararBootstrap} from './bootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepararDependencias, restaurarDependenciasAnteriores, descartarDependenciasAnteriores } from './dependencias.mjs';
import { recuperarAtualizacaoInterrompida, atualizacaoPendente, confirmarSaudeDaAtualizacao, reverterAtualizacaoSemSaude } from './atualizador.mjs';
export function adquirirTrava(root) {
  const dir=path.join(root,'.runtime');fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'ienvia-motor.lock');
  function criar(){const fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);}
  try{criar();}catch(e){
    if(e.code!=='EEXIST')throw e;
    let pid;try{pid=JSON.parse(fs.readFileSync(file,'utf8')).pid;}catch{}
    if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);throw new Error('Este motor ja esta aberto. Use a janela existente.');}catch(err){if(err.code!=='ESRCH')throw err;}}
    fs.unlinkSync(file);criar();
  }
  return ()=>{try{const d=JSON.parse(fs.readFileSync(file,'utf8'));if(d.pid===process.pid)fs.unlinkSync(file);}catch{}};
}
export async function supervisionar({rootDir,args=[],saudeMs=30000,inicioMs=180000,preparar=prepararDependencias,onLog=console.log}={}) {
  const liberar=adquirirTrava(rootDir);let filho;let encerrando=false;
  const parar=signal=>{encerrando=true;filho?.kill(signal);};
  const sigint=()=>parar('SIGINT'),sigterm=()=>parar('SIGTERM');
  process.on('SIGINT',sigint);process.on('SIGTERM',sigterm);
  try {
    if(recuperarAtualizacaoInterrompida(rootDir))restaurarDependenciasAnteriores(rootDir);
    const bootstrap=prepararBootstrap(rootDir);
    for(;;){
      try{await preparar(rootDir,{onLog});}catch(err){if(atualizacaoPendente(rootDir)){reverterAtualizacaoSemSaude(rootDir);restaurarDependenciasAnteriores(rootDir);onLog('[Ienvia] Componentes da atualizacao falharam. Voltando a versao anterior.');continue;}throw err;}
      const pendente=Boolean(atualizacaoPendente(rootDir));let saudavel=false;
      const code=await new Promise((resolve,reject)=>{
        let estavel,forcar;let pronto=false;
        filho=spawn(process.execPath,['--import',pathToFileURL(path.join(bootstrap,'quarentena.mjs')).href,path.join(rootDir,'src/index.mjs'),...args],{cwd:rootDir,env:{...process.env,IENVIA_SUPERVISIONADO:'1'},stdio:['inherit','inherit','inherit','ipc']});
        const limite=setTimeout(()=>{if(pendente&&!saudavel){filho.kill('SIGTERM');forcar=setTimeout(()=>filho.kill('SIGKILL'),20000);}},inicioMs);
        filho.on('message',m=>{if(m?.type!=='ienvia-ready'||pronto)return;pronto=true;estavel=setTimeout(()=>{try{if(pendente)confirmarSaudeDaAtualizacao(rootDir);saudavel=true;descartarDependenciasAnteriores(rootDir);if(pendente)onLog('[Ienvia] Atualizacao iniciada e confirmada.');}catch(err){onLog('[Ienvia] Nao foi possivel confirmar a atualizacao: '+err.message);filho.kill('SIGTERM');}},saudeMs);});
        const limpar=()=>{clearTimeout(limite);clearTimeout(estavel);clearTimeout(forcar);};
        filho.once('error',err=>{limpar();reject(err);});filho.once('exit',(c,s)=>{limpar();resolve(s?130:(c??1));});
      });
      filho=null;
      if(encerrando)return 130;
      // 42 so e um reinicio valido quando este processo acabou de aplicar
      // uma atualizacao. Uma candidata que termina com 42 antes da saude
      // nao pode criar um loop infinito de reinicios.
      if(code===42&&!pendente)continue;
      if(code===0&&args.includes('--check-update'))return 0;
      if(pendente&&!saudavel){reverterAtualizacaoSemSaude(rootDir);restaurarDependenciasAnteriores(rootDir);onLog('[Ienvia] A nova versao nao iniciou corretamente. Versao anterior restaurada; dados preservados.');continue;}
      return code;
    }
  } finally {process.off('SIGINT',sigint);process.off('SIGTERM',sigterm);liberar();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  supervisionar({rootDir:path.resolve(path.dirname(fileURLToPath(import.meta.url)),path.basename(path.dirname(fileURLToPath(import.meta.url)))==='ienvia-bootstrap'?'../..':'..'),args:process.argv.slice(2)}).then(c=>{process.exitCode=c;}).catch(e=>{console.error('[Ienvia]',e.message);process.exitCode=1;});
}
