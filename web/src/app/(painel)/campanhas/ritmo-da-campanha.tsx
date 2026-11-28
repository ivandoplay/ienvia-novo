'use client';

import { useEffect, useState } from 'react';
import type { DetalheDaCampanha } from '@/lib/dados/campanhas';
import { formatarEspera, rotuloDoRitmo, segundosAte } from '@/lib/campanhas/ritmo';
import { carregarDetalheCampanha } from './acoes';

export function RitmoDaCampanha({ detalhe }: { detalhe: DetalheDaCampanha }) {
  return <RitmoSincronizado key={`${detalhe.campaign.id}:${detalhe.campaign.updated_at}:${detalhe.campaign.status}`} detalhe={detalhe} />;
}

function RitmoSincronizado({ detalhe }: { detalhe: DetalheDaCampanha }) {
  const [dados, setDados] = useState(detalhe);
  const [agora, setAgora] = useState(0);
  const [atualizado, setAtualizado] = useState(0);
  const [erro, setErro] = useState(false);
  useEffect(() => {
    let ativo = true;
    let ocupado = false;
    const inicio = setTimeout(() => { setAgora(Date.now()); setAtualizado(Date.now()); }, 0);
    const relogio = setInterval(() => setAgora(Date.now()), 1000);
    const consulta = setInterval(async () => {
      if (document.hidden || ocupado) return;
      ocupado = true;
      try {
        const res = await carregarDetalheCampanha(detalhe.campaign.id);
        if (!ativo) return;
        if (res.ok) { setDados(res.detalhe); setAtualizado(Date.now()); setErro(false); }
        else setErro(true);
      } catch { if (ativo) setErro(true); }
      finally { ocupado = false; }
    }, 15000);
    return () => { ativo = false; clearTimeout(inicio); clearInterval(relogio); clearInterval(consulta); };
  }, [detalhe]);
  const c = dados.campaign;
  const ativo = ['running', 'scheduled'].includes(c.status);
  const pendentes = dados.stats.queued;
  const espera = segundosAte(c.next_action_at ?? c.scheduled_for, agora);
  const antigo = erro || (atualizado > 0 && agora - atualizado > 45000);
  const alvo = c.batch_target;
  const contagem = c.batch_sent_count ?? 0;
  const descanso = ativo && c.rhythm_wait_reason === 'batch_rest' && !c.pause_detail;
  const hora = (data: string) => new Date(data).toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return <section className="f5-card f5-ritmo" aria-label="Ritmo da campanha">
    <div className="f5-card-topo"><div><h2 className="f5-card-titulo">Ritmo da campanha</h2><p className="f5-card-sub">{c.status === 'running' && c.pause_detail ? c.pause_detail : rotuloDoRitmo(c.status, c.rhythm_wait_reason)}</p></div><span className="badge">{pendentes} contato(s) pendente(s)</span></div>
    {antigo && <p role="status">Não foi possível atualizar. Previsões suspensas até sincronizar novamente.</p>}
    <div className="f5-ritmo-grade">
      <div><span className="f5-card-sub">Próxima ação prevista</span><p className="f5-ritmo-numero">{!ativo ? 'Sem contagem ativa' : !pendentes ? 'Aguardando conclusão' : antigo ? 'Dados desatualizados' : espera === null ? 'Aguardando agendamento' : espera === 0 ? 'Aguardando executor' : `Em ${formatarEspera(espera)}`}</p>{ativo && pendentes > 0 && !antigo && c.next_action_at && <p className="f5-card-sub">{hora(c.next_action_at)} · horário de Fortaleza</p>}</div>
      <div><span className="f5-card-sub">{descanso ? 'Próximo lote' : 'Lote atual'}</span><p className="f5-ritmo-numero">{alvo ? `${contagem} de ${alvo} contatos encaminhados` : 'Aguardando dados do lote'}</p>{alvo && <><progress aria-label="Contatos encaminhados no lote" max={alvo} value={Math.min(contagem, alvo)} /><p className="f5-card-sub">{Math.min(Math.max(0, alvo - contagem), pendentes)} contato(s) até o limite do lote ou fim da fila.</p></>}</div>
      <div><span className="f5-card-sub">Descanso entre lotes</span><p className="f5-ritmo-numero">{ativo && descanso && espera !== null && !antigo ? `Faltam ${formatarEspera(espera)}` : `${formatarEspera(c.cadence.batchPauseMinSec ?? 180)} a ${formatarEspera(c.cadence.batchPauseMaxSec ?? 420)}`}</p><p className="f5-card-sub">{ativo && descanso && c.rhythm_delay_sec ? `Pausa sorteada: ${formatarEspera(c.rhythm_delay_sec)}.` : 'Duração sorteada pelo executor ao fechar o lote.'}</p></div>
    </div>
    {c.pause_detail && <p>{c.pause_detail}</p>}
    <details><summary>Como interpretar os próximos envios</summary><p className="f5-card-sub">O executor agenda uma ação por vez. Os próximos 3 ou 5 horários ainda não estão definidos: dependem do sorteio dos intervalos, dos lotes, do chip e das confirmações. Não exibimos horários fictícios. Intervalo entre contatos: {formatarEspera(c.cadence.intervalMinSec ?? 35)} a {formatarEspera(c.cadence.intervalMaxSec ?? 80)}. Cada contato pode receber vários blocos de mensagem.</p></details>
    <p className="f5-card-sub">{atualizado ? `Última leitura há ${formatarEspera((agora - atualizado) / 1000)} · atualização automática a cada 15s.` : 'Sincronizando…'} Encaminhado ao motor não significa enviado ou entregue. O cronômetro é uma previsão, não uma confirmação.</p>
  </section>;
}
