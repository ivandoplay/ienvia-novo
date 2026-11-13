import { describe, expect, test } from 'vitest';
import {
  VERSAO_ATUAL_DO_MOTOR,
  analisarVersao,
  descreverEstadoDoExecutor,
  ehVersaoMaisNova,
  executorEstaOnline,
  normalizarCodigoPareamentoAparelho,
  normalizarPlataforma,
  rotuloDaPlataforma,
  serializarManifestoCanonico,
  validarApelidoDoAparelho,
} from '../src/motor/regras';
import { CHAVE_PUBLICA_ATUALIZACAO_MOTOR } from '../src/motor/chave-publica';

describe('regras do motor local', () => {
  test('chave pública Ed25519 está no formato PEM SPKI válido', () => {
    expect(CHAVE_PUBLICA_ATUALIZACAO_MOTOR).toContain('-----BEGIN PUBLIC KEY-----');
    expect(CHAVE_PUBLICA_ATUALIZACAO_MOTOR).toContain('-----END PUBLIC KEY-----');
  });

  test('versão semântica estrita evita downgrade e rejeita formatos inválidos', () => {
    expect(analisarVersao(VERSAO_ATUAL_DO_MOTOR)).toEqual([6, 0, 0]);
    expect(ehVersaoMaisNova('6.0.0', '6.0.1')).toBe(true);
    expect(ehVersaoMaisNova('6.0.0', '6.1.0')).toBe(true);
    expect(ehVersaoMaisNova('6.0.0', '7.0.0')).toBe(true);
    expect(ehVersaoMaisNova('6.0.1', '6.0.1')).toBe(false);
    expect(ehVersaoMaisNova('6.1.0', '6.0.9')).toBe(false);
    expect(ehVersaoMaisNova('6.0.0', '6.0.0-beta')).toBe(false);
  });

  test('normaliza códigos de pareamento IENV-XXXX-XXXX', () => {
    expect(normalizarCodigoPareamentoAparelho('ienv ab12 cd34')).toBe('IENV-AB12-CD34');
    expect(normalizarCodigoPareamentoAparelho('ab12-cd34')).toBe('IENV-AB12-CD34');
    expect(normalizarCodigoPareamentoAparelho('IENV-1234-5678')).toBe('IENV-1234-5678');
    expect(normalizarCodigoPareamentoAparelho('curto')).toBeNull();
  });

  test('normaliza plataformas e descreve estado on-line com janela de heartbeat', () => {
    expect(normalizarPlataforma('linux', true)).toBe('android-termux');
    expect(rotuloDaPlataforma('android-termux')).toBe('Android (Termux)');
    expect(rotuloDaPlataforma('win32')).toBe('Windows');

    const agora = Date.parse('2026-11-12T12:00:00Z');
    expect(executorEstaOnline('active', '2026-11-12T11:59:10Z', agora)).toBe(true);
    expect(executorEstaOnline('active', '2026-11-12T11:58:00Z', agora)).toBe(false);
    expect(descreverEstadoDoExecutor('pending_pair', null, agora)).toMatchObject({ codigo: 'pending', tom: 'atencao' });
    expect(descreverEstadoDoExecutor('revoked', '2026-11-12T11:59:50Z', agora)).toMatchObject({ codigo: 'revoked', tom: 'erro' });
    expect(descreverEstadoDoExecutor('active', '2026-11-12T11:59:30Z', agora)).toMatchObject({ codigo: 'online', tom: 'ok' });
  });

  test('serializa manifesto de forma determinística e valida apelido', () => {
    expect(validarApelidoDoAparelho('  Notebook   Loja  ')).toBe('Notebook Loja');
    expect(validarApelidoDoAparelho('   ')).toBeNull();
    const s = serializarManifestoCanonico({
      version: '6.0.0',
      sha256: 'AA'.repeat(32),
      size: 1234,
      published_at: '2026-11-12T00:00:00.000Z',
      min_node_major: 20,
    });
    expect(s).toContain('"sha256":"' + 'aa'.repeat(32) + '"');
  });
});
