'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { pausarTudo, retomarIa } from '@/app/(painel)/acoes-da-ia';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import type { ResumoDaIa } from '@/lib/atendente/painel';

/**
 * O botão de emergência da IA, no topo do painel.
 *   - IA ligada em algum chip: "Pausar tudo" (pede confirmação e para a IA em todos os chips);
 *   - IA pausada: o aviso fica à vista em todas as abas, com "Retomar" para o dono.
 * Sem chip nenhum com a IA ligada não há o que pausar, e nada aparece.
 */
export function ControleDaIa({ ia }: { ia: ResumoDaIa | null }) {
  const router = useRouter();
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [trabalhando, iniciar] = useTransition();

  if (!ia || (!ia.pausada && ia.chipsComIa === 0)) return null;

  function executar(acao: () => Promise<{ ok: true } | { ok: false; erro: string }>) {
    setErro(null);
    iniciar(async () => {
      const resposta = await acao().catch(() => null);
      if (!resposta) setErro('Não foi possível falar com o painel. Confira a internet e tente de novo.');
      else if (!resposta.ok) setErro(resposta.erro);
      else {
        setConfirmando(false);
        router.refresh();
      }
    });
  }

  if (ia.pausada) {
    return (
      <div className="controle-da-ia" role="group" aria-label="Atendente de IA">
        <span className="status-pill controle-da-ia-pausada">
          <Icone nome="pausa" className="icon-15" />
          <span>IA pausada</span>
        </span>
        {ia.podeRetomar && (
          <button type="button" className="btn btn-primary btn-sm" disabled={trabalhando} onClick={() => executar(retomarIa)}>
            {trabalhando ? 'Retomando…' : 'Retomar'}
          </button>
        )}
        {erro && (
          <span className="controle-da-ia-erro" role="alert">
            {erro}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="controle-da-ia" role="group" aria-label="Atendente de IA">
      <button type="button" className="btn btn-secondary btn-sm controle-da-ia-pausar" onClick={() => setConfirmando(true)}>
        <Icone nome="pausa" className="icon-15" />
        <span>Pausar tudo</span>
      </button>
      {confirmando && (
        <Dialogo titulo="Pausar a IA em todos os chips?" aoFechar={() => setConfirmando(false)}>
          <p className="dialogo-texto">
            A IA para de responder agora, em todos os chips. As mensagens continuam chegando na Inbox, para a equipe responder.
          </p>
          <p className="dialogo-texto">{ia.podeRetomar ? 'Você retoma quando quiser, por este mesmo lugar.' : 'Só o dono da conta consegue retomar depois.'}</p>
          {erro && (
            <p className="aviso aviso--erro" role="alert">
              {erro}
            </p>
          )}
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmando(false)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-danger" disabled={trabalhando} onClick={() => executar(pausarTudo)}>
              {trabalhando ? 'Pausando…' : 'Pausar tudo'}
            </button>
          </div>
        </Dialogo>
      )}
    </div>
  );
}
