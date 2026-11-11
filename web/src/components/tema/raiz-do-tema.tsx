'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { definirTema } from '@/app/acoes-de-sessao';
import type { Tema } from '@/lib/tema';

interface ValorDoTema {
  tema: Tema;
  /** Troca a cor na hora e pede ao servidor para lembrar da escolha. */
  alternar: () => void;
}

const ContextoDoTema = createContext<ValorDoTema | null>(null);

/**
 * A raiz da página (<html> e <body>), dona do tema.
 *
 * O servidor diz qual é o tema só na chegada (lido do cookie, para a página não piscar).
 * Dali em diante quem manda é esta peça: se o servidor responder atrasado com o tema antigo
 * (acontece quando outra ação está em andamento na mesma hora), a tela não volta atrás.
 */
export function RaizDoTema({ temaInicial, children }: { temaInicial: Tema; children: ReactNode }) {
  const [tema, setTema] = useState<Tema>(temaInicial);

  const alternar = useCallback(() => {
    const novo: Tema = tema === 'claro' ? 'escuro' : 'claro';
    setTema(novo);
    // Se a gravação falhar, a cor já trocada continua valendo nesta visita.
    void definirTema(novo).catch(() => undefined);
  }, [tema]);

  const valor = useMemo(() => ({ tema, alternar }), [tema, alternar]);

  return (
    // data-scroll-behavior: a rolagem suave vale para âncoras, não para a troca de aba.
    <html lang="pt-BR" data-theme={tema === 'claro' ? 'light' : undefined} data-scroll-behavior="smooth">
      <body>
        <ContextoDoTema.Provider value={valor}>{children}</ContextoDoTema.Provider>
      </body>
    </html>
  );
}

export function useTema(): ValorDoTema {
  const valor = useContext(ContextoDoTema);
  if (!valor) throw new Error('useTema só funciona dentro de <RaizDoTema>.');
  return valor;
}
