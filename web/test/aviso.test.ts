import { describe, expect, test } from 'vitest';
import { interpretarAviso } from '@/lib/evolution/aviso';

const AGORA = new Date('2026-11-12T09:30:00.000Z');

/** Um aviso de mensagem no formato que a Evolution 2.x manda. */
function avisoDeMensagem(mudancas: { chave?: object; dados?: object; mensagem?: object } = {}) {
  return {
    event: 'messages.upsert',
    instance: 'ienvia-9cedadf2-a1b2c3d4e5f6',
    data: {
      key: { remoteJid: '5585999990000@s.whatsapp.net', fromMe: false, id: '3EB0C767D26A1B2C3D4E', ...mudancas.chave },
      pushName: 'Maria Cliente',
      message: mudancas.mensagem ?? { conversation: 'Oi, tem pizza?' },
      messageType: 'conversation',
      messageTimestamp: 1794409200,
      ...mudancas.dados,
    },
    destination: 'https://painel.exemplo.com/api/webhooks/evolution',
    sender: '5585988887777@s.whatsapp.net',
    apikey: 'NAO-DEVE-SER-USADA',
  };
}

describe('mensagem que saiu pela Evolution (o eco do que o painel enviou)', () => {
  /** O aviso SEND_MESSAGE, no formato que a Evolution 2.3.7 monta depois de enviar. */
  const avisoDeEnvio = (chave: object = {}) => ({
    event: 'send.message',
    instance: 'ienvia-9cedadf2-a1b2c3d4e5f6',
    data: {
      key: { remoteJid: '5585999990000@s.whatsapp.net', fromMe: true, id: '3EB0AAAABBBBCCCCDDDD', ...chave },
      pushName: 'Você',
      status: 'PENDING',
      message: { conversation: 'Temos sim!' },
      messageType: 'conversation',
      messageTimestamp: 1794409200,
      instanceId: 'fbd56426-7889-45c5-bb11-f8fdb1d51ff5',
      source: 'unknown',
    },
  });

  test('vira uma mensagem "de mim", endereçada ao contato', () => {
    expect(interpretarAviso(avisoDeEnvio(), AGORA)).toEqual({
      tipo: 'mensagem',
      instancia: 'ienvia-9cedadf2-a1b2c3d4e5f6',
      idDoEvento: '3EB0AAAABBBBCCCCDDDD',
      remetente: '5585999990000@s.whatsapp.net',
      nome: 'Você',
      texto: 'Temos sim!',
      quando: '2026-11-11T15:00:00.000Z',
      deMim: true,
    });
  });

  test('é sempre "de mim", mesmo que o campo fromMe não venha', () => {
    expect(interpretarAviso(avisoDeEnvio({ fromMe: undefined }), AGORA)).toMatchObject({ tipo: 'mensagem', deMim: true });
    expect(interpretarAviso({ ...avisoDeEnvio(), event: 'SEND_MESSAGE' }, AGORA)).toMatchObject({ tipo: 'mensagem', deMim: true });
  });

  test('envio para grupo fica de fora', () => {
    expect(interpretarAviso(avisoDeEnvio({ remoteJid: '120363000000000000@g.us' }), AGORA).tipo).toBe('ignorado');
  });
});

