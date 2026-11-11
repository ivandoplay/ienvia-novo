'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { definirTema, sair } from '@/app/acoes-de-sessao';
import { Icone } from '@/components/ui/icone';
import type { Tema } from '@/lib/tema';

interface PropsDoMenuDaConta {
  aberto: boolean;
  aoFechar: () => void;
  usuario: { nome: string; login: string; papel: string };
  workspace: string;
  temaInicial: Tema;
}

/** Troca a cor na hora, sem esperar o servidor. */
function pintarTema(tema: Tema) {
  if (tema === 'claro') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}

/**
 * Folha "Conta e preferências": quem está logado, troca de tema e sair.
 * Usa o <dialog> nativo do navegador, que já cuida do foco e da tecla Esc.
 */
export function MenuDaConta({ aberto, aoFechar, usuario, workspace, temaInicial }: PropsDoMenuDaConta) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const [tema, setTema] = useState<Tema>(temaInicial);

  useEffect(() => {
    const elemento = dialogo.current;
    if (!elemento) return;
    if (aberto && !elemento.open) elemento.showModal();
    if (!aberto && elemento.open) elemento.close();
  }, [aberto]);

  function alternarTema() {
    const novo: Tema = tema === 'claro' ? 'escuro' : 'claro';
    setTema(novo);
    pintarTema(novo);
    // A escolha é guardada pelo servidor; se a gravação falhar, a cor já trocada continua valendo nesta visita.
    void definirTema(novo).catch(() => undefined);
  }

  /** Clique fora do cartão (no fundo escurecido) fecha a folha. */
  function aoClicar(evento: MouseEvent<HTMLDialogElement>) {
    if (evento.target !== dialogo.current) return;
    const caixa = evento.currentTarget.getBoundingClientRect();
    const dentro =
      evento.clientX >= caixa.left &&
      evento.clientX <= caixa.right &&
      evento.clientY >= caixa.top &&
      evento.clientY <= caixa.bottom;
    if (!dentro) aoFechar();
  }

  return (
    <dialog ref={dialogo} className="action-sheet" aria-label="Conta e preferências" onClose={aoFechar} onClick={aoClicar}>
      <div className="sheet-cabecalho">
        <div className="sheet-identidade">
          <strong className="sheet-nome">{usuario.nome}</strong>
          {usuario.login !== usuario.nome ? <span className="sheet-papel">{usuario.login}</span> : null}
          <span className="sheet-papel">
            {usuario.papel} · {workspace}
          </span>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={aoFechar}>
          Fechar
        </button>
      </div>

      <button type="button" className="sheet-item-btn" onClick={alternarTema}>
        <span className="sheet-item-esquerda">
          <Icone nome={tema === 'claro' ? 'lua' : 'sol'} />
          <span>{tema === 'claro' ? 'Modo escuro' : 'Modo claro'}</span>
        </span>
        <span className="sheet-item-dica">Alternar</span>
      </button>

      <form action={sair}>
        <button type="submit" className="sheet-item-btn danger">
          <span className="sheet-item-esquerda">
            <Icone nome="sair" />
            <span>Sair desta conta</span>
          </span>
        </button>
      </form>
    </dialog>
  );
}
