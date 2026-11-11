import { describe, expect, test } from 'vitest';
import { inicioDoDia } from '@/lib/tempo';

describe('inicioDoDia', () => {
  test('em Fortaleza (UTC-3) o dia começa às 03:00 UTC', () => {
    const agora = new Date('2026-11-11T15:30:45.123Z'); // 12:30 em Fortaleza
    expect(inicioDoDia(agora).toISOString()).toBe('2026-11-11T03:00:00.000Z');
  });

  test('de madrugada em UTC ainda é o dia anterior em Fortaleza', () => {
    const agora = new Date('2026-11-12T01:10:00.000Z'); // 22:10 do dia 11 em Fortaleza
    expect(inicioDoDia(agora).toISOString()).toBe('2026-11-11T03:00:00.000Z');
  });

  test('exatamente à meia-noite local', () => {
    const agora = new Date('2026-11-11T03:00:00.000Z');
    expect(inicioDoDia(agora).toISOString()).toBe('2026-11-11T03:00:00.000Z');
  });

  test('um segundo antes da meia-noite local', () => {
    const agora = new Date('2026-11-11T02:59:59.000Z');
    expect(inicioDoDia(agora).toISOString()).toBe('2026-11-10T03:00:00.000Z');
  });

  test('aceita outro fuso', () => {
    const agora = new Date('2026-11-11T15:30:00.000Z');
    expect(inicioDoDia(agora, 'UTC').toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(inicioDoDia(agora, 'America/Manaus').toISOString()).toBe('2026-11-11T04:00:00.000Z');
  });
});
