'use client';

import { useState } from 'react';

/**
 * Campo de horário em 24 horas, do jeito brasileiro.
 *
 * O `<input type="time">` do navegador mostra "08:00 AM" quando o sistema está em inglês, mesmo com o
 * painel todo em português — e no celular o seletor nativo às vezes nem abre. Aqui o campo mostra
 * "08:00" sempre, aceita só números e o teclado do celular abre em modo numérico.
 *
 * O valor guardado continua no formato do banco ("08:00" ou "18:30").
 */
export function CampoDeHora({
  id,
  rotulo,
  valor,
  aoMudar,
  desabilitado,
}: {
  id: string;
  rotulo: string;
  valor: string;
  aoMudar: (novo: string) => void;
  desabilitado?: boolean;
}) {
  const [texto, setTexto] = useState(valor || '00:00');
  /** Último valor que veio de fora; quando ele muda (recarregar a página, Desfazer), o campo acompanha. */
  const [valorDeFora, setValorDeFora] = useState(valor);

  /** Aceita "8", "830", "08:30", "1830" e devolve sempre "HH:MM" quando dá para entender. */
  if (valor !== valorDeFora) {
    // Ajuste durante a renderização (o jeito recomendado pelo React), sem efeito e sem piscar.
    setValorDeFora(valor);
    setTexto(valor || '00:00');
  }

  function normalizar(entrada: string): string | null {
    const digitos = entrada.replace(/\D/g, '').slice(0, 4);
    if (digitos.length === 0) return null;
    const horas = digitos.length <= 2 ? Number(digitos) : Number(digitos.slice(0, digitos.length - 2));
    const minutos = digitos.length <= 2 ? 0 : Number(digitos.slice(-2));
    if (!Number.isFinite(horas) || !Number.isFinite(minutos)) return null;
    if (horas > 23 || minutos > 59) return null;
    return `${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}`;
  }

  return (
    <div className="campo">
      <label htmlFor={id}>{rotulo}</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={5}
        placeholder="08:00"
        disabled={desabilitado}
        value={texto}
        aria-describedby={`${id}-ajuda`}
        onChange={(e) => {
          const bruto = e.target.value;
          // Com 2 dígitos ainda pode virar "18", "08"... só completa quando a pessoa digita os minutos
          // ou quando o horário já está inteiro (830, 18:30). Ao sair do campo, completa sempre.
          const digitos = bruto.replace(/\D/g, '');
          const completo = digitos.length >= 3 || bruto.includes(':');
          setTexto(completo ? normalizar(bruto) ?? bruto : bruto);
          const pronto = normalizar(bruto);
          if (pronto) aoMudar(pronto);
        }}
        onBlur={() => {
          const pronto = normalizar(texto);
          const final = pronto ?? (valor || '00:00');
          setTexto(final);
          if (final !== valor) aoMudar(final);
        }}
      />
      <span id={`${id}-ajuda`} className="campo-ajuda">
        24 horas, sem AM/PM. Ex.: 08:00 e 18:30.
      </span>
    </div>
  );
}
