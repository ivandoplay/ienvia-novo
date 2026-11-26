import fs from 'node:fs';import path from 'node:path';
// Copia privada, somente de modulos sem dependencias externas. Permanece disponivel
// mesmo quando o rollback restaura uma versao anterior a existencia do supervisor.
const arquivos=['supervisor.mjs','dependencias.mjs','atualizador.mjs','assinatura.mjs','chave-publica.mjs','zip.mjs','bootstrap.mjs'];
export function prepararBootstrap(root) {
  const destino=path.join(root,'.runtime','ienvia-bootstrap');
  if(arquivos.every(f=>fs.existsSync(path.join(root,'src',f)))) {
    fs.mkdirSync(destino,{recursive:true,mode:0o700});
    for(const f of arquivos){const tmp=path.join(destino,f+'.tmp');fs.writeFileSync(tmp,fs.readFileSync(path.join(root,'src',f)),{mode:0o600});fs.renameSync(tmp,path.join(destino,f));}
  } else if(!fs.existsSync(path.join(destino,'supervisor.mjs')))throw new Error('Bootstrap incompleto. Reextraia o pacote sem apagar data/.');
  fs.writeFileSync(path.join(destino,'quarentena.mjs'),`
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const original=globalThis.fetch;
globalThis.fetch=async function(input,options){
 const response=await original(input,options);
 try {
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.pathname==='/api/motor/versao') {
   const r=JSON.parse(fs.readFileSync(path.join(root,'.runtime','ienvia-versao-rejeitada.json'),'utf8'));
   if(Date.now()-r.at<86400000){const e=await response.clone().json();if(e.manifest?.version===r.version)return new Response('{}',{status:503});}
  }
 }catch{}
 return response;
};
`,{mode:0o600});
  return destino;
}
