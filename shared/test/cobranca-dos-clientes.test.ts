import { describe, expect, it } from 'vitest';

import {
  descreverPrazoDaCobranca,
  formatarDataBr,
  formatarReais,
  situacaoDaCobranca,
  validarCobrancaDoCliente,
} from '../src/contas/regras';

const HOJE = '2026-11-12';
const cobranca = (paidUntil: string | null, graceDays = 3, dueDay: number | null = 10) => ({ dueDay, graceDays, paidUntil });

describe('situação do pagamento do cliente', () => {
  it('longe do vencimento: em dia', () => {
    expect(situacaoDaCobranca(cobranca('2026-12-10'), HOJE)).toEqual({ situation: 'em_dia', daysToDue: 28 });
  });

  it('cinco dias ou menos: avisa que está vencendo', () => {
    expect(situacaoDaCobranca(cobranca('2026-11-15'), HOJE)).toEqual({ situation: 'vencendo', daysToDue: 3 });
    expect(situacaoDaCobranca(cobranca('2026-11-12'), HOJE)).toEqual({ situation: 'vencendo', daysToDue: 0 });
  });

  it('passou do dia pago mas está na carência: tolerância', () => {
    expect(situacaoDaCobranca(cobranca('2026-11-09'), HOJE)).toEqual({ situation: 'tolerancia', daysToDue: -3 });
  });

  it('passou da carência: vencida', () => {
    expect(situacaoDaCobranca(cobranca('2026-11-08'), HOJE)).toEqual({ situation: 'vencida', daysToDue: -4 });
  });

  it('carência zero vence no primeiro dia de atraso', () => {
    expect(situacaoDaCobranca(cobranca('2026-11-11', 0), HOJE).situation).toBe('vencida');
  });

  it('sem dia combinado e sem pagamento: a conta não é cobrada', () => {
    expect(situacaoDaCobranca(cobranca(null, 3, null), HOJE).situation).toBe('sem_cobranca');
  });

  it('com dia combinado e nunca marcada como paga: vencida', () => {
    expect(situacaoDaCobranca(cobranca(null), HOJE).situation).toBe('vencida');
  });
});

describe('validação da cobrança', () => {
  it('aceita o que o master digita de verdade', () => {
    const r = validarCobrancaDoCliente({ dueDay: '10', monthlyAmountCents: '14900', graceDays: '3', paidUntil: '2026-12-10', suspendNotice: '  Conta suspensa.  ' });
    expect(r).toEqual({
      ok: true,
      dados: { dueDay: 10, monthlyAmountCents: 14900, graceDays: 3, paidUntil: '2026-12-10', suspendNotice: 'Conta suspensa.' },
    });
  });

  it('dia 32 ou zero não existe', () => {
    expect(validarCobrancaDoCliente({ dueDay: '32' }).ok).toBe(false);
    expect(validarCobrancaDoCliente({ dueDay: '0' }).ok).toBe(false);
  });

  it('31 de fevereiro não passa', () => {
    expect(validarCobrancaDoCliente({ paidUntil: '2026-02-31' }).ok).toBe(false);
  });

  it('carência acima do limite não passa', () => {
    expect(validarCobrancaDoCliente({ graceDays: '90' }).ok).toBe(false);
  });

  it('aviso de suspensão comprido demais não passa', () => {
    expect(validarCobrancaDoCliente({ suspendNotice: 'a'.repeat(601) }).ok).toBe(false);
  });
});

describe('textos que o master lê', () => {
  it('prazo em palavras', () => {
    expect(descreverPrazoDaCobranca(0)).toBe('vence hoje');
    expect(descreverPrazoDaCobranca(1)).toBe('vence amanhã');
    expect(descreverPrazoDaCobranca(12)).toBe('faltam 12 dias');
    expect(descreverPrazoDaCobranca(-1)).toBe('1 dia atrasado');
    expect(descreverPrazoDaCobranca(-7)).toBe('7 dias atrasado');
    expect(descreverPrazoDaCobranca(null)).toBe('sem data de pagamento');
  });

  it('dinheiro e data no formato do Brasil', () => {
    expect(formatarReais(14900)).toBe('R$\u00a0149,00');
    expect(formatarReais(null)).toBe('—');
    expect(formatarDataBr('2026-12-01')).toBe('01/12/2026');
  });
});
