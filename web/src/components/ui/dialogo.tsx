'use client';

import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icone } from '@/components/ui/icone';

/**
 * Janela por cima da tela. Fecha com Esc, no botão ou clicando fora.
 * Quem abre controla: para fechar, basta deixar de renderizar. Ao sair, a janela é fechada
 * do jeito nativo, que devolve o foco para o botão que a abriu.
 */
export function Dialogo({
  titulo,
  aoFechar,
  children,
  largo = false,
}: {
  titulo: string;
  aoFechar: () => void;
  children: ReactNode;
  /** Janela larga, para conteúdo que precisa de espaço (uma foto, por exemplo). */
  largo?: boolean;
}) {
  const referencia = useRef<HTMLDialogElement>(null);
  const idTitulo = useId();

  useLayoutEffect(() => {
    const dialogo = referencia.current;
    if (!dialogo) return;
    if (!dialogo.open) dialogo.showModal();
    return () => {
      if (dialogo.open) dialogo.close();
    };
  }, []);

  return (
    <dialog
      ref={referencia}
      className={largo ? 'dialogo dialogo--largo' : 'dialogo'}
      aria-labelledby={idTitulo}
      onClose={(evento) => {
        // O aviso de "fechou" chega com atraso. Se a janela já foi reaberta (o modo de desenvolvimento
        // do React monta, desmonta e monta de novo), o aviso é antigo e não vale.
        if (!evento.currentTarget.open) aoFechar();
      }}
      onClick={(evento) => {
        // Clique no fundo escuro (fora da caixa) fecha.
        if (evento.target === evento.currentTarget) aoFechar();
      }}
    >
      <div className="dialogo-caixa">
        <div className="dialogo-topo">
          <h2 id={idTitulo}>{titulo}</h2>
          <button type="button" className="btn btn-secondary btn-sm btn-icon-only" onClick={aoFechar}>
            <Icone nome="fechar" className="icon-15" />
            <span className="so-leitor-de-tela">Fechar</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
