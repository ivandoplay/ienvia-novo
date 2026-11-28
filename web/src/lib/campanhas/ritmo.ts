export function formatarEspera(segundos: number): string {
  const s = Math.max(0, Math.ceil(segundos));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}min` : m ? `${m}min ${s % 60}s` : `${s}s`;
}

export function segundosAte(data: string | null | undefined, agora: number): number | null {
  const instante = data ? Date.parse(data) : NaN;
  return Number.isFinite(instante) ? Math.max(0, Math.ceil((instante - agora) / 1000)) : null;
}

export function rotuloDoRitmo(status: string, motivo?: string | null): string {
  if (status === 'paused') return 'Campanha pausada';
  if (status === 'scheduled') return 'Aguardando horário agendado';
  if (status === 'completed') return 'Campanha concluída';
  if (status === 'cancelled') return 'Campanha cancelada';
  if (status !== 'running') return 'Aguardando confirmação';
  if (motivo === 'batch_rest') return 'Descanso entre lotes';
  if (motivo === 'block_interval') return 'Intervalo entre mensagens do contato';
  return 'Intervalo entre contatos';
}
