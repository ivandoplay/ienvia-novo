import fs from 'node:fs';
import path from 'node:path';
export function abrirDiagnosticoConexao(rootDir) {
  const arquivo=path.join(rootDir,'data','diagnostico-conexao.json');
  let dados={};
  function seguro(v) {
    if(!v||!['open','close'].includes(v.evento)||!Number.isFinite(v.em))return null;
    return {evento:v.evento,em:v.em,codigo:Number.isInteger(v.codigo)?v.codigo:null,reconexaoAutomatica:v.reconexaoAutomatica===true,sessaoExistente:v.sessaoExistente===true};
  }
  try { const anterior=JSON.parse(fs.readFileSync(arquivo,'utf8'));for(const [id,eventos] of Object.entries(anterior).slice(-100)){if(!Array.isArray(eventos))continue;dados[id]=eventos.map(seguro).filter(Boolean).slice(-20);} } catch {}
  return {
    registrar(id, evento) {
      const valor=seguro(evento);if(!valor)return;
      dados[id]=[...(dados[id]||[]),valor].slice(-20);
      if(Object.keys(dados).length>100)delete dados[Object.keys(dados)[0]];
      try {fs.mkdirSync(path.dirname(arquivo),{recursive:true,mode:0o700});fs.writeFileSync(arquivo+'.tmp',JSON.stringify(dados),{mode:0o600});fs.renameSync(arquivo+'.tmp',arquivo);} catch {}
    },
    resumo() {return structuredClone(dados);}
  };
}
