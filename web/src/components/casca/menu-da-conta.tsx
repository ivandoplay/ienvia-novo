'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { sair, selecionarWorkspaceAtivo } from '@/app/acoes-de-sessao';
import { useTema } from '@/components/tema/raiz-do-tema';
import { Icone } from '@/components/ui/icone';
import type { WorkspaceParaTroca } from './casca';

interface PropsDoMenuDaConta {
  aberto: boolean;
  aoFechar: () => void;
  usuario: { nome: string; login: string; papel: string };
  workspace: string;
  workspaceAtivoId?: string | null;
  workspaces?: WorkspaceParaTroca[];
  emModoSuporte?: boolean;
}

/**
 * Folha "Conta e preferências": quem está logado, troca de workspace, tema e sair.
 * Usa o <dialog> nativo do navegador, que já cuida do foco e da tecla Esc.
 */
export function MenuDaConta({
  aberto,
  aoFechar,
  usuario,
  workspace,
  workspaceAtivoId = null,
  workspaces = [],
  emModoSuporte = false,
}: PropsDoMenuDaConta) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const { tema, alternar: alternarTema } = useTema();
  const router = useRouter();
  const [trocandoId, setTrocandoId] = useState<string | null>(null);

  useEffect(() => {
    const elemento = dialogo.current;
    if (!elemento) return;
    if (aberto && !elemento.open) elemento.showModal();
    if (!aberto && elemento.open) elemento.close();
  }, [aberto]);

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

  async function trocarWorkspace(id: string) {
    setTrocandoId(id);
    const res = await selecionarWorkspaceAtivo(id);
    setTrocandoId(null);
    if (res.ok) {
      aoFechar();
      router.refresh();
    }
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

      {!emModoSuporte && workspaces.length > 1 ? (
        <div className="sheet-ws-box">
          <div className="sheet-ws-label">Trocar de workspace</div>
          <div className="sheet-ws-list">
            {workspaces.map((ws) => {
              const atual = ws.id === workspaceAtivoId;
              return (
                <button
                  key={ws.id}
                  type="button"
                  className={atual ? 'sheet-ws-item ativo' : 'sheet-ws-item'}
                  disabled={atual || trocandoId !== null}
                  onClick={() => trocarWorkspace(ws.id)}
                >
                  <span>{ws.nome}</span>
                  <span className="sheet-item-dica">{atual ? 'Ativo' : ws.papel === 'owner' ? 'Dono' : 'Atendente'}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <button type="button" className="sheet-item-btn" onClick={alternarTema}>
        <span className="sheet-item-esquerda">
          <Icone nome={tema === 'claro' ? 'lua' : 'sol'} />
          <span>{tema === 'claro' ? 'Modo escuro' : 'Modo claro'}</span>
        </span>
        <span className="sheet-item-dica">Alternar</span>
      </button>

      <Link href="/configuracoes" className="sheet-item-btn" onClick={aoFechar}>
        <span className="sheet-item-esquerda">
          <Icone nome="configuracoes" />
          <span>Configurações gerais</span>
        </span>
        <span className="sheet-item-dica">Abrir</span>
      </Link>

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
