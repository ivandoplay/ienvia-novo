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
      arquivo: null,
      paraBuscar: null,
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
      arquivo: null,
      paraBuscar: null,
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
    // O que o painel ainda não abre entra como uma etiqueta, para a conversa não ficar com buracos.
    ['localização', { locationMessage: { degreesLatitude: -3.7 } }, '📍 Localização'],
    ['cartão de contato', { contactMessage: { displayName: 'Zé' } }, '👤 Contato'],
  ])('%s', (_caso, mensagem, esperado) => {
    const aviso = interpretarAviso(avisoDeMensagem({ mensagem }), AGORA);
    expect(aviso).toMatchObject({ tipo: 'mensagem', texto: esperado, arquivo: null, paraBuscar: null });
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
    expect(aviso.tipo === 'mensagem' && aviso.texto?.length).toBe(8000);
  });
});

describe('mensagem com arquivo: foto, áudio, vídeo, documento e figurinha', () => {
  const comArquivo = (mensagem: Record<string, unknown>) => {
    const aviso = interpretarAviso(avisoDeMensagem({ mensagem }), AGORA);
    if (aviso.tipo !== 'mensagem') throw new Error(`esperava uma mensagem, veio: ${JSON.stringify(aviso)}`);
    return aviso;
  };

  test('foto com legenda: a legenda é o texto, e a ficha traz tipo, tamanho e medidas', () => {
    const aviso = comArquivo({
      imageMessage: { caption: 'meu comprovante', mimetype: 'image/jpeg', fileLength: '245000', width: 1280, height: 720 },
    });
    expect(aviso.texto).toBe('meu comprovante');
    expect(aviso.arquivo).toEqual({
      tipo: 'image',
      conteudo: 'image/jpeg',
      tamanho: 245000,
      nome: null,
      duracao: null,
      largura: 1280,
      altura: 720,
      voz: false,
    });
  });

  test('foto sem legenda: a mensagem vale mesmo sem texto', () => {
    const aviso = comArquivo({ imageMessage: { mimetype: 'image/jpeg' } });
    expect(aviso.texto).toBeNull();
    expect(aviso.arquivo).toMatchObject({ tipo: 'image', tamanho: null, largura: null, altura: null });
  });

  test('áudio gravado na hora é mensagem de voz; áudio encaminhado não é', () => {
    // O WhatsApp manda o tamanho como texto, como número ou no formato { low, high }.
    const voz = comArquivo({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 12, ptt: true, fileLength: { low: 18000, high: 0, unsigned: true } } });
    expect(voz.arquivo).toEqual({ tipo: 'audio', conteudo: 'audio/ogg', tamanho: 18000, nome: null, duracao: 12, largura: null, altura: null, voz: true });
    expect(voz.texto).toBeNull();

    const musica = comArquivo({ audioMessage: { mimetype: 'audio/mpeg', seconds: 201, ptt: false, fileLength: 4_800_000 } });
    expect(musica.arquivo).toMatchObject({ tipo: 'audio', conteudo: 'audio/mpeg', duracao: 201, voz: false, tamanho: 4_800_000 });
  });

  test('vídeo, e o vídeo redondo (recado em vídeo), entram como vídeo', () => {
    expect(comArquivo({ videoMessage: { mimetype: 'video/mp4', seconds: 21, width: 720, height: 1280, caption: 'olha isso' } })).toMatchObject({
      texto: 'olha isso',
      arquivo: { tipo: 'video', conteudo: 'video/mp4', duracao: 21, largura: 720, altura: 1280 },
    });
    expect(comArquivo({ ptvMessage: { mimetype: 'video/mp4', seconds: 8 } }).arquivo).toMatchObject({ tipo: 'video', duracao: 8 });
  });

  test('documento: vem o nome do arquivo; a legenda pode vir embrulhada ou não', () => {
    const embrulhado = comArquivo({
      documentWithCaptionMessage: { message: { documentMessage: { caption: 'contrato', fileName: 'Contrato Final.pdf', mimetype: 'application/pdf', fileLength: '90000' } } },
    });
    expect(embrulhado).toMatchObject({ texto: 'contrato', arquivo: { tipo: 'document', nome: 'Contrato Final.pdf', conteudo: 'application/pdf', tamanho: 90000 } });

    // A Evolution 2.3.7 já entrega desembrulhado.
    const direto = comArquivo({ documentMessage: { title: 'Planilha.xlsx', mimetype: 'application/vnd.ms-excel' } });
    expect(direto).toMatchObject({ texto: null, arquivo: { tipo: 'document', nome: 'Planilha.xlsx', largura: null, duracao: null } });
  });

  test('figurinha', () => {
    expect(comArquivo({ stickerMessage: { mimetype: 'image/webp', width: 512, height: 512, fileLength: '30000' } }).arquivo).toEqual({
      tipo: 'sticker',
      conteudo: 'image/webp',
      tamanho: 30000,
      nome: null,
      duracao: null,
      largura: 512,
      altura: 512,
      voz: false,
    });
  });

  test('foto dentro de uma mensagem temporária também vale', () => {
    expect(comArquivo({ ephemeralMessage: { message: { imageMessage: { mimetype: 'image/png', caption: 'some em 24h' } } } })).toMatchObject({
      texto: 'some em 24h',
      arquivo: { tipo: 'image', conteudo: 'image/png' },
    });
  });

  test('valores estranhos na ficha não derrubam a mensagem: viram "não sei"', () => {
    const aviso = comArquivo({ imageMessage: { mimetype: 'isto não é um tipo', fileLength: 'muito', width: 0, height: -5, seconds: 99 } });
    expect(aviso.arquivo).toEqual({ tipo: 'image', conteudo: 'application/octet-stream', tamanho: null, nome: null, duracao: null, largura: null, altura: null, voz: false });
  });

  test('junto vai o pedaço do aviso que a Evolution precisa para baixar o arquivo, sem a miniatura e sem a mensagem citada', () => {
    const chaveDoArquivo = { 0: 12, 1: 250, 2: 7 };
    const aviso = comArquivo({
      imageMessage: {
        mimetype: 'image/jpeg',
        url: 'https://mmg.whatsapp.net/v/t62/abc',
        directPath: '/v/t62/abc',
        mediaKey: chaveDoArquivo,
        fileLength: '245000',
        jpegThumbnail: { 0: 255, 1: 216, 2: 255 },
        contextInfo: { quotedMessage: { conversation: 'mensagem citada' } },
      },
      messageContextInfo: { deviceListMetadataVersion: 2 },
    });
    expect(aviso.paraBuscar).toEqual({
      key: { remoteJid: '5585999990000@s.whatsapp.net', fromMe: false, id: '3EB0C767D26A1B2C3D4E' },
      message: {
        imageMessage: { mimetype: 'image/jpeg', url: 'https://mmg.whatsapp.net/v/t62/abc', directPath: '/v/t62/abc', mediaKey: chaveDoArquivo, fileLength: '245000' },
      },
    });
  });

  test.each([
    ['foto', { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'só uma vez' } } } }, '📷 Foto de visualização única (só abre no celular do chip): só uma vez'],
    ['vídeo', { viewOnceMessage: { message: { videoMessage: { mimetype: 'video/mp4' } } } }, '🎥 Vídeo de visualização única (só abre no celular do chip)'],
    ['áudio', { viewOnceMessageV2Extension: { message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } } } }, '🎤 Áudio de visualização única (só abre no celular do chip)'],
    ['foto marcada por dentro', { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } }, '📷 Foto de visualização única (só abre no celular do chip)'],
  ])('visualização única (%s): o painel respeita, avisa e não guarda o arquivo', (_caso, mensagem, esperado) => {
    const aviso = comArquivo(mensagem);
    expect(aviso).toMatchObject({ texto: esperado, arquivo: null, paraBuscar: null });
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
