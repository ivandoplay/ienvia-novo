'use client';

import { useId } from 'react';

/**
 * Liga/desliga com título e explicação. Por baixo é uma caixa de marcar de verdade,
 * então funciona com teclado (espaço) e com leitor de tela ("ligado" / "desligado").
 */
export function Interruptor({
  titulo,
  descricao,
  ligado,
  aoMudar,
  desativado = false,
}: {
  titulo: string;
  descricao?: string;
  ligado: boolean;
  aoMudar: (ligado: boolean) => void;
  desativado?: boolean;
}) {
  const id = useId();
  const idDescricao = `${id}-descricao`;
  return (
    <div className="interruptor">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={ligado}
        disabled={desativado}
        aria-describedby={descricao ? idDescricao : undefined}
        onChange={(evento) => aoMudar(evento.target.checked)}
      />
      <div className="interruptor-texto">
        <label htmlFor={id}>{titulo}</label>
        {descricao && <p id={idDescricao}>{descricao}</p>}
      </div>
    </div>
  );
}
