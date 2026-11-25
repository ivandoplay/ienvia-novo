// A tela contém somente estado operacional, nunca payloads, tokens ou chaves do WhatsApp.
export function textoSeguro(valor, max = 60) {
  return String(valor ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
}
export function linhasDoPainel(visao, largura = 70, altura = 100) {
  const w = Math.max(20, Math.min(78, largura || 70));
  const linhas = ['IENVIA | MOTOR LOCAL', '-'.repeat(w), `Versao: ${visao.versao}`, `Painel: ${visao.painel}`, '', 'WHATSAPP'];
  const estados = { connected: 'Conectado', connecting: 'Conectando', reconnecting: 'Reconectando', disconnected: 'Desconectado', pairing: 'Aguardando pareamento' };
  for (const chip of (visao.chips || []).slice(0, 8)) linhas.push(`${textoSeguro(chip.nome, 20)}: ${estados[chip.estado] || 'Aguardando'}${chip.emSegundos ? ` (${chip.emSegundos}s)` : ''}`);
  if (!visao.chips?.length) linhas.push('Nenhum numero ativo');
  if ((visao.chips?.length || 0) > 8) linhas.push(`+ ${visao.chips.length - 8} numeros`);
  linhas.push('', 'ATIVIDADE', `Envios em andamento: ${visao.envios || 0}`, `Entradas pendentes: ${visao.live || 0}`, `Historico pendente: ${visao.history || 0}`, `Historico recebido: ${visao.recebidas || 0}`, `Sincronizacao: ${visao.sincronizacao || 'Aguardando dados'}`, '', 'ATENCAO', visao.aviso || 'Tudo certo. Mantenha esta janela aberta.', '-'.repeat(w), 'Ctrl+C: encerrar com seguranca');
  if (linhas.length > altura - 1) {
    const aviso=textoSeguro(visao.aviso || 'Operacao normal. Nao feche esta janela.', 200);
    const compactas=[`IENVIA ${visao.versao}`, `Painel: ${visao.painel}`, ...(visao.chips || []).slice(0,3).map(c=>`${textoSeguro(c.nome,14)}: ${estados[c.estado] || 'Aguardando'}`), `Filas: ${visao.live||0} novas / ${visao.history||0} antigas`, `Historico recebido: ${visao.recebidas||0}`, visao.sincronizacao || 'Aguardando WhatsApp'];
    for(let i=0; i<aviso.length && i<w*3; i+=w) compactas.push(aviso.slice(i,i+w));
    return [...compactas.slice(0, Math.max(1, altura-2)), 'Ctrl+C: encerrar'].map(l=>textoSeguro(l,w));
  }
  return linhas.map(l => textoSeguro(l, w));
}
export function iniciarPainelTerminal({ obterVisao, output = process.stdout, consoleAlvo = console, intervaloMs = 1500 }) {
  const originais = Object.fromEntries(['log','info','warn','error','debug','trace'].map(k => [k, consoleAlvo[k]]));
  let anterior = ''; let altura = 0; let fechado = false; let ultimoAviso = '';
  function render() {
    if (fechado) return;
    const visao = obterVisao();
    const linhas = linhasDoPainel(visao, Math.max(20, (output.columns || 71) - 1), output.rows || 100);
    // Um terminal muito baixo usa resumo, evitando rolagem/cursor quebrado no teclado do Termux.
    const fixo = output.isTTY && (!output.rows || output.rows > linhas.length + 1) && process.env.TERM !== 'dumb';
    const atual = linhas.join('\n');
    if (fixo) {
      if (atual === anterior) return;
      if (altura) output.write(`\x1b[${altura}A`);
      const n = Math.max(altura, linhas.length);
      const colorir=(linha,i)=> {
        if(process.env.NO_COLOR !== undefined)return linha;
        const cor=i===0?'1;36':/ATENCAO|Reconectando|Sem comunicacao|Desconectado/.test(linha)?'33':/Conectado/.test(linha)?'32':/^-+$/.test(linha)?'2':'0';
        return `\x1b[${cor}m${linha}\x1b[0m`;
      };
      for (let i=0; i<n; i++) output.write(`\r\x1b[2K${colorir(linhas[i] || '',i)}\n`);
      altura = n;
    } else {
      // Não imprimir contadores a cada ciclo em logs, serviços ou terminais estreitos.
      const resumo = `Ienvia ${visao.versao} | Painel: ${visao.painel} | ${visao.chips?.map(c => textoSeguro(c.nome,20)+': '+textoSeguro(c.estado,20)).join(' | ') || 'Sem chips'} | ${visao.aviso || 'Em operacao'}`;
      if (resumo !== ultimoAviso) { output.write(textoSeguro(resumo, 400)+'\n'); ultimoAviso=resumo; }
    }
    anterior=atual;
  }
  // Bibliotecas podem usar console diretamente e despejar material de sessão.
  // A UI exibe apenas estados controlados; erros técnicos não são reproduzidos crus.
  for (const k of Object.keys(originais)) consoleAlvo[k] = () => {};
  const seguro = () => { try { render(); } catch { /* falha visual nunca interrompe filas */ } };
  const timer=setInterval(seguro, intervaloMs); timer.unref?.(); seguro();
  return { atualizar: seguro, parar() { if(fechado)return; fechado=true; clearInterval(timer); for(const k of Object.keys(originais)) consoleAlvo[k]=originais[k]; } };
}
