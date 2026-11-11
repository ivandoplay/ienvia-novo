'use client';

import { useEffect } from 'react';

/** Quando uma aba quebra, o resto do painel continua de pé e a pessoa pode tentar de novo. */
export default function ErroNaAba({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[painel] erro ao montar a aba:', error);
  }, [error]);

  return (
    <div className="apoio">
      <div className="page-header">
        <div>
          <h1>Esta aba não abriu</h1>
          <p>Algo deu errado ao carregar as informações. Seus dados não foram alterados.</p>
        </div>
      </div>
      <div className="panel">
        <p className="apoio-texto">
          Tente de novo. Se continuar, avise o suporte{error.digest ? ` e informe o código ${error.digest}` : ''}.
        </p>
        <div className="apoio-acoes">
          <button type="button" className="btn btn-primary" onClick={reset}>
            Tentar de novo
          </button>
        </div>
      </div>
    </div>
  );
}