describe('mensagem que chegou', () => {
  test('texto simples vira uma mensagem com remetente, nome, texto e hora', () => {
    expect(interpretarAviso(avisoDeMensagem(), AGORA)).toEqual({
      tipo: 'mensagem',
      instancia: 'ienvia-9cedadf2-a1b2c3d4e5f6',
      idDoEvento: '3EB0C767D26A1B2C3D4E',
      remetente: '5585999990000@s.whatsapp.net',
      nome: 'Maria Cliente',
      texto: 'Oi, tem pizza?',
      quando: '2026-11-11T15:00:00.000Z',
      deMim: false,
    });
  });

  test('aceita o nome do evento nos dois jeitos que a Evolution usa', () => {
    const aviso = { ...avisoDeMensagem(), event: 'MESSAGES_UPSERT' };
    expect(interpretarAviso(aviso, AGORA).tipo).toBe('mensagem');
  });

  test.each([
    ['texto com link ou resposta', { extendedTextMessage: { text: 'Olha esse link' } }, 'Olha esse link'],
    ['mensagem temporária', { ephemeralMessage: { message: { conversation: 'some em 24h' } } }, 'some em 24h'],
    ['foto com legenda', { imageMessage: { caption: 'meu comprovante' } }, '📷 Imagem: meu comprovante'],
    ['foto sem legenda', { imageMessage: { mimetype: 'image/jpeg' } }, '📷 Imagem'],
    ['áudio', { audioMessage: { seconds: 12 } }, '🎤 Áudio'],
    ['documento com legenda', { documentWithCaptionMessage: { message: { documentMessage: { caption: 'contrato' } } } }, '📎 Documento: contrato'],
    ['figurinha', { stickerMessage: {} }, 'Figurinha'],
    ['localização', { locationMessage: { degreesLatitude: -3.7 } }, '📍 Localização'],
  ])('%s', (_caso, mensagem, esperado) => {
    const aviso = interpretarAviso(avisoDeMensagem({ mensagem }), AGORA);
    expect(aviso).toMatchObject({ tipo: 'mensagem', texto: esperado });
  });

  test('quando o WhatsApp manda um código interno (@lid), usa o número do campo alternativo', () => {
    const aviso = interpretarAviso(
      avisoDeMensagem({ chave: { remoteJid: '123456789012345@lid', remoteJidAlt: '5586988887777@s.whatsapp.net' } }),
      AGORA,
    );
    expect(aviso).toMatchObject({ tipo: 'mensagem', remetente: '5586988887777@s.whatsapp.net' });
  });

  test('mensagem enviada pelo próprio chip é marcada como "de mim"', () => {
    expect(interpretarAviso(avisoDeMensagem({ chave: { fromMe: true } }), AGORA)).toMatchObject({ deMim: true });
  });

  test('sem hora no aviso, vale a hora em que ele chegou', () => {
    const aviso = interpretarAviso(avisoDeMensagem({ dados: { messageTimestamp: undefined } }), AGORA);
    expect(aviso).toMatchObject({ quando: AGORA.toISOString() });
  });

  test('texto gigante é cortado no limite que o banco aceita', () => {
    const aviso = interpretarAviso(avisoDeMensagem({ mensagem: { conversation: 'a'.repeat(9000) } }), AGORA);
    expect(aviso.tipo === 'mensagem' && aviso.texto.length).toBe(8000);
  });
});

describe('o que o painel deixa passar sem gravar', () => {
  test.each([
    ['grupo', avisoDeMensagem({ chave: { remoteJid: '120363000000000000@g.us' } })],
    ['status', avisoDeMensagem({ chave: { remoteJid: 'status@broadcast' } })],
    ['código interno sem número', avisoDeMensagem({ chave: { remoteJid: '123456789012345@lid' } })],
    ['reação', avisoDeMensagem({ mensagem: { reactionMessage: { text: '👍' } } })],
    ['mensagem sem identificador', avisoDeMensagem({ chave: { id: '' } })],
    ['evento que não usamos', { ...avisoDeMensagem(), event: 'presence.update' }],
    ['sem nome da instância', { ...avisoDeMensagem(), instance: '' }],
    ['corpo que não é um aviso', 'texto solto'],
    ['vazio', null],
  ])('%s', (_caso, corpo) => {
    expect(interpretarAviso(corpo, AGORA).tipo).toBe('ignorado');
  });
});

describe('chip que conectou ou caiu', () => {
  test('conectou: vem o estado e o número do chip', () => {
    const aviso = interpretarAviso({
      event: 'connection.update',
      instance: 'ienvia-9cedadf2-a1b2c3d4e5f6',
      data: { instance: 'ienvia-9cedadf2-a1b2c3d4e5f6', state: 'open', statusReason: 200, wuid: '5585988887777@s.whatsapp.net' },
    });
    expect(aviso).toEqual({ tipo: 'conexao', instancia: 'ienvia-9cedadf2-a1b2c3d4e5f6', estado: 'open', telefone: '+5585988887777' });
  });

  test('caiu: vem só o estado', () => {
    const aviso = interpretarAviso({ event: 'connection.update', instance: 'chip-1', data: { state: 'close', statusReason: 401 } });
    expect(aviso).toEqual({ tipo: 'conexao', instancia: 'chip-1', estado: 'close', telefone: null });
  });
});
