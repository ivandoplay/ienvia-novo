// Canais independentes: uma requisição de histórico lenta não bloqueia entradas novas.
// Cada canal permite só um lote em voo; o supervisor protege cada tipo também.
export function iniciarEscoamento(supervisor, { intervaloMs = 500, onError = console.warn } = {}) {
  let parado = false;
  const emCurso = new Map();
  function executar(tipo) {
    if (parado || emCurso.has(tipo)) return;
    const tarefa = Promise.resolve().then(()=>supervisor.escoarHistorico({tipo}))
      .catch(err=>{ try { onError(`[motor] Fila ${tipo} pendente: ${err.message}`); } catch { /* não interrompe a fila */ } })
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
