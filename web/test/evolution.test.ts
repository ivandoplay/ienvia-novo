/**
 * O cliente da Evolution conversando com a "Evolution de mentira" (que responde no mesmo
 * formato de uma Evolution 2.3.7 real). Nenhum chip de verdade é criado aqui.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { CHAVE_DE_TESTE, CODIGO_DE_PAREAMENTO, criarEvolutionFalsa } from '../e2e/apoio/evolution-falsa.mjs';
import {
  ErroEvolution,
  apagarInstancia,
  avisoEstaEmDia,
  configurarAviso,
  consultarAviso,
  consultarChip,
  criarInstancia,
  buscarArquivoDaMensagem,
  desconectarInstancia,
  enviarArquivo,
  enviarTexto,
  nomeDoDocumentoParaEnvio,
  pedirQrCode,
} from '@/lib/evolution/cliente';

const servidor = criarEvolutionFalsa({
  instancias: [
    { nome: 'ienvia-fixo-conectado', estado: 'open', telefone: '5585999990010' },
    { nome: 'ienvia-fixo-desconectado', estado: 'close', telefone: null },
  ],
});
let endereco = '';

const controle = (caminho: string) => fetch(`${endereco}/controle/${caminho}`, { method: 'POST' });
const AVISO = { url: 'https://painel.teste.invalid/api/webhooks/evolution', token: 'segredo-do-aviso' };

async function motivoDoErro(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ErroEvolution) return erro.motivo;
    throw erro;
  }
  return 'não deu erro';
}

beforeAll(async () => {
  await new Promise<void>((pronto) => servidor.listen(0, '127.0.0.1', pronto));
  endereco = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.EVOLUTION_API_URL;
  delete process.env.EVOLUTION_API_KEY;
  servidor.closeAllConnections();
  await new Promise((pronto) => servidor.close(pronto));
});

beforeEach(async () => {
  // Com barra no final de propósito: o endereço é limpo antes de usar.
  process.env.EVOLUTION_API_URL = `${endereco}/`;
  process.env.EVOLUTION_API_KEY = CHAVE_DE_TESTE;
  await controle('reiniciar');
});

describe('criar e conectar', () => {
  test('criar devolve o primeiro QR Code e já deixa o aviso de mensagens configurado', async () => {
    const qr = await criarInstancia({ nome: 'ienvia-teste-01', aviso: AVISO });
    expect(qr.imagem).toMatch(/^data:image\/png;base64,/);
    expect(qr.codigoDePareamento).toBeNull();

    const [instancia] = (await (await fetch(`${endereco}/controle/instancias?prefixo=ienvia-teste`)).json()) as Array<{
      aviso: { url: string; headers: Record<string, string>; events: string[] };
    }>;
    expect(instancia?.aviso.url).toBe(AVISO.url);
    expect(instancia?.aviso.headers).toEqual({ Authorization: 'Bearer segredo-do-aviso' });
    expect(instancia?.aviso.events).toEqual(['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE']);
  });

  test('nome repetido é reconhecido como "nome em uso"', async () => {
    await criarInstancia({ nome: 'ienvia-teste-01', aviso: null });
    expect(await motivoDoErro(criarInstancia({ nome: 'ienvia-teste-01', aviso: null }))).toBe('nome_em_uso');
  });

  test('sem número vem a imagem; com número vem também o código de 8 dígitos', async () => {
    await criarInstancia({ nome: 'ienvia-teste-01', aviso: null });
    const semNumero = await pedirQrCode('ienvia-teste-01');
    expect(semNumero).toMatchObject({ codigoDePareamento: null, jaConectado: false });
    expect(semNumero.imagem).toMatch(/^data:image\/png/);

    const comNumero = await pedirQrCode('ienvia-teste-01', '5585999990000');
    expect(comNumero.codigoDePareamento).toBe(CODIGO_DE_PAREAMENTO);
  });

  test('pedir QR Code de um chip que já conectou avisa que já está conectado', async () => {
    await criarInstancia({ nome: 'ienvia-teste-01', aviso: null });
    await controle('conectar');
    expect(await pedirQrCode('ienvia-teste-01')).toMatchObject({ jaConectado: true, imagem: null });
  });
});

describe('estado do chip', () => {
  test('antes de ler o QR Code está "connecting" e sem número; depois, "open" com o número', async () => {
    await criarInstancia({ nome: 'ienvia-teste-01', aviso: null });
    expect(await consultarChip('ienvia-teste-01')).toEqual({ estado: 'connecting', telefone: null });

    await controle('conectar?telefone=5586988887777');
    expect(await consultarChip('ienvia-teste-01')).toEqual({ estado: 'open', telefone: '+5586988887777' });
  });

  test('desconectar deixa o chip pronto para um novo QR Code; apagar some com ele', async () => {
    await criarInstancia({ nome: 'ienvia-teste-01', aviso: null });
    await controle('conectar');
    await desconectarInstancia('ienvia-teste-01');
    expect(await consultarChip('ienvia-teste-01')).toEqual({ estado: 'close', telefone: null });

    await apagarInstancia('ienvia-teste-01');
    expect(await motivoDoErro(consultarChip('ienvia-teste-01'))).toBe('nao_encontrada');
    // Apagar de novo não é erro: o que importa é que não existe mais.
    await expect(apagarInstancia('ienvia-teste-01')).resolves.toBeUndefined();
  });

  test('chip que não existe é reconhecido como "não encontrado"', async () => {
    expect(await motivoDoErro(pedirQrCode('ienvia-nao-existe'))).toBe('nao_encontrada');
    expect(await motivoDoErro(desconectarInstancia('ienvia-nao-existe'))).toBe('nao_encontrada');
  });
});

describe('aviso de mensagens', () => {
  test('sem aviso configurado devolve nada; depois de configurar, devolve o endereço', async () => {
    await criarInstancia({ nome: 'ienvia-teste-01', aviso: null });
    expect(await consultarAviso('ienvia-teste-01')).toBeNull();

    await configurarAviso('ienvia-teste-01', AVISO);
    expect(await consultarAviso('ienvia-teste-01')).toEqual({
      url: AVISO.url,
      ligado: true,
      eventos: ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE'],
    });
  });
});

describe('quando algo dá errado', () => {
  test('sem endereço ou chave configurados, nem tenta chamar', async () => {
    delete process.env.EVOLUTION_API_KEY;
    expect(await motivoDoErro(consultarChip('ienvia-teste-01'))).toBe('nao_configurada');
  });

  test('chave errada é recusa (a Evolution respondeu que não fez)', async () => {
    process.env.EVOLUTION_API_KEY = 'chave-errada';
    expect(await motivoDoErro(criarInstancia({ nome: 'ienvia-teste-01', aviso: null }))).toBe('recusada');
  });

  test('pedido recusado é "recusada": pode tentar de novo sem risco', async () => {
    await controle('falha?tipo=recusa');
    expect(await motivoDoErro(criarInstancia({ nome: 'ienvia-teste-01', aviso: null }))).toBe('recusada');
  });

  test('conexão que cai no meio é "incerta": não dá para saber se a Evolution fez', async () => {
    await controle('falha?tipo=queda');
    expect(await motivoDoErro(criarInstancia({ nome: 'ienvia-teste-01', aviso: null }))).toBe('incerta');
  });

  test('pane no servidor da Evolution também é "incerta"', async () => {
    await controle('falha?tipo=pane');
    expect(await motivoDoErro(criarInstancia({ nome: 'ienvia-teste-01', aviso: null }))).toBe('incerta');
  });

  test('a chave nunca aparece na mensagem de erro', async () => {
    await controle('falha?tipo=recusa');
    try {
      await criarInstancia({ nome: 'ienvia-teste-01', aviso: AVISO });
      expect.unreachable();
    } catch (erro) {
      expect(String((erro as Error).message)).not.toContain(CHAVE_DE_TESTE);
      expect(String((erro as Error).message)).not.toContain(AVISO.token);
    }
  });
});

describe('aviso de mensagens em dia', () => {
  const URL_DO_PAINEL = AVISO.url;

  test('o aviso criado junto com o chip já está em dia', async () => {
    await criarInstancia({ nome: 'ienvia-teste-01', aviso: AVISO });
    const atual = await consultarAviso('ienvia-teste-01');
    expect(atual).toEqual({ url: URL_DO_PAINEL, ligado: true, eventos: ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE'] });
    expect(avisoEstaEmDia(atual, URL_DO_PAINEL)).toBe(true);
  });

  test.each([
    ['não existe', null],
    ['aponta para outro endereço', { url: 'https://outro.exemplo/api', ligado: true, eventos: ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE'] }],
    ['está desligado', { url: URL_DO_PAINEL, ligado: false, eventos: ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE'] }],
    // Chip criado antes de o painel pedir o aviso das mensagens enviadas.
    ['não avisa as mensagens enviadas', { url: URL_DO_PAINEL, ligado: true, eventos: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] }],
  ])('aviso que %s precisa ser refeito', (_caso, atual) => {
    expect(avisoEstaEmDia(atual, URL_DO_PAINEL)).toBe(false);
  });
});

describe('enviar texto', () => {
  const enviadas = async () =>
    (await (await fetch(`${endereco}/controle/enviadas`)).json()) as Array<{ instancia: string; numero: string; texto: string; id: string }>;

  beforeEach(async () => {
    await fetch(`${endereco}/controle/enviadas`, { method: 'DELETE' });
  });

  test('mensagem enviada volta com o identificador dela no WhatsApp', async () => {
    const resultado = await enviarTexto('ienvia-fixo-conectado', '5585988880001', 'Temos sim!\nQuer que eu separe?');
    expect(resultado).toEqual({ situacao: 'enviada', idNoWhatsApp: expect.stringMatching(/^3EB0[0-9A-F]{18}$/) });
    expect(await enviadas()).toEqual([
      {
        instancia: 'ienvia-fixo-conectado',
        numero: '5585988880001',
        texto: 'Temos sim!\nQuer que eu separe?',
        id: resultado.situacao === 'enviada' ? resultado.idNoWhatsApp : '',
      },
    ]);
  });

  test('número sem WhatsApp: com certeza não foi enviada', async () => {
    expect(await enviarTexto('ienvia-fixo-conectado', '5585988880404', 'Oi')).toEqual({ situacao: 'nao_enviada', motivo: 'sem_whatsapp' });
    expect(await enviadas()).toEqual([]);
  });

  test('chip que não existe na Evolution: com certeza não foi enviada', async () => {
    expect(await enviarTexto('ienvia-nao-existe', '5585988880001', 'Oi')).toEqual({ situacao: 'nao_enviada', motivo: 'chip_nao_encontrado' });
  });

  test('chave recusada: com certeza não foi enviada', async () => {
    process.env.EVOLUTION_API_KEY = 'chave-errada';
    expect(await enviarTexto('ienvia-fixo-conectado', '5585988880001', 'Oi')).toEqual({ situacao: 'nao_enviada', motivo: 'chave_recusada' });
  });

  test('Evolution não configurada neste ambiente: com certeza não foi enviada', async () => {
    delete process.env.EVOLUTION_API_URL;
    expect(await enviarTexto('ienvia-fixo-conectado', '5585988880001', 'Oi')).toEqual({ situacao: 'nao_enviada', motivo: 'nao_configurada' });
  });

  test('erro do servidor da Evolution: não dá para saber se saiu', async () => {
    expect(await enviarTexto('ienvia-fixo-conectado', '5585988880500', 'Oi')).toMatchObject({ situacao: 'incerta' });
  });

  test('"400" comum da Evolution também é incerto (ela responde assim até quando a mensagem já saiu)', async () => {
    await controle('falha?tipo=recusa');
    expect(await enviarTexto('ienvia-fixo-conectado', '5585988880001', 'Oi')).toMatchObject({ situacao: 'incerta' });
  });

  test('conexão que cai no meio: não dá para saber se saiu', async () => {
    await controle('falha?tipo=queda');
    expect(await enviarTexto('ienvia-fixo-conectado', '5585988880001', 'Oi')).toMatchObject({ situacao: 'incerta' });
  });

  test('chip desconectado: a Evolution não responde e o envio fica incerto depois do tempo limite', async () => {
    const resultado = await enviarTexto('ienvia-fixo-desconectado', '5585988880001', 'Oi', { tempoLimite: 300 });
    expect(resultado).toMatchObject({ situacao: 'incerta' });
    expect(await enviadas()).toEqual([]);
  });
});

describe('enviar arquivo', () => {
  interface EnvioDeArquivo {
    instancia: string;
    numero: string;
    tipo: string;
    legenda: string | null;
    nome: string | null;
    conteudo: string | null;
    bytes: number;
  }
  const arquivosEnviados = async () => (await (await fetch(`${endereco}/controle/enviadas`)).json()) as EnvioDeArquivo[];
  const tentativasDeEnvio = async () => (await (await fetch(`${endereco}/controle/tentativas`)).json()) as EnvioDeArquivo[];
  const BYTES = Buffer.from('conteúdo de um arquivo de teste, com acento e tudo');

  beforeEach(async () => {
    await fetch(`${endereco}/controle/enviadas`, { method: 'DELETE' });
  });

  test('foto: vai com a legenda, sem nome de arquivo (a Evolution converte para JPEG e põe o nome certo)', async () => {
    const resultado = await enviarArquivo('ienvia-fixo-conectado', '5585988880001', {
      tipo: 'image',
      dados: BYTES,
      conteudo: 'image/png',
      nome: 'Promoção.png',
      legenda: 'Olha a promoção!',
    });
    expect(resultado).toEqual({ situacao: 'enviada', idNoWhatsApp: expect.stringMatching(/^3EB0[0-9A-F]{18}$/) });
    expect(await arquivosEnviados()).toMatchObject([
      { instancia: 'ienvia-fixo-conectado', numero: '5585988880001', tipo: 'image', legenda: 'Olha a promoção!', nome: null, conteudo: 'image/jpeg', bytes: BYTES.length },
    ]);
  });

  test('vídeo: vai como está, sem nome de arquivo; sem legenda, o campo nem é mandado', async () => {
    await enviarArquivo('ienvia-fixo-conectado', '5585988880001', { tipo: 'video', dados: BYTES, conteudo: 'video/mp4', nome: 'inauguração.mp4', legenda: null });
    expect(await arquivosEnviados()).toMatchObject([{ tipo: 'video', legenda: null, nome: null, conteudo: 'video/mp4', bytes: BYTES.length }]);
  });

  test('documento: vai com o nome que a pessoa vê e a legenda', async () => {
    await enviarArquivo('ienvia-fixo-conectado', '5585988880001', {
      tipo: 'document',
      dados: BYTES,
      conteudo: 'application/pdf',
      nome: 'Orçamento nº 12.pdf',
      legenda: 'Segue o orçamento.',
    });
    expect(await arquivosEnviados()).toMatchObject([{ tipo: 'document', legenda: 'Segue o orçamento.', nome: 'Orçamento nº 12.pdf', conteudo: 'application/pdf', bytes: BYTES.length }]);
  });

  test('documento sem nome nunca vai sem nome (a Evolution de verdade quebra): ganha um, com a terminação certa', async () => {
    const resultado = await enviarArquivo('ienvia-fixo-conectado', '5585988880001', { tipo: 'document', dados: BYTES, conteudo: 'application/pdf', nome: null, legenda: null });
    expect(resultado.situacao).toBe('enviada');
    expect(await arquivosEnviados()).toMatchObject([{ tipo: 'document', nome: 'documento.pdf' }]);
  });

  test('áudio: sai como mensagem de voz, por outra porta da Evolution, sem legenda', async () => {
    const resultado = await enviarArquivo('ienvia-fixo-conectado', '5585988880001', { tipo: 'audio', dados: BYTES, conteudo: 'audio/mpeg', nome: 'recado.mp3', legenda: null });
    expect(resultado.situacao).toBe('enviada');
    expect(await arquivosEnviados()).toMatchObject([{ tipo: 'audio', legenda: null, nome: null, conteudo: 'audio/ogg; codecs=opus', bytes: BYTES.length }]);
  });

  test('o arquivo chega inteiro, byte a byte', async () => {
    const dados = Buffer.from(Array.from({ length: 70_000 }, (_, indice) => (indice * 31) % 256));
    await enviarArquivo('ienvia-fixo-conectado', '5585988880001', { tipo: 'document', dados, conteudo: 'application/zip', nome: 'pacote.zip', legenda: null });
    expect(await arquivosEnviados()).toMatchObject([{ bytes: 70_000 }]);
  });

  test('as mesmas certezas e dúvidas do texto: sem WhatsApp não sai; erro do servidor é incerto; chip desconectado é incerto', async () => {
    const arquivo = { tipo: 'image' as const, dados: BYTES, conteudo: 'image/jpeg', nome: null, legenda: null };
    expect(await enviarArquivo('ienvia-fixo-conectado', '5585988880404', arquivo)).toEqual({ situacao: 'nao_enviada', motivo: 'sem_whatsapp' });
    expect(await enviarArquivo('ienvia-fixo-conectado', '5585988880500', arquivo)).toMatchObject({ situacao: 'incerta' });
    expect(await enviarArquivo('ienvia-nao-existe', '5585988880001', arquivo)).toEqual({ situacao: 'nao_enviada', motivo: 'chip_nao_encontrado' });
    expect(await enviarArquivo('ienvia-fixo-desconectado', '5585988880001', arquivo, { tempoLimite: 300 })).toMatchObject({ situacao: 'incerta' });
    expect(await enviarArquivo('ienvia-fixo-conectado', '5585988880404', { ...arquivo, tipo: 'audio' })).toEqual({ situacao: 'nao_enviada', motivo: 'sem_whatsapp' });
    expect(await arquivosEnviados()).toEqual([]);
    // Cada envio chamou a Evolution uma única vez (o do chip que não existe nem chega a ser anotado por ela).
    expect(await tentativasDeEnvio()).toHaveLength(4);
  });

  test.each([
    ['Contrato.pdf', 'application/pdf', 'Contrato.pdf'],
    ['Relatório Final.PDF', 'application/pdf', 'Relatório Final.PDF'],
    ['Contrato', 'application/pdf', 'Contrato.pdf'],
    ['planilha de vendas', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'planilha de vendas.xlsx'],
    ['arquivo sem tipo conhecido', 'application/x-coisa-rara', 'arquivo sem tipo conhecido.bin'],
    [null, 'application/pdf', 'documento.pdf'],
    ['   ', 'text/plain', 'documento.txt'],
    ['pasta/sub\\nome.txt', 'text/plain', 'pasta sub nome.txt'],
    ['com\nquebra.txt', 'text/plain', 'com quebra.txt'],
  ])('nome do documento %s (%s) → %s', (nome, conteudo, esperado) => {
    expect(nomeDoDocumentoParaEnvio(nome, conteudo)).toBe(esperado);
  });

  test('nome de documento enorme é cortado', () => {
    expect(nomeDoDocumentoParaEnvio(`${'a'.repeat(300)}`, 'application/pdf').length).toBeLessThanOrEqual(204);
  });
});

describe('buscar o arquivo de uma mensagem recebida', () => {
  const buscas = async () => (await (await fetch(`${endereco}/controle/buscas`)).json()) as Array<{ instancia: string; id: string; comAMensagemInteira: boolean }>;

  beforeEach(async () => {
    await fetch(`${endereco}/controle/buscas`, { method: 'DELETE' });
  });

  test('com o aviso inteiro, a Evolution baixa do WhatsApp e devolve o arquivo e o tipo dele', async () => {
    const resultado = await buscarArquivoDaMensagem('ienvia-fixo-conectado', {
      key: { id: 'MSG-FOTO', remoteJid: '5585988880001@s.whatsapp.net', fromMe: false },
      message: { imageMessage: { mimetype: 'image/jpeg', mediaKey: { 0: 1 } } },
    });
    expect(resultado).toMatchObject({ ok: true, conteudo: 'image/png' });
    // É mesmo um PNG, inteiro.
    expect(resultado.ok && resultado.dados.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    expect(await buscas()).toEqual([{ instancia: 'ienvia-fixo-conectado', id: 'MSG-FOTO', comAMensagemInteira: true }]);
  });

  test('só com a identificação, a Evolution procura a mensagem no próprio histórico', async () => {
    const resultado = await buscarArquivoDaMensagem('ienvia-fixo-conectado', { key: { id: 'MSG-ANTIGA' } });
    expect(resultado.ok).toBe(true);
    expect(await buscas()).toEqual([{ instancia: 'ienvia-fixo-conectado', id: 'MSG-ANTIGA', comAMensagemInteira: false }]);
  });

  test('áudio e documento vêm com o tipo certo', async () => {
    const audio = await buscarArquivoDaMensagem('ienvia-fixo-conectado', { key: { id: 'MSG-AUDIO' }, message: { audioMessage: { ptt: true } } });
    expect(audio).toMatchObject({ ok: true, conteudo: 'audio/wav' });
    const documento = await buscarArquivoDaMensagem('ienvia-fixo-conectado', { key: { id: 'MSG-DOC' }, message: { documentMessage: { fileName: 'Contrato.pdf' } } });
    expect(documento).toMatchObject({ ok: true, conteudo: 'application/pdf' });
    expect(documento.ok && documento.dados.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('mensagem que a Evolution não tem mais: devolve o motivo, sem lançar erro', async () => {
    expect(await buscarArquivoDaMensagem('ienvia-fixo-conectado', { key: { id: 'MSG-SEM-ARQUIVO' } })).toEqual({ ok: false, detalhe: 'HTTP 400: Message not found' });
  });

  test('chip que não existe, Evolution fora do ar e Evolution não configurada: nunca lança erro', async () => {
    expect(await buscarArquivoDaMensagem('ienvia-nao-existe', { key: { id: 'MSG-1' } })).toMatchObject({ ok: false });
    await controle('falha?tipo=queda');
    expect(await buscarArquivoDaMensagem('ienvia-fixo-conectado', { key: { id: 'MSG-1' } })).toEqual({ ok: false, detalhe: 'A Evolution não respondeu a tempo.' });
    delete process.env.EVOLUTION_API_URL;
    expect(await buscarArquivoDaMensagem('ienvia-fixo-conectado', { key: { id: 'MSG-1' } })).toMatchObject({ ok: false });
  });

  test('a chave da Evolution nunca aparece no motivo da falha', async () => {
    await controle('falha?tipo=pane');
    const resultado = await buscarArquivoDaMensagem('ienvia-fixo-conectado', { key: { id: 'MSG-1' } });
    expect(resultado.ok).toBe(false);
    expect(JSON.stringify(resultado)).not.toContain(CHAVE_DE_TESTE);
  });
});
