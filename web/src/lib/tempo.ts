/** Fuso padrão da operação. O Brasil não tem mais horário de verão, então o deslocamento é fixo. */
export const FUSO_PADRAO = 'America/Fortaleza';

/**
 * Instante (em UTC) em que o dia de hoje começou no fuso informado.
 * Serve para contar "mensagens de hoje" do jeito que a pessoa enxerga o dia.
 */
export function inicioDoDia(agora: Date = new Date(), fuso: string = FUSO_PADRAO): Date {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(agora);

  const valor = (tipo: string) => Number(partes.find((parte) => parte.type === tipo)?.value ?? 0);
  // Quanto tempo já passou desde a meia-noite local.
  const decorrido = (valor('hour') * 3600 + valor('minute') * 60 + valor('second')) * 1000 + agora.getMilliseconds();
  return new Date(agora.getTime() - decorrido);
}
