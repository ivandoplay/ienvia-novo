import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function abrirFila(diretorio) {
  fs.mkdirSync(diretorio, { recursive: true, mode: 0o700 });
  // Classificação em memória, reconstruída dos arquivos legados a cada início.
  // Os arquivos continuam sendo a fonte durável; nenhuma migração destrutiva.
  const grupos = { live: new Set(), history: new Set() };
  const cursores = { live: '', history: '' };
  const grupoDe = new Map();
  let indexada = false;
  function classificar(nome, valor) {
    const grupo = valor.historical === false ? 'live' : 'history';
    grupos[grupo].add(nome);grupoDe.set(nome, grupo);
  }
  function indexar() {
    if (indexada) return;
    for (const nome of fs.readdirSync(diretorio).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      try { classificar(nome, JSON.parse(fs.readFileSync(path.join(diretorio,nome),'utf8'))); }
      catch { /* Arquivo ilegível é preservado, sem impedir o resto da fila. */ }
    }
    indexada = true;
  }
  function selecionar(grupo, limite) {
    const nomes = [...grupos[grupo]].sort();
    const cursor = cursores[grupo];
    const lote = [...nomes.filter(n=>n>cursor),...nomes.filter(n=>n<=cursor)].slice(0,limite);
    if (lote.length) cursores[grupo] = lote[lote.length-1];
    const itens=[];
    for (const nome of lote) {
      try { itens.push({nome,valor:JSON.parse(fs.readFileSync(path.join(diretorio,nome),'utf8'))}); }
      catch { grupos[grupo].delete(nome);grupoDe.delete(nome); }
    }
    return itens;
  }
  return {
    guardar(chave, valor) {
      const nome = crypto.createHash('sha256').update(chave).digest('hex') + '.json';
      const arquivo = path.join(diretorio, nome);
      if (fs.existsSync(arquivo)) return;
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
    contagem() { indexar();return {live:grupos.live.size,history:grupos.history.size}; },
    confirmar(nome) {
      if (!/^[a-f0-9]{64}\.json$/.test(nome)) throw new Error('Nome de entrada inválido.');
      try { fs.unlinkSync(path.join(diretorio,nome)); } catch(e) { if(e.code!=='ENOENT')throw e; }
      const grupo = grupoDe.get(nome);
      if (grupo) grupos[grupo].delete(nome);
      grupoDe.delete(nome);
    }
  };
}
