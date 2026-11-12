'use client';

import { useState, type FormEvent } from 'react';
import { CampoDeTexto } from '@/components/ui/campo-de-texto';
import { Dialogo } from '@/components/ui/dialogo';
import { LIMITES_DO_ENSINO, conferirEnsino, type DestinoDoEnsino, type SugestaoDeEnsino } from '@/lib/ia/ensino';
import { ensinarIa } from './acoes';

/**
 * A janela do "corrigir resposta em 1 clique": o dono ajusta a pergunta e a resposta que vieram da
 * conversa e guarda no Treinamento, como pergunta frequente ou como regra de ouro.
 * Nada é enviado ao contato: muda só o que a IA sabe.
 */
export function JanelaDeEnsino({
  mensagemId,
  sugestao,
  chip,
  aoFechar,
  aoGuardar,
}: {
  mensagemId: string;
  sugestao: SugestaoDeEnsino;
  /** O apelido do chip da conversa: é a base de treinamento dele que aprende. */
  chip: string;
  aoFechar: () => void;
  /** Guardou: recebe a frase que conta o que aconteceu. */
  aoGuardar: (texto: string) => void;
}) {
  const [destino, setDestino] = useState<DestinoDoEnsino>('faq');
  const [pergunta, setPergunta] = useState(sugestao.pergunta);
  const [resposta, setResposta] = useState(sugestao.resposta);
  // A regra começa vazia: a resposta que veio da conversa é uma fala para o cliente, não uma regra.
  const [regra, setRegra] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function guardar(evento: FormEvent) {
    evento.preventDefault();
    if (guardando) return;
    const dados = { mensagemId, destino, pergunta, resposta: destino === 'faq' ? resposta : regra };
    const conferido = conferirEnsino(dados);
    if (!conferido.ok) return setErro(conferido.erro);
    setGuardando(true);
    setErro(null);
    const resultado = await ensinarIa(dados).catch(() => null);
    setGuardando(false);
    if (!resultado) return setErro('Não foi possível falar com o painel. Confira a internet e tente de novo.');
    if (!resultado.ok) return setErro(resultado.erro);
    aoGuardar(resultado.texto);
  }

  return (
    <Dialogo titulo={sugestao.daIa ? 'Corrigir a resposta da IA' : 'Ensinar esta resposta à IA'} aoFechar={aoFechar}>
      <form className="ensino" onSubmit={guardar} noValidate>
        <p className="dialogo-texto">
          {sugestao.daIa ? 'Escreva como a IA deveria ter respondido.' : 'A IA passa a responder assim quando perguntarem a mesma coisa.'} Fica guardado no
          Treinamento da base que o chip {chip} usa, e a IA já usa na próxima resposta. Nada é enviado ao cliente agora.
        </p>

        <fieldset className="opcoes">
          <legend>Onde guardar</legend>
          <label className="opcao">
            <input
              type="radio"
              name="destino-do-ensino"
              checked={destino === 'faq'}
              onChange={() => {
                setDestino('faq');
                setErro(null);
              }}
            />
            <span>
              <strong>Pergunta frequente</strong>
              <small>Quando perguntarem isto, a IA responde assim.</small>
            </span>
          </label>
          <label className="opcao">
            <input
              type="radio"
              name="destino-do-ensino"
              checked={destino === 'rule'}
              onChange={() => {
                setDestino('rule');
                setErro(null);
              }}
            />
            <span>
              <strong>Regra de ouro</strong>
              <small>Uma regra que a IA segue em todas as conversas.</small>
            </span>
          </label>
        </fieldset>

        {destino === 'faq' ? (
          <>
            <CampoDeTexto
              rotulo="Quando o cliente perguntar"
              valor={pergunta}
              limite={LIMITES_DO_ENSINO.pergunta}
              exemplo="Ex.: Vocês entregam no centro?"
              linhas={2}
              aoMudar={(valor) => {
                setPergunta(valor);
                setErro(null);
              }}
            />
            <CampoDeTexto
              rotulo="A IA deve responder"
              valor={resposta}
              limite={LIMITES_DO_ENSINO.resposta}
              exemplo="Ex.: Entregamos, sim! A taxa para o centro é R$ 7,00."
              linhas={5}
              aoMudar={(valor) => {
                setResposta(valor);
                setErro(null);
              }}
            />
          </>
        ) : (
          <CampoDeTexto
            rotulo="Regra que a IA deve seguir"
            valor={regra}
            limite={LIMITES_DO_ENSINO.regra}
            exemplo="Ex.: Nunca prometa prazo de entrega sem confirmar o bairro."
            dica="Escreva como uma ordem curta. Ela entra como uma linha nova nas regras de ouro."
            linhas={3}
            aoMudar={(valor) => {
              setRegra(valor);
              setErro(null);
            }}
          />
        )}

        {erro && (
          <p className="aviso aviso--erro" role="alert">
            {erro}
          </p>
        )}

        <div className="dialogo-acoes">
          <button type="button" className="btn btn-secondary" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar no Treinamento'}
          </button>
        </div>
      </form>
    </Dialogo>
  );
}
