import { describe, expect, it } from 'vitest';

// A conversão vive no componente (cliente), mas a regra é pura: aqui ela é testada sozinha.
import { deBrParaIso, deIsoParaBr } from '../../web/src/components/ui/campo-de-data';

describe('data digitada no formato do Brasil', () => {
  it('mostra dia/mês/ano', () => {
    expect(deIsoParaBr('2026-12-10')).toBe('10/12/2026');
    expect(deIsoParaBr('')).toBe('');
  });

  it('aceita quem digita só números e põe as barras', () => {
    expect(deBrParaIso('10122026')).toBe('2026-12-10');
  });

  it('aceita com barras, traços ou pontos', () => {
    expect(deBrParaIso('10/12/2026')).toBe('2026-12-10');
    expect(deBrParaIso('10-12-2026')).toBe('2026-12-10');
    expect(deBrParaIso('10.12.2026')).toBe('2026-12-10');
  });

  it('enquanto digita, mostra o que já foi digitado', () => {
    expect(deBrParaIso('1')).toBe('1');
    expect(deBrParaIso('10')).toBe('10');
    expect(deBrParaIso('101')).toBe('10/1');
    expect(deBrParaIso('1012')).toBe('10/12');
    expect(deBrParaIso('10122')).toBe('10/12/2');
  });

  it('data que não existe não vira data', () => {
    expect(deBrParaIso('31022026')).toBe('31/02/2026'); // volta como digitado; o servidor recusa
    expect(deBrParaIso('00012026')).toBe('00/01/2026');
  });
});
