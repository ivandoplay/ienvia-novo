/**
 * O painel conversando com a "IA de mentira" (que responde no formato do Gemini, do OpenRouter e da NVIDIA,
 * com cópias das respostas de erro de verdade de cada um).
 * Nenhuma chave de verdade é usada aqui.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  CHAVE_GEMINI_DE_TESTE,
  CHAVE_GEMINI_NO_LIMITE,
  CHAVE_GEMINI_VAZADA,
  CHAVE_NVIDIA_DE_TESTE,
  CHAVE_NVIDIA_NO_LIMITE,
  CHAVE_OPENROUTER_DE_TESTE,
  CHAVE_OPENROUTER_SEM_CREDITO,
  criarIaFalsa,
  type PedidoRecebido,
} from '../e2e/apoio/ia-falsa.mjs';
import {
  ErroDeIa,
  enderecoDoProvedor,
  gerarResposta,
  listarModelos,
  nomeDoModeloGemini,
  semChaves,
  testarConexao,
  type PedidoDeResposta,
} from '@/lib/ia/provedores';

const servidor = criarIaFalsa();
let endereco = '';

const controle = (caminho: string) => fetch(`${endereco}/controle/${caminho}`, { method: 'POST' });
const pedidosRecebidos = async (): Promise<PedidoRecebido[]> => (await fetch(`${endereco}/controle/pedidos`)).json() as Promise<PedidoRecebido[]>;

async function erroDe(promessa: Promise<unknown>): Promise<ErroDeIa> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ErroDeIa) return erro;
    throw erro;
  }
  throw new Error('não deu erro');
}

const noGemini = (extra: Partial<PedidoDeResposta> = {}): PedidoDeResposta => ({
  provedor: 'gemini',
  chave: CHAVE_GEMINI_DE_TESTE,
  modelo: 'gemini-3.5-flash-lite',
  sistema: 'Você atende a Pizzaria da Praça.',
  conversa: [{ de: 'cliente', texto: 'Vocês entregam?' }],
  ...extra,
});

const noOpenRouter = (extra: Partial<PedidoDeResposta> = {}): PedidoDeResposta => ({
  provedor: 'openrouter',
  chave: CHAVE_OPENROUTER_DE_TESTE,
  modelo: 'deepseek/deepseek-chat',
  sistema: 'Você atende a Pizzaria da Praça.',
  conversa: [{ de: 'cliente', texto: 'Vocês entregam?' }],
  ...extra,
});

const naNvidia = (extra: Partial<PedidoDeResposta> = {}): PedidoDeResposta => ({
  provedor: 'nvidia',
  chave: CHAVE_NVIDIA_DE_TESTE,
  modelo: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  sistema: 'Você atende a Pizzaria da Praça.',
  conversa: [{ de: 'cliente', texto: 'Vocês entregam?' }],
  ...extra,
});

beforeAll(async () => {
  await new Promise<void>((pronto) => servidor.listen(0, '127.0.0.1', pronto));
  endereco = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.IENVIA_GEMINI_URL;
  delete process.env.IENVIA_OPENROUTER_URL;
  delete process.env.IENVIA_NVIDIA_URL;
  servidor.closeAllConnections();
  await new Promise((pronto) => servidor.close(pronto));
});

beforeEach(async () => {
  // Com barra no final de propósito: o endereço é limpo antes de usar.
  process.env.IENVIA_GEMINI_URL = `${endereco}/`;
  process.env.IENVIA_OPENROUTER_URL = `${endereco}/openrouter/api/v1/`;
  process.env.IENVIA_NVIDIA_URL = `${endereco}/nvidia/v1`;
  await controle('reiniciar');
});

describe('Gemini', () => {
  test('pede a resposta e devolve o texto, o modelo, o gasto e o tempo', async () => {
    const resposta = await gerarResposta(noGemini({ temperatura: 0.6 }));
    expect(resposta).toMatchObject({
      provedor: 'gemini',
      modelo: 'gemini-3.5-flash-lite',
      texto: 'Resposta de teste para: "Vocês entregam?"',
      tokens: { entrada: 120, saida: 18 },
    });
    expect(resposta.duracaoMs).toBeGreaterThanOrEqual(0);

    expect(await pedidosRecebidos()).toEqual([
      {
        provedor: 'gemini',
        modelo: 'gemini-3.5-flash-lite',
        sistema: 'Você atende a Pizzaria da Praça.',
        conversa: [{ de: 'cliente', texto: 'Vocês entregam?' }],
        anexo: null,
        temperatura: 0.6,
      },
    ]);
  });

  test('a conversa vai na ordem; falas seguidas da mesma pessoa viram uma só (o Gemini exige alternância)', async () => {
    await gerarResposta(
      noGemini({
        conversa: [
          { de: 'cliente', texto: 'Oi' },
          { de: 'cliente', texto: 'Tem pizza doce?' },
          { de: 'atendente', texto: 'Tem sim!' },
          { de: 'atendente', texto: 'Chocolate e banana.' },
          { de: 'cliente', texto: 'Quero a de chocolate' },
        ],
      }),
    );
    expect((await pedidosRecebidos())[0]!.conversa).toEqual([
      { de: 'cliente', texto: 'Oi\nTem pizza doce?' },
      { de: 'atendente', texto: 'Tem sim!\nChocolate e banana.' },
      { de: 'cliente', texto: 'Quero a de chocolate' },
    ]);
  });

  test('foto ou áudio do cliente vai junto com a última fala; sem texto nenhum, vai sozinho', async () => {
    await gerarResposta(noGemini({ anexo: { tipo: 'audio/ogg', dados: Buffer.alloc(900, 1) } }));
    await gerarResposta(noGemini({ conversa: [], anexo: { tipo: 'image/jpeg', dados: Buffer.alloc(300, 2) } }));
    const [comTexto, semTexto] = await pedidosRecebidos();
    expect(comTexto).toMatchObject({ conversa: [{ de: 'cliente', texto: 'Vocês entregam?' }], anexo: { tipo: 'audio/ogg', bytes: 900 } });
    expect(semTexto).toMatchObject({ conversa: [{ de: 'cliente', texto: '' }], anexo: { tipo: 'image/jpeg', bytes: 300 } });
  });

  test('o raciocínio interno de um modelo que "pensa" não entra na resposta', async () => {
    const resposta = await gerarResposta(noGemini({ modelo: 'gemini-4-argon' }));
    expect(resposta.texto).toBe('Resposta de teste para: "Vocês entregam?"');
  });

  test('"models/nome" e "nome" são o mesmo modelo; nome estranho nem sai do painel', async () => {
    expect(nomeDoModeloGemini(' models/gemini-3.8-flash ')).toBe('gemini-3.8-flash');
    expect(nomeDoModeloGemini('deepseek/deepseek-chat')).toBeNull();
    expect(nomeDoModeloGemini('../outro')).toBeNull();
    expect(nomeDoModeloGemini('')).toBeNull();

    expect((await gerarResposta(noGemini({ modelo: 'models/gemini-3.8-flash' }))).modelo).toBe('gemini-3.8-flash');
    expect(await erroDe(gerarResposta(noGemini({ modelo: 'modelo/com/barras' })))).toMatchObject({ motivo: 'modelo_inexistente' });
    expect(await pedidosRecebidos()).toHaveLength(1);
  });

  test('cada tipo de problema vira um motivo claro, e o painel nunca tenta de novo sozinho', async () => {
    expect(await erroDe(gerarResposta(noGemini({ chave: 'AIzaSy-chave-errada-000000000000000000' })))).toMatchObject({ motivo: 'chave_invalida', status: 400 });
    expect(await erroDe(gerarResposta(noGemini({ chave: '   ' })))).toMatchObject({ motivo: 'chave_invalida' });
    expect(await erroDe(gerarResposta(noGemini({ modelo: 'gemini-que-nao-existe' })))).toMatchObject({ motivo: 'modelo_inexistente', status: 404 });
    expect(await erroDe(gerarResposta(noGemini({ chave: CHAVE_GEMINI_NO_LIMITE })))).toMatchObject({ motivo: 'limite', status: 429 });
    expect(await erroDe(gerarResposta(noGemini({ conversa: [] })))).toMatchObject({ motivo: 'recusada' });
    // A chave que o Google achou publicada e bloqueou tem um motivo só dela: trocar de chave é a única saída.
    expect(await erroDe(gerarResposta(noGemini({ chave: CHAVE_GEMINI_VAZADA })))).toMatchObject({ motivo: 'chave_vazada', status: 403 });
    expect(await erroDe(listarModelos('gemini', CHAVE_GEMINI_VAZADA))).toMatchObject({ motivo: 'chave_vazada', status: 403 });

    for (const [falha, motivo] of [
      ['pane', 'indisponivel'],
      ['limite', 'limite'],
      ['bloqueio', 'bloqueada'],
      ['vazio', 'resposta_vazia'],
      ['queda', 'rede'],
    ] as const) {
      await controle('reiniciar');
      await controle(`falha?tipo=${falha}&vezes=1`);
      expect(await erroDe(gerarResposta(noGemini())), falha).toMatchObject({ provedor: 'gemini', motivo });
      // Uma chamada só: a segunda tentativa, se existisse, teria dado certo e apareceria aqui.
      expect(await pedidosRecebidos(), falha).toHaveLength(1);
    }
  });

  test('provedor que não responde: desiste no prazo e diz que foi o tempo', async () => {
    await controle('falha?tipo=silencio&vezes=1');
    const inicio = Date.now();
    expect(await erroDe(gerarResposta(noGemini({ tempoLimiteMs: 300 })))).toMatchObject({ motivo: 'tempo' });
    expect(Date.now() - inicio).toBeLessThan(3000);
  });

  test('endereço que não existe: erro de rede, sem travar', async () => {
    process.env.IENVIA_GEMINI_URL = 'http://127.0.0.1:9';
    expect(await erroDe(gerarResposta(noGemini()))).toMatchObject({ motivo: 'rede' });
  });

  test('a chave nunca aparece na mensagem de erro', async () => {
    const chave = 'AIzaSy-chave-errada-000000000000000000';
    const erro = await erroDe(gerarResposta(noGemini({ chave })));
    expect(erro.message).not.toContain(chave);
    expect(erro.message).toBe('API key not valid. Please pass a valid API key.');
  });
});

describe('OpenRouter', () => {
  test('pede a resposta no formato de conversa, com as instruções na frente', async () => {
    const resposta = await gerarResposta(
      noOpenRouter({
        temperatura: 0.2,
        conversa: [
          { de: 'cliente', texto: 'Oi' },
          { de: 'cliente', texto: 'Tem pizza doce?' },
          { de: 'atendente', texto: 'Tem sim!' },
          { de: 'cliente', texto: 'Quero a de chocolate' },
        ],
      }),
    );
    expect(resposta).toMatchObject({
      provedor: 'openrouter',
      modelo: 'deepseek/deepseek-chat',
      texto: 'Resposta de teste para: "Quero a de chocolate"',
      tokens: { entrada: 120, saida: 18 },
    });
    expect(await pedidosRecebidos()).toEqual([
      {
        provedor: 'openrouter',
        modelo: 'deepseek/deepseek-chat',
        sistema: 'Você atende a Pizzaria da Praça.',
        conversa: [
          { de: 'cliente', texto: 'Oi\nTem pizza doce?' },
          { de: 'atendente', texto: 'Tem sim!' },
          { de: 'cliente', texto: 'Quero a de chocolate' },
        ],
        anexo: null,
        temperatura: 0.2,
      },
    ]);
  });

  test('foto vai junto com a última fala; áudio não é aceito e nem sai do painel', async () => {
    await gerarResposta(noOpenRouter({ modelo: 'google/gemma-4-26b-a4b-it:free', anexo: { tipo: 'image/png', dados: Buffer.alloc(512, 3) } }));
    expect((await pedidosRecebidos())[0]).toMatchObject({ conversa: [{ de: 'cliente', texto: 'Vocês entregam?' }], anexo: { tipo: 'image/png', bytes: 512 } });

    expect(await erroDe(gerarResposta(noOpenRouter({ anexo: { tipo: 'audio/ogg', dados: Buffer.alloc(10) } })))).toMatchObject({ motivo: 'nao_suportado' });
    expect(await pedidosRecebidos()).toHaveLength(1);

    // Foto para um modelo que só lê texto: o OpenRouter responde 404, mas o modelo existe; só não enxerga.
    expect(await erroDe(gerarResposta(noOpenRouter({ anexo: { tipo: 'image/jpeg', dados: Buffer.alloc(64, 1) } })))).toMatchObject({
      motivo: 'nao_suportado',
      status: 404,
    });
  });

  test('cada tipo de problema vira um motivo claro, e o painel nunca tenta de novo sozinho', async () => {
    expect(await erroDe(gerarResposta(noOpenRouter({ chave: 'sk-or-v1-chave-errada' })))).toMatchObject({ motivo: 'chave_invalida', status: 401 });
    expect(await erroDe(gerarResposta(noOpenRouter({ chave: CHAVE_OPENROUTER_SEM_CREDITO })))).toMatchObject({ motivo: 'sem_credito', status: 402 });
    expect(await erroDe(gerarResposta(noOpenRouter({ modelo: 'fabricante/modelo-que-nao-existe' })))).toMatchObject({ motivo: 'modelo_inexistente' });
    // Um modelo que só gera imagem não serve para conversar.
    expect(await erroDe(gerarResposta(noOpenRouter({ modelo: 'black-forest-labs/flux-3' })))).toMatchObject({ motivo: 'modelo_inexistente' });

    for (const [falha, motivo] of [
      ['pane', 'indisponivel'],
      ['limite', 'limite'],
      ['bloqueio', 'bloqueada'],
      ['vazio', 'resposta_vazia'],
      ['erro-no-corpo', 'indisponivel'],
      ['queda', 'rede'],
    ] as const) {
      await controle('reiniciar');
      await controle(`falha?tipo=${falha}&vezes=1`);
      expect(await erroDe(gerarResposta(noOpenRouter())), falha).toMatchObject({ provedor: 'openrouter', motivo });
      expect(await pedidosRecebidos(), falha).toHaveLength(1);
    }
  });

  test('a falha simulada de um provedor não atinge o outro', async () => {
    await controle('falha?tipo=pane&vezes=5&provedor=gemini');
    expect((await gerarResposta(noOpenRouter())).texto).toContain('Vocês entregam?');
    expect(await erroDe(gerarResposta(noGemini()))).toMatchObject({ motivo: 'indisponivel' });
  });
});

describe('NVIDIA', () => {
  test('pede a resposta no formato de conversa e pede ao modelo que não fique raciocinando', async () => {
    const resposta = await gerarResposta(
      naNvidia({
        temperatura: 0.2,
        conversa: [
          { de: 'cliente', texto: 'Oi' },
          { de: 'cliente', texto: 'Tem pizza doce?' },
          { de: 'atendente', texto: 'Tem sim!' },
          { de: 'cliente', texto: 'Quero a de chocolate' },
        ],
      }),
    );
    expect(resposta).toMatchObject({
      provedor: 'nvidia',
      // A NVIDIA devolve o modelo com outro nome ("private/..."): a resposta guarda o que o provedor informou.
      modelo: 'private/nvidia/nemotron-3.5-lightning-30b-a3b',
      texto: 'Resposta de teste para: "Quero a de chocolate"',
      tokens: { entrada: 55, saida: 8 },
    });
    expect(await pedidosRecebidos()).toEqual([
      {
        provedor: 'nvidia',
        modelo: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        sistema: 'Você atende a Pizzaria da Praça.',
        conversa: [
          { de: 'cliente', texto: 'Oi\nTem pizza doce?' },
          { de: 'atendente', texto: 'Tem sim!' },
          { de: 'cliente', texto: 'Quero a de chocolate' },
        ],
        anexo: null,
        temperatura: 0.2,
        // Sem isto, o modelo padrão gasta a resposta inteira raciocinando (a IA de mentira imita esse comportamento).
        semPensar: true,
        temAudio: false,
      },
    ]);
  });

  test('foto só vai para modelo que enxerga; o que só lê texto recusa com um motivo claro', async () => {
    await gerarResposta(naNvidia({ modelo: 'nvidia/nemotron-3.5-super-vl-120b-a12b', anexo: { tipo: 'image/png', dados: Buffer.alloc(512, 3) } }));
    expect((await pedidosRecebidos())[0]).toMatchObject({ conversa: [{ de: 'cliente', texto: 'Vocês entregam?' }], anexo: { tipo: 'image/png', bytes: 512 } });

    expect(await erroDe(gerarResposta(naNvidia({ anexo: { tipo: 'image/png', dados: Buffer.alloc(64, 3) } })))).toMatchObject({
      provedor: 'nvidia',
      motivo: 'nao_suportado',
      status: 400,
    });
  });

  test('áudio e documento NUNCA saem do painel para a NVIDIA (os modelos de lá descartam o áudio e inventam a resposta)', async () => {
    for (const tipo of ['audio/ogg; codecs=opus', 'audio/mpeg', 'application/pdf', 'video/mp4']) {
      for (const modelo of ['nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3.5-super-vl-120b-a12b']) {
        expect(await erroDe(gerarResposta(naNvidia({ modelo, anexo: { tipo, dados: Buffer.alloc(10) } }))), tipo).toMatchObject({ provedor: 'nvidia', motivo: 'nao_suportado' });
      }
    }
    expect(await pedidosRecebidos()).toHaveLength(0);
  });

  test('cada resposta de erro da NVIDIA vem num formato, e todas viram um motivo claro', async () => {
    // {status,title,detail}
    expect(await erroDe(gerarResposta(naNvidia({ chave: 'nvapi-chave-errada-0000000000000000' })))).toMatchObject({ motivo: 'chave_invalida', status: 403, message: 'Authorization failed' });
    expect(await erroDe(gerarResposta(naNvidia({ chave: '  ' })))).toMatchObject({ motivo: 'chave_invalida' });
    // Texto puro, sem JSON.
    const inexistente = await erroDe(gerarResposta(naNvidia({ modelo: 'fabricante/modelo-que-nao-existe' })));
    expect(inexistente).toMatchObject({ motivo: 'modelo_inexistente', status: 404 });
    expect(inexistente.message).toBe('Modelo "fabricante/modelo-que-nao-existe": 404 page not found');
    // Está na lista, mas não foi liberado para a conta.
    const naoLiberado = await erroDe(gerarResposta(naNvidia({ modelo: 'google/gemma-4-31b-it' })));
    expect(naoLiberado).toMatchObject({ motivo: 'modelo_inexistente', status: 404 });
    expect(naoLiberado.message).toContain('Not found for account');
    expect(await erroDe(gerarResposta(naNvidia({ chave: CHAVE_NVIDIA_NO_LIMITE })))).toMatchObject({ motivo: 'limite', status: 429 });

    for (const [falha, motivo] of [
      ['pane', 'indisponivel'],
      ['limite', 'limite'],
      ['bloqueio', 'bloqueada'],
      ['vazio', 'resposta_vazia'],
      ['queda', 'rede'],
    ] as const) {
      await controle('reiniciar');
      await controle(`falha?tipo=${falha}&vezes=1`);
      expect(await erroDe(gerarResposta(naNvidia())), falha).toMatchObject({ provedor: 'nvidia', motivo });
      // Uma chamada só: a segunda tentativa, se existisse, teria dado certo e apareceria aqui.
      expect(await pedidosRecebidos(), falha).toHaveLength(1);
    }
  });

  test('o raciocínio do modelo nunca vira resposta: se ele só pensou, é resposta vazia', async () => {
    await controle('falha?tipo=vazio&vezes=1&provedor=nvidia');
    const erro = await erroDe(gerarResposta(naNvidia()));
    expect(erro).toMatchObject({ motivo: 'resposta_vazia' });
    expect(erro.message).toMatch(/raciocinando/);
    expect(erro.message).not.toMatch(/thinking process/);
  });

  test('provedor que não responde: desiste no prazo e diz que foi o tempo', async () => {
    await controle('falha?tipo=silencio&vezes=1&provedor=nvidia');
    expect(await erroDe(gerarResposta(naNvidia({ tempoLimiteMs: 150 })))).toMatchObject({ provedor: 'nvidia', motivo: 'tempo' });
  });

  test('a chave nunca aparece na mensagem de erro', async () => {
    process.env.IENVIA_NVIDIA_URL = 'http://127.0.0.1:9/nvidia/v1';
    const erro = await erroDe(gerarResposta(naNvidia()));
    expect(erro.motivo).toBe('rede');
    expect(erro.message).not.toContain(CHAVE_NVIDIA_DE_TESTE);
  });
});

describe('teste de conexão e lista de modelos', () => {
  test('o teste de conexão faz uma pergunta mínima e recebe OK', async () => {
    expect(await testarConexao('gemini', CHAVE_GEMINI_DE_TESTE, 'gemini-3.5-flash-lite')).toMatchObject({ texto: 'OK', modelo: 'gemini-3.5-flash-lite' });
    expect(await testarConexao('openrouter', CHAVE_OPENROUTER_DE_TESTE, 'deepseek/deepseek-chat')).toMatchObject({ texto: 'OK' });
    expect(await testarConexao('nvidia', CHAVE_NVIDIA_DE_TESTE, 'nvidia/nemotron-3.5-lightning-30b-a3b')).toMatchObject({ texto: 'OK', provedor: 'nvidia' });
    expect(await erroDe(testarConexao('gemini', 'AIzaSy-errada-0000000000000000000000', 'gemini-3.5-flash-lite'))).toMatchObject({ motivo: 'chave_invalida' });
    expect(await erroDe(testarConexao('nvidia', 'nvapi-errada-0000000000000000000000', 'nvidia/nemotron-3.5-lightning-30b-a3b'))).toMatchObject({ motivo: 'chave_invalida' });

    const pedidos = await pedidosRecebidos();
    expect(pedidos).toHaveLength(3);
    expect(pedidos[0]).toMatchObject({ temperatura: 0, conversa: [{ de: 'cliente', texto: 'Teste de conexão.' }] });
  });

  test('Gemini: só os modelos de conversa que a chave enxerga (voz e os que não geram texto ficam de fora)', async () => {
    expect(await listarModelos('gemini', CHAVE_GEMINI_DE_TESTE)).toEqual([
      { id: 'gemini-2.0-flash', nome: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.5-flash', nome: 'Gemini 2.5 Flash' },
      { id: 'gemini-3.5-flash-lite', nome: 'Gemini 3.5 Flash-Lite' },
      { id: 'gemini-3.8-flash', nome: 'Gemini 3.8 Flash' },
      { id: 'gemini-4-argon', nome: 'Gemini 4 Argon' },
    ]);
    expect(await erroDe(listarModelos('gemini', 'AIzaSy-errada-0000000000000000000000'))).toMatchObject({ motivo: 'chave_invalida' });
    expect(await erroDe(listarModelos('gemini', null))).toMatchObject({ motivo: 'chave_invalida' });
  });

  test('OpenRouter: a lista é pública, diz quais são gratuitos e deixa de fora os que só geram imagem', async () => {
    const esperado = [
      { id: 'anthropic/claude-sonnet-5', nome: 'Anthropic: Claude Sonnet 5', gratuito: false },
      { id: 'deepseek/deepseek-chat', nome: 'DeepSeek: DeepSeek V3', gratuito: false },
      { id: 'google/gemma-4-26b-a4b-it:free', nome: 'Google: Gemma 4 26B (free)', gratuito: true },
    ];
    expect(await listarModelos('openrouter', null)).toEqual(esperado);
    expect(await listarModelos('openrouter', CHAVE_OPENROUTER_DE_TESTE)).toEqual(esperado);
  });

  describe('NVIDIA', () => {
    test('a lista é pública (a chave nem é enviada) e deixa de fora o que não é modelo de conversa', async () => {
      const esperado = [
        { id: 'google/gemma-4-31b-it', nome: 'google/gemma-4-31b-it' },
        { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', nome: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
        { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', nome: 'nvidia/nemotron-3.5-super-vl-120b-a12b' },
        { id: 'z-ai/glm-5.3-flash', nome: 'z-ai/glm-5.3-flash' },
      ];
      // Os de busca (embed), de filtro (content-safety), de leitura de documento (parse) e de programação (coder) saem.
      expect(await listarModelos('nvidia', null)).toEqual(esperado);
      expect(await listarModelos('nvidia', CHAVE_NVIDIA_DE_TESTE)).toEqual(esperado);
      // A lista não garante o uso: um modelo listado pode não estar liberado para a conta (só o teste de conexão diz).
      expect(await erroDe(testarConexao('nvidia', CHAVE_NVIDIA_DE_TESTE, 'google/gemma-4-31b-it'))).toMatchObject({ motivo: 'modelo_inexistente' });
    });
  });
});

describe('cuidados', () => {
  test('qualquer coisa com cara de chave sai do texto antes de ir para um registro', () => {
    expect(semChaves('falhou com AIzaSyD-abc_DEF0123456789 na chamada')).toBe('falhou com [chave] na chamada');
    expect(semChaves('Authorization: Bearer sk-or-v1-0123456789abcdef recusado')).toBe('Authorization: Bearer [chave] recusado');
    expect(semChaves('token Bearer abcDEF123456.xyz')).toBe('token Bearer [chave]');
    expect(semChaves('chave nvapi-AbC_123-xyz0123456789 recusada')).toBe('chave [chave] recusada');
    expect(semChaves('nada de mais aqui')).toBe('nada de mais aqui');
  });

  test('sem variável nenhuma, os endereços são os oficiais', () => {
    expect(enderecoDoProvedor('gemini', {})).toBe('https://generativelanguage.googleapis.com');
    expect(enderecoDoProvedor('openrouter', {})).toBe('https://openrouter.ai/api/v1');
    expect(enderecoDoProvedor('nvidia', {})).toBe('https://integrate.api.nvidia.com/v1');
    expect(enderecoDoProvedor('gemini', { IENVIA_GEMINI_URL: '   ' })).toBe('https://generativelanguage.googleapis.com');
    // A variável de um provedor não muda o endereço de outro.
    expect(enderecoDoProvedor('nvidia', { IENVIA_OPENROUTER_URL: 'http://127.0.0.1:1/x', IENVIA_GEMINI_URL: 'http://127.0.0.1:1/y' })).toBe('https://integrate.api.nvidia.com/v1');
  });

  test('o endereço só pode ser trocado por um desta mesma máquina (o dos testes); qualquer outro é ignorado', () => {
    expect(enderecoDoProvedor('gemini', { IENVIA_GEMINI_URL: ' http://127.0.0.1:1234// ' })).toBe('http://127.0.0.1:1234');
    expect(enderecoDoProvedor('openrouter', { IENVIA_OPENROUTER_URL: 'http://localhost:54397/openrouter/api/v1' })).toBe('http://localhost:54397/openrouter/api/v1');
    expect(enderecoDoProvedor('nvidia', { IENVIA_NVIDIA_URL: 'http://127.0.0.1:54397/nvidia/v1/' })).toBe('http://127.0.0.1:54397/nvidia/v1');
    // Uma configuração errada (ou mal-intencionada) não desvia a chave do cliente para outro servidor.
    for (const desvio of ['https://coletor.exemplo.com', 'http://127.0.0.1.exemplo.com', 'http://10.0.0.5:8080', 'ftp://127.0.0.1', 'isto não é endereço', '//localhost']) {
      expect(enderecoDoProvedor('gemini', { IENVIA_GEMINI_URL: desvio }), desvio).toBe('https://generativelanguage.googleapis.com');
      expect(enderecoDoProvedor('openrouter', { IENVIA_OPENROUTER_URL: desvio }), desvio).toBe('https://openrouter.ai/api/v1');
      expect(enderecoDoProvedor('nvidia', { IENVIA_NVIDIA_URL: desvio }), desvio).toBe('https://integrate.api.nvidia.com/v1');
    }
  });
});
