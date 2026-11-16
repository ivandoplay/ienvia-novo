'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icone } from '@/components/ui/icone';
import { Dialogo } from '@/components/ui/dialogo';
import type { ChipDaInbox, EtiquetaDoCrm } from '@/lib/dados/inbox';
import { ETAPAS_DO_KANBAN } from '@/lib/inbox/regras';
import { salvarAutomacaoDaEtapa, type AutomacaoDaEtapa } from './acoes';

/**
 * "Automação das etapas": o que acontece sozinho quando um negócio entra numa etapa do funil.
 *
 * Duas coisas, ligadas ou desligadas por etapa:
 *  - dar uma etiqueta ao contato;
 *  - mandar uma mensagem para o cliente (`{{nome}}` vira o primeiro nome dele).
 *
 * Nada é disparado por esta tela: ela só guarda a regra (`save_my_stage_automation`). Quem age é o
 * motor, quando o cartão muda de etapa. Textos em português, e os mesmos no computador e no celular.
 */
export function AutomacaoDasEtapas({
  automacoes,
  etiquetas,
}: {
  automacoes: AutomacaoDaEtapa[];
  etiquetas: EtiquetaDoCrm[];
  chips?: ChipDaInbox[];
}) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [salvando, setSalvando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [rascunhos, setRascunhos] = useState<AutomacaoDaEtapa[]>(automacoes);

  const daEtapa = (etapa: string): AutomacaoDaEtapa =>
    rascunhos.find((item) => item.etapa === etapa) ?? {
      etapa,
      ligarEtiqueta: false,
      etiquetaId: null,
      ligarMensagem: false,
      texto: '',
    };

  function mudar(etapa: string, mudanca: Partial<AutomacaoDaEtapa>) {
    setRascunhos((atuais) => {
      const existe = atuais.some((item) => item.etapa === etapa);
      const base = daEtapa(etapa);
      const atualizado = { ...base, ...mudanca };
      return existe ? atuais.map((item) => (item.etapa === etapa ? atualizado : item)) : [...atuais, atualizado];
    });
    setOk(null);
  }

  async function salvar(etapa: string) {
    setSalvando(etapa);
    setErro(null);
    const resultado = await salvarAutomacaoDaEtapa(daEtapa(etapa));
    setSalvando(null);
    if (!resultado.ok) {
      setErro(resultado.erro);
      return;
    }
    setOk(`Automação de "${ETAPAS_DO_KANBAN.find((item) => item.valor === etapa)?.rotulo ?? etapa}" salva.`);
    router.refresh();
  }

  const ligadas = rascunhos.filter((item) => item.ligarEtiqueta || item.ligarMensagem).length;

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm kanban-automacao" onClick={() => setAberto(true)}>
        <Icone nome="raio" className="icon-15" />
        <span>Automação das etapas</span>
        {ligadas > 0 ? <span className="kanban-automacao-contagem">{ligadas}</span> : null}
      </button>

      {aberto ? (
        <Dialogo titulo="Automação das etapas" aoFechar={() => setAberto(false)} largo>
          <p className="inbox-dialogo-texto">
            Escolha o que acontece sozinho quando um negócio entra na etapa. Nada é enviado agora: vale a partir do
            próximo card que mudar de etapa. Em <code>{'{{nome}}'}</code> entra o nome do contato.
          </p>

          {erro ? (
            <p className="aviso aviso--erro" role="alert">
              {erro}
            </p>
          ) : null}
          {ok && !erro ? (
            <p className="aviso aviso--ok" role="status">
              {ok}
            </p>
          ) : null}

          <ul className="kanban-automacao-lista">
            {ETAPAS_DO_KANBAN.map((etapa) => {
              const regra = daEtapa(etapa.valor);
              return (
                <li key={etapa.valor} className="kanban-automacao-etapa" data-etapa={etapa.valor}>
                  <h3>{etapa.rotulo}</h3>

                  <div className="kanban-automacao-campo">
                    <label className="kanban-automacao-ligar">
                      <input
                        type="checkbox"
                        checked={regra.ligarEtiqueta}
                        onChange={(evento) => mudar(etapa.valor, { ligarEtiqueta: evento.target.checked })}
                      />
                      <span>Dar uma etiqueta ao contato</span>
                    </label>
                    <select
                      className="campo"
                      aria-label={`Etiqueta da etapa ${etapa.rotulo}`}
                      value={regra.etiquetaId ?? ''}
                      disabled={!regra.ligarEtiqueta}
                      onChange={(evento) => mudar(etapa.valor, { etiquetaId: evento.target.value || null })}
                    >
                      <option value="">Escolha a etiqueta</option>
                      {etiquetas.map((etiqueta) => (
                        <option key={etiqueta.id} value={etiqueta.id}>
                          {etiqueta.nome}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="kanban-automacao-campo">
                    <label className="kanban-automacao-ligar">
                      <input
                        type="checkbox"
                        checked={regra.ligarMensagem}
                        onChange={(evento) => mudar(etapa.valor, { ligarMensagem: evento.target.checked })}
                      />
                      <span>Mandar uma mensagem ao cliente</span>
                    </label>
                    <label htmlFor={`automacao-${etapa.valor}`} className="so-leitor-de-tela">
                      Mensagem da etapa {etapa.rotulo}
                    </label>
                    <textarea
                      id={`automacao-${etapa.valor}`}
                      className="campo"
                      rows={2}
                      maxLength={1000}
                      disabled={!regra.ligarMensagem}
                      placeholder={`Oi {{nome}}, tudo bem?`}
                      value={regra.texto}
                      onChange={(evento) => mudar(etapa.valor, { texto: evento.target.value })}
                    />
                  </div>

                  <button
                    type="button"
                    className="btn btn-primary btn-sm kanban-automacao-salvar"
                    disabled={salvando === etapa.valor}
                    onClick={() => void salvar(etapa.valor)}
                  >
                    {salvando === etapa.valor ? 'Salvando…' : `Salvar ${etapa.rotulo}`}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="inbox-dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setAberto(false)}>
              Fechar
            </button>
          </div>
        </Dialogo>
      ) : null}
    </>
  );
}
