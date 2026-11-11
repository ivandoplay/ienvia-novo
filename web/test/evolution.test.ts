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
  configurarAviso,
  consultarAviso,
  consultarChip,
  criarInstancia,
  desconectarInstancia,
  pedirQrCode,
} from '@/lib/evolution/cliente';

const servidor = criarEvolutionFalsa();
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

    const [instancia] = (await (await fetch(`${endereco}/controle/instancias`)).json()) as Array<{
      aviso: { url: string; headers: Record<string, string>; events: string[] };
    }>;
    expect(instancia?.aviso.url).toBe(AVISO.url);
    expect(instancia?.aviso.headers).toEqual({ Authorization: 'Bearer segredo-do-aviso' });
    expect(instancia?.aviso.events).toEqual(['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
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
    expect(await consultarAviso('ienvia-teste-01')).toEqual({ url: AVISO.url, ligado: true });
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
