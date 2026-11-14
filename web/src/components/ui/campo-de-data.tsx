'use client';

import { useId } from 'react';

/**
 * Data digitada do jeito do Brasil: "10/12/2026". Guarda sempre AAAA-MM-DD (é o que o banco entende).
 *
 * O campo nativo de data segue o idioma do navegador: num aparelho em inglês aparece mm/dd/yyyy e a
 * pessoa digita o mês no lugar do dia. Aqui a ordem é sempre dia, mês, ano — e quem só digita os
 * números ganha as barras sozinho ("10122026" vira "10/12/2026").
 */
export function CampoDeData({
  id,
  rotulo,
  valor,
  aoMudar,
  desabilitado = false,
  ajuda,
  obrigatorio = false,
}: {
  id?: string;
  rotulo: string;
  /** AAAA-MM-DD, ou vazio. */
  valor: string;
  aoMudar: (novo: string) => void;
  desabilitado?: boolean;
  ajuda?: string;
  obrigatorio?: boolean;
}) {
  const gerado = useId();
  const idCampo = id ?? gerado;
  const idAjuda = `${idCampo}-ajuda`;

  return (
    <div className="form-group">
      <label className="form-label" htmlFor={idCampo}>
        {rotulo}
      </label>
      <input
        id={idCampo}
        className="f7-input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="dd/mm/aaaa"
        value={deIsoParaBr(valor)}
        onChange={(evento) => aoMudar(deBrParaIso(evento.target.value))}
        disabled={desabilitado}
        required={obrigatorio}
        aria-describedby={ajuda ? idAjuda : undefined}
        maxLength={10}
      />
      {ajuda ? (
        <p className="form-help" id={idAjuda}>
          {ajuda}
        </p>
      ) : null}
    </div>
  );
}

/** "2026-12-10" → "10/12/2026" (e qualquer coisa incompleta aparece como está). */
export function deIsoParaBr(iso: string): string {
  const limpo = (iso ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(limpo)) return limpo;
  const [ano, mes, dia] = limpo.split('-');
  return `${dia}/${mes}/${ano}`;
}

/**
 * "10/12/2026", "10122026" ou "10-12-2026" → "2026-12-10".
 * Enquanto a pessoa digita, devolve o que ela escreveu (o formulário mostra e o servidor valida).
 */
export function deBrParaIso(texto: string): string {
  const digitos = (texto ?? '').replace(/\D/g, '').slice(0, 8);
  if (digitos.length < 8) return formatarParcial(digitos);

  const dia = digitos.slice(0, 2);
  const mes = digitos.slice(2, 4);
  const ano = digitos.slice(4, 8);
  const candidata = `${ano}-${mes}-${dia}`;
  // Data que não existe (31/02, 00/13) volta como está: o servidor recusa e a pessoa corrige.
  const teste = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));
  if (teste.getUTCFullYear() !== Number(ano) || teste.getUTCMonth() !== Number(mes) - 1 || teste.getUTCDate() !== Number(dia)) {
    return formatarParcial(digitos);
  }
  return candidata;
}

/** 3 dígitos → "12/3", 5 → "12/03/2": as barras aparecem enquanto digita. */
function formatarParcial(digitos: string): string {
  if (digitos.length <= 2) return digitos;
  if (digitos.length <= 4) return `${digitos.slice(0, 2)}/${digitos.slice(2)}`;
  return `${digitos.slice(0, 2)}/${digitos.slice(2, 4)}/${digitos.slice(4)}`;
}
