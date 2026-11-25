// Canais independentes: uma requisição de histórico lenta não bloqueia entradas novas.
// Cada canal permite só um lote em voo; o supervisor protege cada tipo também.
export function iniciarEscoamento(supervisor, { intervaloMs = 500, onError = console.warn } = {}) {
  let parado = false;
  const emCurso = new Map();
  const falhas = new Map();
  const proxima = new Map();
  function executar(tipo) {
    if (parado || emCurso.has(tipo) || (proxima.get(tipo) || 0) > Date.now()) return;
    const tarefa = Promise.resolve().then(()=>supervisor.escoarHistorico({tipo}))
      .then(() => { falhas.delete(tipo); proxima.delete(tipo); })
      .catch(err=>{ const n=(falhas.get(tipo)||0)+1; falhas.set(tipo,n); proxima.set(tipo,Date.now()+Math.min(60000,1000*2**Math.min(n,6))); if(n===1 || n%10===0) try { onError(`[motor] Fila ${tipo} pendente. Tentando novamente automaticamente.`); } catch { /* não interrompe a fila */ } })
      .finally(()=>emCurso.delete(tipo));
    emCurso.set(tipo,tarefa);
  }
  // O primeiro scan classifica também as mensagens vivas dos pacotes antigos.
  executar('live');executar('history');executar('receipts');
  const timer=setInterval(()=>{executar('live');executar('history');executar('receipts');},intervaloMs);
  return async function parar() {
    parado=true;clearInterval(timer);
    await Promise.allSettled([...emCurso.values()]);
  };
}
