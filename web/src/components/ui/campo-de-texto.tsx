'use client';

import { useId } from 'react';

/** O tamanho de um texto do jeito que o banco conta: em caracteres de verdade (um emoji conta um). */
const letras = (valor: string): number => Array.from(valor).length;
const milhar = (valor: number) => valor.toLocaleString('pt-BR');

/**
 * Campo de texto com rótulo, dica e limite de caracteres.
 * O contador só aparece quando o texto está chegando perto do limite (ou passou): antes disso, é ruído.
 */
export function CampoDeTexto({
  rotulo,
  valor,
  limite,
  exemplo,
  dica,
  linhas,
  desativado = false,
  aoMudar,
}: {
  rotulo: string;
  valor: string;
  limite: number;
  exemplo?: string;
  dica?: string;
  /** Com `linhas`, vira uma caixa de texto de várias linhas. */
  linhas?: number;
  desativado?: boolean;
  aoMudar: (valor: string) => void;
}) {
  const id = useId();
  const tamanho = letras(valor.trim());
  const passou = tamanho > limite;
  const mostrarContador = passou || tamanho >= limite * 0.8;
  const idDaDica = dica || mostrarContador ? `${id}-dica` : undefined;
  const comuns = {
    id,
    className: 'campo',
    disabled: desativado,
    placeholder: exemplo,
    value: valor,
    'aria-invalid': passou ? true : undefined,
    'aria-describedby': idDaDica,
  } as const;
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        {rotulo}
      </label>
      {linhas ? <textarea {...comuns} rows={linhas} onChange={(evento) => aoMudar(evento.target.value)} /> : <input {...comuns} type="text" onChange={(evento) => aoMudar(evento.target.value)} />}
      {idDaDica && (
        <p id={idDaDica} className={passou ? 'campo-dica campo-dica--erro' : 'campo-dica'}>
          {dica}
          {dica && mostrarContador ? ' ' : ''}
          {mostrarContador && `${milhar(tamanho)} de ${milhar(limite)} caracteres.`}
        </p>
      )}
    </div>
  );
}
