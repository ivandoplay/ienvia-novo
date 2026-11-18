'use client';
import {Icone} from '@/components/ui/icone';
import { ControleDeAtendimento } from './controle-de-atendimento';
import type {FaixaDaIa} from '@/lib/atendente/painel';
type AcaoNaConversa = 'resolver' | 'reabrir' | 'assumir' | 'devolver' | 'fixar' | 'arquivar' | 'desarquivar';
export function FaixaDaIaNaConversa({ faixa, ocupado, aoAgir, mostrarControle=true }: { faixa: FaixaDaIa; ocupado: AcaoNaConversa | null; aoAgir: (acao: AcaoNaConversa) => void; mostrarControle?:boolean }) {
  const { recado } = faixa;
  return (
    <div className={`inbox-ia inbox-ia--${faixa.tom}`} role="group" aria-label="A IA nesta conversa">
      <Icone nome={faixa.tom === 'atencao' ? 'pessoa' : 'kpiIa'} className="inbox-ia-icone" />
      <div className="inbox-ia-texto">
        <p className="inbox-ia-titulo">{faixa.titulo}</p>
        {recado ? (
          recado.cenario || recado.gatilho || recado.proximaJogada ? (
            <dl className="inbox-ia-recado">
              {recado.cenario ? (
                <div>
                  <dt>Quem é</dt>
                  <dd>{recado.cenario}</dd>
                </div>
              ) : null}
              {recado.gatilho ? (
                <div>
                  <dt>O que pediu</dt>
                  <dd>{recado.gatilho}</dd>
                </div>
              ) : null}
              {recado.proximaJogada ? (
                <div>
                  <dt>Sugestão</dt>
                  <dd>{recado.proximaJogada}</dd>
                </div>
              ) : null}
              {recado.livre ? (
                <div>
                  <dt>Recado</dt>
                  <dd>{recado.livre}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="inbox-ia-recado">{recado.livre}</p>
          )
        ) : null}
        {faixa.detalhe ? <p className="inbox-ia-detalhe">{faixa.detalhe}</p> : null}
      </div>
      {mostrarControle&&(faixa.podeAssumir||faixa.podeDevolver)?<div className="inbox-ia-acoes"><ControleDeAtendimento faixa={faixa} ocupado={ocupado} aoAgir={aoAgir}/></div>:null}
    </div>
  );
}

