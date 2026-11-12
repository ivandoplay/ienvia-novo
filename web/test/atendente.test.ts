/**
 * O atendente de IA e o tempo: cada pedido tem um prazo para esperar o cliente, pedir a resposta e enviar.
 * Aqui o banco é um roteiro (responde o que o teste manda) e o relógio é do teste; o caminho inteiro, com o
 * banco de verdade, está em web/test-com-banco/atendente.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { atenderSobras, atenderVez, orcamentoDoAtendente, type Ambiente } from '@/lib/atendente/atendente';
import { cifrar, contextoDaChaveDeIa } from '@/lib/ia/cofre';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const VEZ = '22222222-2222-4222-8222-222222222222';
const GATILHO = '33333333-3333-4333-8333-333333333333';
const SEGREDO = 'ab'.repeat(32);

type Json = Record<string, unknown>;
interface Chamada {
  funcao: string;
  parametros: Json;
}

/** Um "banco" que responde o que o roteiro manda e anota cada chamada. */
function bancoDeRoteiro(roteiro: Record<string, Array<Json | Error> | ((parametros: Json) => Json | Error)>) {
  const chamadas: Chamada[] = [];
  const supabase = {
    rpc: async (funcao: string, parametros: Json) => {
      chamadas.push({ funcao, parametros });
      const passo = roteiro[funcao];
      const resposta = typeof passo === 'function' ? passo(parametros) : (passo?.shift() ?? new Error(`sem roteiro para ${funcao}`));
      if (resposta instanceof Error) return { data: null, error: { code: 'XX000', message: resposta.message } };
      return { data: resposta, error: null };
    },
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'sem depósito no roteiro' } }) }) },
  } as unknown as SupabaseClient;
  return { supabase, chamadas, nomes: () => chamadas.map((chamada) => chamada.funcao) };
}

/** Um relógio que só anda quando alguém "dorme". */
function relogio(inicio = 1_000_000) {
  let agora = inicio;
  const sonos: number[] = [];
  return {
    agora: () => agora,
    dormir: async (ms: number) => {
      sonos.push(ms);
      agora += ms;
    },
    adiantar: (ms: number) => {
      agora += ms;
    },
    sonos,
    inicio,
  };
}

function ambienteCom(banco: ReturnType<typeof bancoDeRoteiro>, tempo: ReturnType<typeof relogio>, orcamento = 55_000): Ambiente {
  return { supabase: banco.supabase, prazo: tempo.inicio + orcamento, dormir: tempo.dormir, agora: tempo.agora, sorteio: () => 0.5 };
}

const pedido = (esperaMs = 6_000) => ({ workspaceId: EMPRESA, vezId: VEZ, gatilhoId: GATILHO, esperaMs });

/** O pacote que o banco entrega junto com a vez. */
function pacote(mudancas: Json = {}): Json {
  return {
    result: 'claimed',
    turn: { id: VEZ, conversation_id: 'c', trigger_message_id: GATILHO },
    settings: { provider: 'nvidia', fallback_provider: 'none', second_fallback_provider: 'none' },
    keys: { nvidia: cifrar('nvapi-chave-de-teste-0001', contextoDaChaveDeIa(EMPRESA, 'nvidia'), Buffer.from(SEGREDO, 'hex')) },
    agent: { id: 'a', label: 'Principal', is_default: true, business_name: 'Loja', faqs: [], documents: [] },
    conversation: { id: 'c', contact_name: 'Maria', recipient: '5585999990000@s.whatsapp.net', provider_instance_name: 'ienvia-teste' },
    messages: [{ id: 'm1', direction: 'inbound', actor_type: 'contact', status: 'received', body_text: 'Oi', attachment: null }],
    ...mudancas,
  };
}

