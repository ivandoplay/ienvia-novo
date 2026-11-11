'use client';

import { useSyncExternalStore } from 'react';
import { horaMinuto, saudacao } from '@/lib/formato';

/** Avisa a cada 20 segundos para o relógio acompanhar a virada do minuto. */
function assinarRelogio(avisar: () => void) {
  const intervalo = window.setInterval(avisar, 20_000);
  return () => window.clearInterval(intervalo);
}

/** O "agora" muda o tempo todo; para a tela só interessa o minuto atual. */
function minutoAtual(): number {
  return Math.floor(Date.now() / 60_000);
}

/**
 * "Boa tarde" + relógio. Depende da hora do aparelho de quem está olhando, por isso
 * só é calculado no navegador (no servidor aparece um traço, para não haver divergência).
 */
export function Saudacao() {
  const minuto = useSyncExternalStore(assinarRelogio, minutoAtual, () => null);
  const agora = minuto === null ? null : new Date(minuto * 60_000);

  return (
    <span className="visao-ola-linha">
      <h1 className="visao-ola-titulo">{agora ? saudacao(agora.getHours()) : 'Olá'}</h1>
      <span className="visao-relogio" aria-hidden="true">
        {agora ? horaMinuto(agora) : '--:--'}
      </span>
    </span>
  );
}
