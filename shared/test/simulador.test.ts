import { describe, expect, test } from 'vitest';
import {
  atalhosDoSimulador,
  avaliarMidiaSimulador,
  extrairAudiosJaEnviadosNoSimulador,
  normalizarSessaoSimulador,
  truncarHistoricoSimulador,
} from '../src/simulador/regras';

describe('Simulador de Atendimento', () => {
  test('seleciona atalhos contextualizados e adiciona atalhos de PIX/Catálogo/Áudio quando existem', () => {
    const liz = atalhosDoSimulador({ modeloOuNicho: 'Estratégia Automotiva Lizandro', temPix: true, primeiroItemNome: 'Plano Turbo' });
    expect(liz.some((a) => a.rotulo.includes('Objeção: tráfego sem resultado'))).toBe(true);
    expect(liz.some((a) => a.rotulo.includes('Pedir QR Code PIX'))).toBe(true);
    expect(liz.some((a) => a.rotulo.includes('Pedir mídia'))).toBe(true);

    const geral = atalhosDoSimulador({ modeloOuNicho: 'Clínica Odontológica', temPix: false });
    expect(geral.some((a) => a.rotulo === 'Dados PIX para pagamento')).toBe(true);
  });

  test('bloqueia SVG/HTML e arquivos acima de 4 MB', () => {
    expect(avaliarMidiaSimulador({ nome: 'vetor.svg', tipoInformado: 'image/svg+xml', tamanho: 100 })).toEqual({
      ok: false,
      erro: 'SVG e HTML não são aceitos. Envie foto, PDF ou áudio comum.',
    });
    expect(avaliarMidiaSimulador({ nome: 'pagina.html', tipoInformado: 'text/html', tamanho: 100 }).ok).toBe(false);
    expect(avaliarMidiaSimulador({ nome: 'grande.png', tipoInformado: 'image/png', tamanho: 5 * 1024 * 1024 }).ok).toBe(false);
    expect(avaliarMidiaSimulador({ nome: 'comprovante.jpg', tipoInformado: 'image/jpeg', tamanho: 250_000 })).toEqual({
      ok: true,
      tipo: 'image/jpeg',
    });
  });

  test('normaliza, trunca histórico do simulador e extrai áudios já enviados', () => {
    const lote = Array.from({ length: 45 }, (_, idx) => ({
      id: `m-${idx}`,
      papel: idx % 2 === 0 ? 'user' : 'assistant',
      texto: `msg ${idx}`,
      criadoEm: '2026-11-12T12:00:00Z',
      sentVoiceIds: idx === 41 ? ['v-1'] : undefined,
      audios: idx === 43 ? [{ id: 'v-2', name: 'Boas-vindas', objectKey: 'k', transcription: 'oi', durationSec: 10, waveform: [] }] : undefined,
    }));
    const sessao = normalizarSessaoSimulador({ agentId: 'base-1', history: lote });
    expect(sessao.agentId).toBe('base-1');
    expect(sessao.history).toHaveLength(40);
    expect(truncarHistoricoSimulador(sessao.history)).toHaveLength(40);
    expect(extrairAudiosJaEnviadosNoSimulador(sessao.history)).toEqual(['v-1', 'v-2']);
  });
});