beforeEach(() => {
  vi.stubEnv('IENVIA_CHAVE_DOS_SEGREDOS', SEGREDO);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('o tempo total de um pedido', () => {
  test('55 segundos por padrão; um servidor sem limite pode aumentar', () => {
    expect(orcamentoDoAtendente({})).toBe(55_000);
    expect(orcamentoDoAtendente({ IENVIA_ATENDENTE_ORCAMENTO_MS: '120000' })).toBe(120_000);
    expect(orcamentoDoAtendente({ IENVIA_ATENDENTE_ORCAMENTO_MS: '600000' })).toBe(600_000);
    // Valor sem sentido (curto demais para responder, grande demais, ou que não é número): vale o padrão.
    for (const valor of ['5000', '900000', 'muito', '', '-1']) expect(orcamentoDoAtendente({ IENVIA_ATENDENTE_ORCAMENTO_MS: valor })).toBe(55_000);
  });
});

describe('pegar a vez', () => {
  test('espera o cliente terminar de escrever antes de perguntar ao banco', async () => {
    const banco = bancoDeRoteiro({ claim_ai_turn: [{ result: 'superseded' }] });
    const tempo = relogio();
    expect(await atenderVez(ambienteCom(banco, tempo), pedido(6_000))).toEqual({ desfecho: 'nada', motivo: 'superseded' });
    expect(tempo.sonos).toEqual([6_000]);
    expect(banco.chamadas).toEqual([{ funcao: 'claim_ai_turn', parametros: { p_workspace_id: EMPRESA, p_turn_id: VEZ, p_trigger_message_id: GATILHO } }]);
  });

  test('sem tempo para esperar e ainda responder, nem começa: a vez fica marcada para o próximo aviso', async () => {
    const banco = bancoDeRoteiro({});
    const tempo = relogio();
    // 20 s de espera num pedido que só tem 30 s: não sobraria o mínimo para responder e enviar.
    expect(await atenderVez(ambienteCom(banco, tempo, 30_000), pedido(20_000))).toEqual({ desfecho: 'nada', motivo: 'sem_tempo' });
    expect(tempo.sonos).toEqual([]);
    expect(banco.chamadas).toEqual([]);
  });

  test('o relógio do banco manda: se ele diz que ainda é cedo, espera o que falta e tenta de novo', async () => {
    const banco = bancoDeRoteiro({ claim_ai_turn: [{ result: 'early', wait_ms: 1_200 }, { result: 'gone', status: 'skipped' }] });
    const tempo = relogio();
    expect(await atenderVez(ambienteCom(banco, tempo), pedido(6_000))).toEqual({ desfecho: 'nada', motivo: 'gone' });
    expect(tempo.sonos).toEqual([6_000, 1_250]);
    expect(banco.nomes()).toEqual(['claim_ai_turn', 'claim_ai_turn']);
  });

  test('enquanto outra resposta da mesma conversa ainda está saindo, espera; se o tempo acabar, desiste sem responder', async () => {
    const banco = bancoDeRoteiro({ claim_ai_turn: () => ({ result: 'busy' }) });
    const tempo = relogio();
    expect(await atenderVez(ambienteCom(banco, tempo, 30_000), pedido(2_000))).toEqual({ desfecho: 'nada', motivo: 'sem_tempo' });
    // 2 s de espera + tentativas a cada 1,5 s, até não sobrar o mínimo para responder (14 s).
    expect(tempo.sonos[0]).toBe(2_000);
    expect(tempo.sonos.slice(1).every((sono) => sono === 1_500)).toBe(true);
    expect(tempo.agora() - tempo.inicio).toBeLessThanOrEqual(30_000 - 14_000);
    expect(banco.nomes().every((nome) => nome === 'claim_ai_turn')).toBe(true);
  });

  test('a IA não pode mais responder (pausada, desligada, uma pessoa assumiu): o pedido termina sem fazer nada', async () => {
    const banco = bancoDeRoteiro({ claim_ai_turn: [{ result: 'skipped', reason: 'workspace_paused' }] });
    expect(await atenderVez(ambienteCom(banco, relogio()), pedido())).toEqual({ desfecho: 'nada', motivo: 'skipped:workspace_paused' });
  });

  test('banco fora do ar na hora de pegar a vez: nada é respondido', async () => {
    const banco = bancoDeRoteiro({ claim_ai_turn: [new Error('connection refused')] });
    expect(await atenderVez(ambienteCom(banco, relogio()), pedido())).toEqual({ desfecho: 'nada', motivo: 'banco_indisponivel' });
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });
});

describe('com a vez na mão, o prazo continua valendo', () => {
  test('se não sobra tempo para o provedor responder, a IA nem pergunta: a conversa vai para uma pessoa', async () => {
    const tempo = relogio();
    const banco = bancoDeRoteiro({
      claim_ai_turn: () => {
        // Pegar a vez demorou (banco lento): sobram 12 s, menos que o mínimo para pedir a resposta e ainda enviar.
        tempo.adiantar(37_000);
        return pacote();
      },
      finish_ai_turn: [{ result: 'finished', status: 'failed' }],
    });
    expect(await atenderVez(ambienteCom(banco, tempo), pedido(6_000))).toEqual({ desfecho: 'falhou', motivo: 'no_time' });
    expect(banco.nomes()).toEqual(['claim_ai_turn', 'finish_ai_turn']);
    expect(banco.chamadas[1]!.parametros).toMatchObject({
      p_turn_id: VEZ,
      p_outcome: 'failed',
      p_detail: 'no_time',
      p_note: 'Não deu tempo de pedir a resposta ao provedor.',
      p_meta: { attempts: [] },
    });
  });

  test('sem o segredo que abre as chaves, nada é pedido ao provedor e a pessoa fica sabendo', async () => {
    vi.stubEnv('IENVIA_CHAVE_DOS_SEGREDOS', '');
    const banco = bancoDeRoteiro({ claim_ai_turn: [pacote()], finish_ai_turn: [{ result: 'finished' }] });
    expect(await atenderVez(ambienteCom(banco, relogio()), pedido())).toEqual({ desfecho: 'falhou', motivo: 'no_vault' });
    expect(banco.chamadas[1]!.parametros).toMatchObject({ p_outcome: 'failed', p_note: 'O painel está sem o segredo que protege as chaves de IA neste ambiente. Avise o suporte.' });
  });

  test('alguém já respondeu depois da mensagem que marcou a vez: não há o que responder', async () => {
    const banco = bancoDeRoteiro({
      claim_ai_turn: [
        pacote({
          messages: [
            { id: 'm1', direction: 'inbound', actor_type: 'contact', status: 'received', body_text: 'Oi', attachment: null },
            { id: 'm2', direction: 'outbound', actor_type: 'human', status: 'sent', body_text: 'Olá!', attachment: null },
          ],
        }),
      ],
      finish_ai_turn: [{ result: 'finished' }],
    });
    expect(await atenderVez(ambienteCom(banco, relogio()), pedido())).toEqual({ desfecho: 'silencio' });
    expect(banco.chamadas[1]!.parametros).toMatchObject({ p_outcome: 'silent', p_detail: 'nothing_pending' });
  });

  test('um erro inesperado no meio vira "a IA não conseguiu responder", nunca um pedido que morre calado', async () => {
    const banco = bancoDeRoteiro({
      // O pacote vem quebrado de um jeito que o código não espera.
      claim_ai_turn: [{ ...pacote(), messages: [{ id: 'm1', direction: 'inbound', body_text: 'Oi', attachment: null }], agent: { id: 'a', faqs: 'isto não é uma lista' } }],
      start_ai_message: [new Error('o banco caiu')],
      finish_ai_turn: [{ result: 'finished' }],
    });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Oi! Como posso ajudar?' }, finish_reason: 'stop' }], model: 'x', usage: {} }), { status: 200 }));
    expect(await atenderVez(ambienteCom(banco, relogio()), pedido())).toEqual({ desfecho: 'falhou', motivo: 'erro_inesperado' });
    expect(banco.chamadas.at(-1)).toMatchObject({
      funcao: 'finish_ai_turn',
      parametros: { p_outcome: 'failed', p_detail: 'unexpected_error', p_note: 'Houve um problema do nosso lado. Confira a conversa antes de responder.' },
    });
    vi.unstubAllGlobals();
  });
});

describe('o que ficou para trás', () => {
  test('pede a varredura ao banco e responde as vezes sem dono, sem esperar de novo', async () => {
    const banco = bancoDeRoteiro({
      sweep_ai_turns: [{ reaped: 1, orphans: [{ turn_id: VEZ, trigger_message_id: GATILHO }, { sem: 'identificador' }] }],
      claim_ai_turn: [{ result: 'gone', status: 'answered' }],
    });
    const tempo = relogio();
    expect(await atenderSobras(ambienteCom(banco, tempo), EMPRESA)).toEqual([{ desfecho: 'nada', motivo: 'gone' }]);
    expect(tempo.sonos).toEqual([]);
    // A vez sem dono é pega sem dizer de qual mensagem veio o pedido.
    expect(banco.chamadas[1]).toEqual({ funcao: 'claim_ai_turn', parametros: { p_workspace_id: EMPRESA, p_turn_id: VEZ, p_trigger_message_id: null } });
  });

  test('se a varredura falha, o pedido segue a vida', async () => {
    const banco = bancoDeRoteiro({ sweep_ai_turns: [new Error('fora do ar')] });
    expect(await atenderSobras(ambienteCom(banco, relogio()), EMPRESA)).toEqual([]);
  });
});
