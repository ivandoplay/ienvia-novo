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
  desconectarInstancia,
  enviarTexto,
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
