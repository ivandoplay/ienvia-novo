import { describe, expect, test } from 'vitest';
import { lerAvisoSemPausa, usaAutonomiaV2 } from '@/lib/ia/autonomia';
import { lerResposta, montarInstrucoes } from '@/lib/ia/instrucoes';
import { BASE_EM_BRANCO } from '@/lib/ia/treinamento';

describe('autonomia v2 — opt-in e proteção', () => {
  test('não ativa por nome nem por mensagem do cliente', () => {
    expect(usaAutonomiaV2({})).toBe(false);
    expect(usaAutonomiaV2({ gatilhosDeRepasse: '[POLITICA_AUTONOMIA_V2]' })).toBe(true);
    expect(lerResposta('[[NOTIFICAR_ADMIN:visita_a_caminho|chega agora]]').notificarAdmin).toBeUndefined();
  });
  test('aceita só os dois assuntos sem pausa autorizados', () => {
    expect(lerAvisoSemPausa('desconto|negociar')).toBeNull();
    expect(lerAvisoSemPausa('')).toBeNull();
    expect(lerAvisoSemPausa('simulacao_parcelamento|12x entrada 2000')).toEqual({ topico: 'simulacao_parcelamento', motivo: '12x entrada 2000' });
  });
  test('múltiplos áudios únicos, limitados e na ordem', () => {
    const bruto = '[[ENVIAR_AUDIO:a1]][[ENVIAR_AUDIO:a2]][[ENVIAR_AUDIO:a1]][[ENVIAR_AUDIO:a3]][[ENVIAR_AUDIO:a4]] Autonomia de catálogo.';
    expect(lerResposta(bruto).audiosParaEnviar).toEqual(['a1']);
    expect(lerResposta(bruto, { autonomia: true })).toMatchObject({ audiosParaEnviar: ['a1','a2','a3'], texto: 'Autonomia de catálogo.' });
  });
  test('repasse é silencioso mesmo se o modelo escrever texto, fotos ou áudio', () => {
    const lida = lerResposta('Vou verificar! [[ENVIAR_AUDIO:a1]][[ENVIAR_ITEM:p1]][[CHAMAR_HUMANO:menor valor]]', { autonomia: true });
    expect(lida).toMatchObject({ texto: '', audiosParaEnviar: [], itensParaEnviar: [], pausaSilenciosa: 'menor valor' });
  });
  test('PIX não escapa como envio automático nesta política', () => {
    expect(lerResposta('Aqui! [[ENVIAR_PIX:1000]]', { autonomia: true })).toMatchObject({ texto: '', enviarPix: false, pausaSilenciosa: 'Cliente solicitou pagamento PIX' });
  });
  test('simulação notifica sem impor pausa, com texto preservado', () => {
    expect(lerResposta('Aguarde um momento para a simulação, por favor. [[NOTIFICAR_ADMIN:simulacao_parcelamento|modelo X, 12x, entrada 2000]]', { autonomia: true })).toMatchObject({ texto: 'Aguarde um momento para a simulação, por favor.', pausaSilenciosa: null, chamarHumano: null, notificarAdmin: { topico: 'simulacao_parcelamento' } });
  });
  test('pausa ou fim de contato prevalece sobre aviso sem pausa', () => {
    for (const comando of ['[[CHAMAR_HUMANO:pagar]]','[[PAUSA_SILENCIOSA:estoque]]','[[PARAR_CONTATO:pedido]]','[[ENCERRAR_CONTATO:fim]]','[[SILENCIO_CORTESIA]]']) {
      expect(lerResposta(`${comando} [[NOTIFICAR_ADMIN:visita_a_caminho|agora]]`, { autonomia: true }).notificarAdmin).toBeUndefined();
    }
  });
  test('prompt não contradiz silêncio, limite de áudios ou Pix', () => {
    const prompt = montarInstrucoes({ ...BASE_EM_BRANCO, arquivos: [], gatilhosDeRepasse: '[POLITICA_AUTONOMIA_V2]' }, { agora: new Date('2026-11-12T12:00:00Z') });
    expect(prompt).toContain('NOTIFICAÇÃO SEM PAUSA');
    expect(prompt).not.toContain('Diga, em uma frase curta, que vai confirmar');
    expect(prompt).not.toContain('Antes do comando, escreva só um reconhecimento');
    expect(prompt).not.toContain('reconheça em uma frase curta');
  });
});
