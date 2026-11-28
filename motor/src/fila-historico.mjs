import { timestampHistorico, foraDaJanelaHistorica } from './janela-historico.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ignorarConversa(valor){
  try{const jid=JSON.parse(valor.msg)?.key?.remoteJid;return typeof jid==='string'&&(jid.endsWith('@g.us')||jid.endsWith('@broadcast')||jid.endsWith('@newsletter'));}catch{return false;}
}

export function abrirFila(diretorio, { diasHistorico = null } = {}) {
  fs.mkdirSync(diretorio, { recursive: true, mode: 0o700 });
  // Classificação em memória, reconstruída dos arquivos legados a cada início.
  // Os arquivos continuam sendo a fonte durável; nenhuma migração destrutiva.
  const grupos = { live: new Set(), history: new Set() };
  const vistos = {live:new Set(),history:new Set()};
  const datas=new Map();
  const caches={live:null,history:null};
  const grupoDe = new Map();
  const origens = new Map();
  let indexada = false;
  function classificar(nome, valor) {
    let msg;try{msg=JSON.parse(valor.msg);}catch{}
    const grupo = valor.historical === false ? 'live' : 'history';
    grupos[grupo].add(nome);grupoDe.set(nome, grupo);origens.set(nome, valor.instanceId);datas.set(nome,timestampHistorico(msg)||valor.queuedAt||fs.statSync(path.join(diretorio,nome)).mtimeMs);caches[grupo]=null;
  }
  function indexar() {
    if (indexada) return;
    for (const nome of fs.readdirSync(diretorio).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      try {
        const valor = JSON.parse(fs.readFileSync(path.join(diretorio,nome),'utf8'));
        if (ignorarConversa(valor)) {
          const destino=diretorio+'-nao-individuais';fs.mkdirSync(destino,{recursive:true,mode:0o700});fs.renameSync(path.join(diretorio,nome),path.join(destino,nome+'.'+crypto.randomUUID()));continue;
        }
        if (diasHistorico && valor.historical !== false && valor.msg && foraDaJanelaHistorica(JSON.parse(valor.msg), Date.now(), diasHistorico)) {
          const arquivo = path.join(diretorio, nome);
          const destino = path.join(diretorio + '-fora-da-janela', nome);
          fs.mkdirSync(path.dirname(destino), { recursive: true, mode: 0o700 });
          // Nunca sobrescrever nem apagar arquivo previamente preservado.
          const final = fs.existsSync(destino) ? destino + '.' + crypto.randomUUID() : destino;
          fs.renameSync(arquivo, final);
          continue;
        }
        classificar(nome, valor);
      }
      catch { /* Arquivo ilegível é preservado, sem impedir o resto da fila. */ }
    }
    indexada = true;
  }
  function selecionar(grupo, limite) {
    const nomes=caches[grupo] ||= [...grupos[grupo]].sort((a,b)=>(datas.get(b)-datas.get(a))||a.localeCompare(b));
    let disponiveis=nomes.filter(n=>!vistos[grupo].has(n));
    if(!disponiveis.length){vistos[grupo].clear();disponiveis=nomes;}
    const lote=disponiveis.slice(0,limite);for(const n of lote)vistos[grupo].add(n);
    const itens=[];
    for (const nome of lote) {
      try { itens.push({nome,valor:JSON.parse(fs.readFileSync(path.join(diretorio,nome),'utf8'))}); }
      catch { grupos[grupo].delete(nome);grupoDe.delete(nome); }
    }
    return itens;
  }
  return {
    guardar(chave, valor, { recuperarConteudo = false } = {}) {
      if(ignorarConversa(valor))return false;
      const nome = crypto.createHash('sha256').update(chave).digest('hex') + '.json';
      const arquivo = path.join(diretorio, nome);
      if (fs.existsSync(arquivo)) {
        if (!recuperarConteudo) return;
        // Somente preencher stub sem conteudo. Nao rebaixar mensagem ou categoria.
        const anterior = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
        if (JSON.parse(anterior.msg).message || !JSON.parse(valor.msg).message) return;
        valor = { ...valor, historical: anterior.historical };
      }
      const tmp = arquivo + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(valor), { mode: 0o600 });
      fs.renameSync(tmp, arquivo);
      if (indexada) classificar(nome, valor);
    },
    listar(limite = 20, tipo = 'all') {
      indexar();
      if (!['all','live','history'].includes(tipo)) throw new Error('Tipo de fila inválido.');
      if (tipo !== 'all') return selecionar(tipo,limite);
      const live = selecionar('live',limite);
      return [...live,...selecionar('history',Math.max(0,limite-live.length))];
    },
    haPendentes(tipo,aceitar=()=>true){indexar();return [...grupos[tipo]].some(n=>aceitar(n,origens.get(n)));},
    porInstancia() { indexar();const r={};for(const [nome,id] of origens){if(!id)continue;r[id] ||= {live:0,history:0};const g=grupoDe.get(nome);if(g)r[id][g]++;}return r; },
    contagem() { indexar();return {live:grupos.live.size,history:grupos.history.size}; },
    confirmar(nome) {
      if (!/^[a-f0-9]{64}\.json$/.test(nome)) throw new Error('Nome de entrada inválido.');
      try { fs.unlinkSync(path.join(diretorio,nome)); } catch(e) { if(e.code!=='ENOENT')throw e; }
      const grupo = grupoDe.get(nome);
      if (grupo) {grupos[grupo].delete(nome);vistos[grupo].delete(nome);caches[grupo]=null;}datas.delete(nome);
      grupoDe.delete(nome);origens.delete(nome);
    }
  };
}
