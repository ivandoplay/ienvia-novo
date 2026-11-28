import { describe, expect, test } from 'vitest';
import { formatarEspera, segundosAte, rotuloDoRitmo } from '../src/lib/campanhas/ritmo';
describe('ritmo da campanha', () => {
 test('formata contagem sem valores negativos', () => { expect(formatarEspera(-2)).toBe('0s'); expect(formatarEspera(92)).toBe('1min 32s'); expect(formatarEspera(3660)).toBe('1h 1min'); });
 test('não inventa agenda ausente ou inválida', () => { expect(segundosAte(null, 0)).toBeNull(); expect(segundosAte('inválida', 0)).toBeNull(); });
 test('tempo vencido espera executor sem ficar negativo', () => { expect(segundosAte('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:01:00Z'))).toBe(0); });
 test('pausa e término prevalecem sobre motivo antigo', () => { expect(rotuloDoRitmo('paused','batch_rest')).toBe('Campanha pausada'); expect(rotuloDoRitmo('completed','batch_rest')).toBe('Campanha concluída'); });
 test('distingue descanso de intervalo de bloco', () => { expect(rotuloDoRitmo('running','batch_rest')).toBe('Descanso entre lotes'); expect(rotuloDoRitmo('running','block_interval')).toContain('mensagens'); });
});
