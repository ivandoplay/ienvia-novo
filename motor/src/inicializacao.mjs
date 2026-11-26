import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const seguro=s=>{if(/[\r\n\0]/.test(s))throw new Error('Caminho invalido.');return s;};
const xml=s=>seguro(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const shell=s=>"'"+seguro(s).replace(/'/g,"'\\''")+"'";
const unit=s=>'"'+seguro(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%').replace(/\$/g,'$$')+'"';
export function planoInicializacao({rootDir,node=process.execPath,platform=process.platform,home=os.homedir(),termux=Boolean(process.env.TERMUX_VERSION||process.env.PREFIX?.includes('com.termux')),user=(process.env.USERDOMAIN?process.env.USERDOMAIN+'\\':'')+(process.env.USERNAME||'')}={}) {
  seguro(rootDir);seguro(node);const id='ienvia-'+crypto.createHash('sha256').update(rootDir).digest('hex').slice(0,10);
  if(termux){const file=path.join(home,'.termux','boot',id+'.sh');return {id,file,kind:'termux',content:`#!/data/data/com.termux/files/usr/bin/bash\ncommand -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock\ncd ${shell(rootDir)} || exit 1\nexec bash ./scripts/iniciar.sh --sem-pagina\n`,aviso:'Requer Termux:Boot instalado e aberto uma vez. Desative a economia de bateria; o Android ainda pode encerrar o aplicativo.'};}
  if(platform==='win32') {
    const entry=path.win32.join(rootDir,'src','supervisor.mjs');
    return {id,kind:'windows',file:path.join(rootDir,'.runtime',id+'.xml'),content:`<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>&quot;${xml(entry)}&quot; --sem-pagina</Arguments><WorkingDirectory>${xml(rootDir)}</WorkingDirectory></Exec></Actions></Task>`,aviso:'Inicia ao entrar na conta do Windows. Nao executa antes do login.'};
  }
  if(platform!=='linux')throw new Error('Inicializacao automatica disponivel para Windows, Linux e Termux.');
  return {id,kind:'linux',file:path.join(home,'.config','systemd','user',id+'.service'),content:`[Unit]\nDescription=Ienvia Motor local\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${unit(rootDir)}\nExecStart=${unit(node)} ${unit(path.join(rootDir,'src','supervisor.mjs'))} --sem-pagina\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=90\n\n[Install]\nWantedBy=default.target\n`,aviso:'Requer systemd --user. Em VPS sem login, a permanencia apos logout depende de linger configurado pelo administrador. Linux sem systemd exige o supervisor de servicos da distribuicao.'};
}
export function instalarInicializacao(plano,{executar=spawnSync}={}) {
  if(plano.kind==='linux') {const r=executar('systemctl',['--user','show-environment'],{encoding:'utf8'});if(r.error||r.status!==0)throw new Error('systemd --user indisponivel. Nada foi instalado. Use o gerenciador de servicos deste Linux.');}
  fs.mkdirSync(path.dirname(plano.file),{recursive:true,mode:0o700});
  if(fs.existsSync(plano.file))throw new Error('Inicializacao ja configurada. Arquivo existente preservado.');
  fs.writeFileSync(plano.file,plano.kind==='windows'?'\ufeff'+plano.content:plano.content,{encoding:plano.kind==='windows'?'utf16le':'utf8',mode:0o700,flag:'wx'});
  const run=(cmd,args)=>{const r=executar(cmd,args,{encoding:'utf8'});if(r.error||r.status!==0)throw new Error('Nao foi possivel ativar a inicializacao. Arquivo de configuracao preservado para diagnostico.');};
  if(plano.kind==='linux'){run('systemctl',['--user','daemon-reload']);run('systemctl',['--user','enable',plano.id+'.service']);}
  if(plano.kind==='windows')run('schtasks.exe',['/Create','/TN',plano.id,'/XML',plano.file]);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const rootDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const plano=planoInicializacao({rootDir});
    console.log(plano.aviso);
    if(!process.argv.includes('--ativar'))console.log('Opcional: execute novamente com --ativar para configurar. Nada foi alterado.');
    else {
      const cfg=JSON.parse(fs.readFileSync(path.join(rootDir,'data','motor.json'),'utf8'));if(!cfg.deviceToken)throw new Error('Vincule o motor ao painel antes de configurar a inicializacao.');
      instalarInicializacao(plano);console.log('Inicializacao configurada para o proximo login/boot compativel. Nenhum segundo motor foi aberto.');
    }
  } catch(e){console.error('[Ienvia]',e.message);process.exitCode=1;}
}
