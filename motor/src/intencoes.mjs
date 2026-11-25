import fs from 'node:fs';
import path from 'node:path';
// Persistência de intenção, não de credenciais. Um disconnect explícito prevalece após reinício.
export class IntencoesDeConexao {
  constructor(rootDir) {
    this.arquivo=path.join(rootDir,'data','conexoes-desejadas.json');this.ids=new Set();
    try { for(const id of JSON.parse(fs.readFileSync(this.arquivo,'utf8'))) if(typeof id==='string'&&/^[\w-]{1,100}$/.test(id))this.ids.add(id); } catch {}
  }
  tem(id) { return this.ids.has(id); }
  definir(id, ativo) {
    if(typeof id!=='string'||!/^[\w-]{1,100}$/.test(id))throw Error('Identificador de conexao invalido');
    ativo?this.ids.add(id):this.ids.delete(id);
    fs.mkdirSync(path.dirname(this.arquivo),{recursive:true,mode:0o700});
    const tmp=this.arquivo+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...this.ids]),{mode:0o600});fs.renameSync(tmp,this.arquivo);
  }
}
