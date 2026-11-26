import fs from 'node:fs';import path from 'node:path';import {assinaturaDependencias} from '../src/dependencias.mjs';
export function prepararSupervisor(root,motor){
 fs.mkdirSync(path.join(root,'src'),{recursive:true});
 for(const f of ['bootstrap.mjs','supervisor.mjs','dependencias.mjs','atualizador.mjs','assinatura.mjs','chave-publica.mjs','zip.mjs'])fs.copyFileSync(path.join(motor,'src',f),path.join(root,'src',f));
 if(!fs.existsSync(path.join(root,'package.json')))fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 fs.mkdirSync(path.join(root,'node_modules'),{recursive:true});fs.writeFileSync(path.join(root,'node_modules','.ienvia-dependencias'),assinaturaDependencias(root));
}
