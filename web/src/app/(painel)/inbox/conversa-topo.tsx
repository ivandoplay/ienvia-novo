'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icone } from '@/components/ui/icone';
import { Dialogo } from '@/components/ui/dialogo';
import { atalhoDeHorario, deInputDateTimeLocal, paraInputDateTimeLocal } from '@/lib/inbox/regras';
import type { PessoaDoWorkspace } from '@/lib/dados/inbox';

/**
 * Menu "Mais" do topo da conversa.
 *
 * O botão é um `aria-expanded` + `aria-controls` apontando para a lista de ações, que só existe quando
 * aberta. Fecha de quatro jeitos, os quatro que a pessoa espera:
 *  - Esc (devolvendo o foco para o botão),
 *  - clicando fora,
 *  - escolhendo uma ação,
 *  - e ao passar para outra conversa (o componente dono remonta).
 *
 * No celular a lista fica logo abaixo do botão (o topo tem espaço); no computador ela também, ancorada
 * à direita.
 */
export function MenuMais({ children, rotulo = 'Mais' }: { children: ReactNode; rotulo?: string }) {
  const [aberto, setAberto] = useState(false);
  const idLista = useId();
  const caixa = useRef<HTMLDivElement>(null);
  const botao = useRef<HTMLButtonElement>(null);

  const fechar = useCallback(() => {
    setAberto(false);
    // O foco volta para quem abriu: quem usa o teclado não se perde.
    botao.current?.focus();
  }, []);

  useEffect(() => {
    if (!aberto) return;

    function aoTeclar(evento: globalThis.KeyboardEvent) {
      if (evento.key !== 'Escape') return;
      // Esc fecha só o menu; a conversa continua aberta.
      evento.stopPropagation();
      fechar();
    }

    function aoClicarFora(evento: MouseEvent | TouchEvent) {
      const alvo = (evento instanceof TouchEvent ? evento.touches[0]?.target : evento.target) as Node | undefined;
      if (!alvo || caixa.current?.contains(alvo)) return;
      setAberto(false);
    }

    window.addEventListener('keydown', aoTeclar);
    // `mousedown` em vez de `click`: no celular o toque fora já fecha antes de o botão de destino agir.
    document.addEventListener('mousedown', aoClicarFora);
    document.addEventListener('touchstart', aoClicarFora);
    return () => {
      window.removeEventListener('keydown', aoTeclar);
      document.removeEventListener('mousedown', aoClicarFora);
      document.removeEventListener('touchstart', aoClicarFora);
    };
  }, [aberto, fechar]);

  return (
    <div className="inbox-mais" ref={caixa}>
      <button
        ref={botao}
        type="button"
        className="btn btn-secondary btn-sm inbox-mais-botao"
        aria-expanded={aberto}
        aria-controls={aberto ? idLista : undefined}
        onClick={() => setAberto((atual) => !atual)}
      >
        <Icone nome="mais" className="icon-15" />
        <span>{rotulo}</span>
      </button>
      {aberto ? (
        <div
          id={idLista}
          className="inbox-conversa-acoes-extras inbox-conversa-acoes-extras--abertas"
          role="group"
          aria-label="Mais ações da conversa"
          // A ação escolhida roda primeiro (o clique sobe do botão para cá) e só então o menu fecha.
          onClick={() => {
            setAberto(false);
            botao.current?.focus();
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Janela de "Transferir": escolhe quem atende, ou devolve a conversa para a fila. */
export function DialogoDeTransferencia({
  pessoas,
  atendenteAtual,
  ocupado,
  aoFechar,
  aoTransferir,
}: {
  pessoas: PessoaDoWorkspace[];
  atendenteAtual: string;
  ocupado: boolean;
  aoFechar: () => void;
  aoTransferir: (pessoaId: string | null) => void;
}) {
  return (
    <Dialogo titulo="Transferir conversa" aoFechar={aoFechar}>
      <p className="inbox-dialogo-texto">
        {atendenteAtual ? (
          <>
            Hoje esta conversa é de <strong>{atendenteAtual}</strong>. Escolha quem vai atender:
          </>
        ) : (
          'Esta conversa está na fila da equipe. Escolha quem vai atender:'
        )}
      </p>
      <ul className="inbox-pessoas">
        {pessoas.map((pessoa) => {
          const mesma = atendenteAtual && pessoa.nome === atendenteAtual;
          return (
            <li key={pessoa.id}>
              <button
                type="button"
                className="btn btn-secondary inbox-pessoa"
                disabled={ocupado || Boolean(mesma)}
                onClick={() => aoTransferir(pessoa.id)}
              >
                <span className="inbox-pessoa-nome">
                  {pessoa.nome}
                  {pessoa.eu ? ' (você)' : ''}
                </span>
                <span className="inbox-pessoa-papel">{mesma ? 'atendendo agora' : pessoa.papel}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="inbox-dialogo-acoes">
        <button type="button" className="btn btn-secondary" disabled={ocupado} onClick={() => aoTransferir(null)}>
          Devolver para a fila
        </button>
        <button type="button" className="btn btn-secondary" onClick={aoFechar}>
          Cancelar
        </button>
      </div>
    </Dialogo>
  );
}

/** Janela de "Lembretes": marca o combinado de retorno desta conversa (ou tira o que existe). */
export function DialogoLembrete({
  atual,
  ocupado,
  aoFechar,
  aoSalvar,
}: {
  atual: string | null;
  ocupado: boolean;
  aoFechar: () => void;
  aoSalvar: (quandoIso: string | null) => void;
}) {
  const [valor, setValor] = useState(() => paraInputDateTimeLocal(atual));

  return (
    <Dialogo titulo="Lembretes" aoFechar={aoFechar}>
      <p className="inbox-dialogo-texto">
        Quando vocês combinaram de falar de novo? A conversa aparece em <strong>Lembretes</strong> na hora marcada, e
        nenhuma mensagem é enviada sozinha.
      </p>
      <div className="campo">
        <label htmlFor="lembrete-quando">Data e hora</label>
        <input
          id="lembrete-quando"
          type="datetime-local"
          value={valor}
          onChange={(evento) => setValor(evento.target.value)}
        />
      </div>
      <div className="inbox-atalhos-de-horario">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setValor(atalhoDeHorario('1h'))}>
          Daqui a 1 h
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setValor(atalhoDeHorario('3h'))}>
          Daqui a 3 h
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setValor(atalhoDeHorario('amanha'))}>
          Amanhã às 9 h
        </button>
      </div>
      <div className="inbox-dialogo-acoes">
        <button
          type="button"
          className="btn btn-primary"
          disabled={ocupado || !valor}
          onClick={() => aoSalvar(deInputDateTimeLocal(valor))}
        >
          Salvar lembrete
        </button>
        {atual ? (
          <button type="button" className="btn btn-secondary" disabled={ocupado} onClick={() => aoSalvar(null)}>
            Tirar o lembrete
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary" onClick={aoFechar}>
          Cancelar
        </button>
      </div>
    </Dialogo>
  );
}
