import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
export function assinaturaDependencias(root) {
  const p=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  return crypto.createHash('sha256').update(JSON.stringify(p.dependencies||{})).update(fs.existsSync(path.join(root,'package-lock.json'))?fs.readFileSync(path.join(root,'package-lock.json')):'').digest('hex');
}
export async function prepararDependencias(root, { executar, onLog=console.log } = {}) {
  // Se a maquina caiu entre os dois renames, restaure o conjunto anterior
  // antes de tentar rede. Nao atribua o hash novo a componentes antigos.
  const anterior=path.join(root,'.runtime','ienvia-componentes-anteriores');
  if(!fs.existsSync(path.join(root,'node_modules'))&&fs.existsSync(anterior))fs.renameSync(anterior,path.join(root,'node_modules'));
  const stamp=assinaturaDependencias(root), arquivo=path.join(root,'node_modules','.ienvia-dependencias');
  if(fs.existsSync(arquivo)&&fs.readFileSync(arquivo,'utf8')===stamp)return false;
  onLog('[Ienvia] Verificando componentes. Sessoes e filas preservadas.');
  const runtime=path.join(root,'.runtime');fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  const stage=fs.mkdtempSync(path.join(runtime,'ienvia-componentes-'));
  fs.copyFileSync(path.join(root,'package.json'),path.join(stage,'package.json'));
  if(fs.existsSync(path.join(root,'package-lock.json')))fs.copyFileSync(path.join(root,'package-lock.json'),path.join(stage,'package-lock.json'));
  const args=fs.existsSync(path.join(root,'package-lock.json'))?['ci']:['install'];
  args.push('--omit=dev','--omit=optional','--ignore-scripts','--no-audit','--no-fund');
  try {
  if(executar)await executar(args,stage);
  else {
    const candidates=[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),'/usr/share/nodejs/npm/bin/npm-cli.js'];
    const cli=candidates.find(p=>fs.existsSync(p));
    const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,npm_config_allow_git:'all',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'url.https://github.com/.insteadOf',GIT_CONFIG_VALUE_0:'ssh://git@github.com/',GIT_CONFIG_KEY_1:'url.https://github.com/.insteadOf',GIT_CONFIG_VALUE_1:'git@github.com:'};
    await new Promise((resolve,reject)=>{
      const child=spawn(cli?process.execPath:(process.platform==='win32'?'npm.cmd':'npm'),cli?[cli,...args]:args,{cwd:stage,env,stdio:'inherit',shell:!cli&&process.platform==='win32'});
      child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Preparacao de componentes falhou. Verifique a rede; dados preservados.')));
    });
  }
  const novo=path.join(stage,'node_modules');fs.mkdirSync(novo,{recursive:true});fs.writeFileSync(path.join(novo,'.ienvia-dependencias'),stamp,{mode:0o600});
  const atual=path.join(root,'node_modules'),backup=path.join(runtime,'ienvia-componentes-anteriores');
  if(fs.existsSync(atual)) {
    if(fs.existsSync(backup))throw new Error('Componentes anteriores aguardam confirmacao. Reinicie para recuperar.');
    fs.renameSync(atual,backup);
  }
  try{fs.renameSync(novo,atual);}catch(e){if(fs.existsSync(backup)&&!fs.existsSync(atual))fs.renameSync(backup,atual);throw e;}
  return true;
  } finally {fs.rmSync(stage,{recursive:true,force:true});}
}

export function restaurarDependenciasAnteriores(root) {
  const backup=path.join(root,'.runtime','ienvia-componentes-anteriores');
  if(!fs.existsSync(backup))return false;
  const atual=path.join(root,'node_modules');fs.rmSync(atual,{recursive:true,force:true});fs.renameSync(backup,atual);return true;
}
export function descartarDependenciasAnteriores(root) {
  fs.rmSync(path.join(root,'.runtime','ienvia-componentes-anteriores'),{recursive:true,force:true});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--assinatura'))console.log(assinaturaDependencias(process.cwd()));
  else if(process.argv.includes('--preparar'))prepararDependencias(path.resolve(path.dirname(fileURLToPath(import.meta.url)),path.basename(path.dirname(fileURLToPath(import.meta.url)))==='ienvia-bootstrap'?'../..':'..')).catch(e=>{console.error('[Ienvia]',e.message);process.exitCode=1;});
}
