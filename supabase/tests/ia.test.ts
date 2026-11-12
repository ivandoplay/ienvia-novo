/**
 * Fase 2, primeira parte: o Motor de IA (configurações e chaves) e o Treinamento
 * (bases, perguntas frequentes e arquivos de conhecimento).
 *
 * O que estes testes garantem: só o dono altera; a equipe só lê; quem é de fora não vê nada;
 * uma empresa não enxerga a outra; e a chave de um provedor nunca fica em texto puro nem sai do banco
 * para quem não é o dono.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import { ATENDENTE_A, CHIP_A, CHIP_B, DONA_A, DONO_B, INTRUSO, LOJA_A, LOJA_B, MASTER, SUSPENSO_A, bancoComCenario } from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await bancoComCenario();
});

type Json = Record<string, unknown>;

/** Chama uma função do banco e devolve o JSON que ela respondeu. */
async function chamar<T = Json>(funcao: string, argumentos: unknown[]): Promise<T> {
  const marcadores = argumentos.map((_, indice) => `$${indice + 1}`).join(',');
  const { rows } = await banco.db.query<{ r: T }>(`select public.${funcao}(${marcadores}) as r`, argumentos);
  return rows[0]!.r;
}

/** Dentro de uma transação aberta por `comoUsuario`: passa a agir como outra pessoa logada. */
const passarA = (usuarioId: string) => banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [usuarioId]);

/** Dentro de uma transação aberta por `comoUsuario`: faz algo como administrador do banco e volta ao usuário. */
async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role authenticated');
  }
}

const recusa = (funcao: string, argumentos: unknown[]) => banco.esperarErro(() => chamar(funcao, argumentos));

async function auditoria(acao: string): Promise<Json[]> {
  const { rows } = await comoAdmin(() =>
    banco.db.query<{ details: Json }>('select details from private.audit_events where action = $1 order by id', [acao]),
  );
  return rows.map((linha) => linha.details);
}

/** Um texto com a forma do que o painel grava: versão, 12 bytes, 16 bytes e o conteúdo, tudo em base64url. */
const cifra = (final = 'conteudo') => `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${final.padEnd(8, 'x')}`;

const PADROES = {
  provider: 'gemini',
  fallback_provider: 'none',
  second_fallback_provider: 'none',
  gemini_model: 'gemini-3.5-flash-lite',
  openrouter_model: 'deepseek/deepseek-chat',
  nvidia_model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  temperature: 0.35,
  max_history_messages: 20,
  debounce_seconds: 6,
  simulate_typing: true,
  split_long_messages: true,
  pause_on_human_reply: true,
  human_pause_minutes: 60,
};

describe('Motor de IA: configurações', () => {
  test('quem ainda não gravou nada recebe os padrões, e eles são os mesmos da tabela', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const lido = await chamar('read_my_ai_settings', [LOJA_A]);
      expect(lido).toMatchObject({ ...PADROES, updated_at: null, keys: {}, can_edit: true });

      // Uma linha criada só com os padrões da tabela tem de dar exatamente o mesmo resultado.
      await comoAdmin(() => banco.db.query('insert into public.workspace_ai_settings (workspace_id) values ($1)', [LOJA_A]));
      const gravado = await chamar('read_my_ai_settings', [LOJA_A]);
      expect({ ...gravado, updated_at: null }).toEqual(lido);
    });
  });

  test('a dona grava só o que mudou; o resto fica como estava; a mudança vai para a auditoria', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const depois = await chamar('save_my_ai_settings', [LOJA_A, { provider: 'openrouter', temperature: 0.6, debounce_seconds: 10 }]);
      expect(depois).toMatchObject({ ...PADROES, provider: 'openrouter', temperature: 0.6, debounce_seconds: 10, can_edit: true });
      expect(depois.updated_at).not.toBeNull();

      const outra = await chamar('save_my_ai_settings', [LOJA_A, { simulate_typing: false, human_pause_minutes: 120 }]);
      expect(outra).toMatchObject({ provider: 'openrouter', temperature: 0.6, simulate_typing: false, human_pause_minutes: 120 });

      expect(await auditoria('ai_settings_updated')).toEqual([
        { changed: { provider: 'openrouter', temperature: 0.6, debounce_seconds: 10 } },
        { changed: { simulate_typing: false, human_pause_minutes: 120 } },
      ]);
    });
  });

  test('a atendente lê, mas não grava; ex-funcionário, quem é de fora e o administrador da plataforma não leem', async () => {
    await banco.comoUsuario(ATENDENTE_A, async () => {
      expect(await chamar('read_my_ai_settings', [LOJA_A])).toMatchObject({ provider: 'gemini', can_edit: false });
      expect(await recusa('save_my_ai_settings', [LOJA_A, { provider: 'openrouter' }])).toMatch(/Workspace owner required/);

      for (const pessoa of [SUSPENSO_A, INTRUSO, DONO_B, MASTER]) {
        await passarA(pessoa);
        expect(await recusa('read_my_ai_settings', [LOJA_A])).toMatch(/Workspace membership required/);
        expect(await recusa('save_my_ai_settings', [LOJA_A, { provider: 'openrouter' }])).toMatch(/Workspace owner required/);
      }
    });
  });

  test('valores fora do combinado são recusados, um por um', async () => {
    const invalidos: Array<[Json | null | string, RegExp]> = [
      [null, /Invalid settings/],
      ['texto', /Invalid settings/],
      [{ provedor: 'gemini' }, /Unknown setting: provedor/],
      [{ updated_at: '2020-01-01' }, /Unknown setting/],
      [{ provider: 'chatgpt' }, /Invalid provider/],
      [{ provider: 7 }, /Invalid provider/],
      [{ provider_mode: 'auto' }, /Unknown setting: provider_mode/],
      [{ fallback_provider: 'outro' }, /Invalid fallback_provider/],
      [{ second_fallback_provider: 'outro' }, /Invalid second_fallback_provider/],
      // A ordem não repete provedor, e não existe segunda reserva sem a primeira.
      [{ fallback_provider: 'gemini' }, /Invalid provider order/],
      [{ second_fallback_provider: 'nvidia' }, /Invalid provider order/],
      [{ fallback_provider: 'nvidia', second_fallback_provider: 'nvidia' }, /Invalid provider order/],
      [{ fallback_provider: 'nvidia', second_fallback_provider: 'gemini' }, /Invalid provider order/],
      [{ provider: 'nvidia', fallback_provider: 'nvidia' }, /Invalid provider order/],
      [{ gemini_model: '' }, /Invalid gemini_model/],
      [{ gemini_model: 'modelo com espaço' }, /Invalid gemini_model/],
      [{ openrouter_model: `a${'b'.repeat(120)}` }, /Invalid openrouter_model/],
      [{ nvidia_model: 'nvidia/modelo com espaço' }, /Invalid nvidia_model/],
      [{ nvidia_model: 7 }, /Invalid nvidia_model/],
      [{ temperature: 1.01 }, /Invalid temperature/],
      [{ temperature: -0.1 }, /Invalid temperature/],
      [{ temperature: '0.5' }, /Invalid temperature/],
      [{ max_history_messages: 3 }, /Invalid max_history_messages/],
      [{ max_history_messages: 61 }, /Invalid max_history_messages/],
      [{ max_history_messages: 10.5 }, /Invalid max_history_messages/],
      [{ debounce_seconds: 0 }, /Invalid debounce_seconds/],
      [{ debounce_seconds: 21 }, /Invalid debounce_seconds/],
      [{ debounce_seconds: 61 }, /Invalid debounce_seconds/],
      [{ human_pause_minutes: 4 }, /Invalid human_pause_minutes/],
      [{ human_pause_minutes: 1441 }, /Invalid human_pause_minutes/],
      [{ simulate_typing: 'sim' }, /Invalid simulate_typing/],
      [{ split_long_messages: 1 }, /Invalid split_long_messages/],
      [{ pause_on_human_reply: null }, /Invalid pause_on_human_reply/],
    ];
    await banco.comoUsuario(DONA_A, async () => {
      for (const [valor, mensagem] of invalidos) {
        expect(await recusa('save_my_ai_settings', [LOJA_A, valor === null ? null : JSON.stringify(valor)]), JSON.stringify(valor)).toMatch(mensagem);
      }
      // Nada foi gravado no caminho.
      expect(await chamar('read_my_ai_settings', [LOJA_A])).toMatchObject({ ...PADROES, updated_at: null });

      // E os limites exatos são aceitos.
      const nosLimites = { temperature: 1, max_history_messages: 60, debounce_seconds: 1, human_pause_minutes: 1440, gemini_model: 'google/gemma-4:free' };
      expect(await chamar('save_my_ai_settings', [LOJA_A, nosLimites])).toMatchObject(nosLimites);
      expect(await chamar('save_my_ai_settings', [LOJA_A, { temperature: 0, max_history_messages: 4, debounce_seconds: 20, human_pause_minutes: 5 }])).toMatchObject({
        temperature: 0,
        max_history_messages: 4,
        debounce_seconds: 20,
        human_pause_minutes: 5,
      });
    });
  });

  test('os três provedores entram na ordem de uso: principal, primeira reserva e segunda reserva', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const ordem = { provider: 'nvidia', fallback_provider: 'gemini', second_fallback_provider: 'openrouter', nvidia_model: 'z-ai/glm-5.3-flash' };
      expect(await chamar('save_my_ai_settings', [LOJA_A, ordem])).toMatchObject(ordem);

      // Trocar o principal por quem já era reserva só passa se a ordem inteira continuar sem repetição.
      expect(await recusa('save_my_ai_settings', [LOJA_A, { provider: 'gemini' }])).toMatch(/Invalid provider order/);
      const trocada = { provider: 'gemini', fallback_provider: 'nvidia', second_fallback_provider: 'none' };
      expect(await chamar('save_my_ai_settings', [LOJA_A, trocada])).toMatchObject({ ...trocada, nvidia_model: 'z-ai/glm-5.3-flash' });

      // A tabela também se protege sozinha, mesmo de quem escreve direto nela.
      expect(
        await comoAdmin(() => banco.esperarErro(() => banco.db.query("update public.workspace_ai_settings set fallback_provider = 'gemini' where workspace_id = $1", [LOJA_A]))),
      ).toMatch(/workspace_ai_settings_order_ck/);
      expect(
        await comoAdmin(() =>
          banco.esperarErro(() => banco.db.query("update public.workspace_ai_settings set fallback_provider = 'none', second_fallback_provider = 'openrouter' where workspace_id = $1", [LOJA_A])),
        ),
      ).toMatch(/workspace_ai_settings_order_ck/);
    });
  });

  test('cada empresa tem as suas configurações', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await chamar('save_my_ai_settings', [LOJA_A, { provider: 'openrouter' }]);
      expect(await recusa('save_my_ai_settings', [LOJA_B, { provider: 'openrouter' }])).toMatch(/Workspace owner required/);

      await passarA(DONO_B);
      expect(await chamar('read_my_ai_settings', [LOJA_B])).toMatchObject({ provider: 'gemini', updated_at: null });
      expect(await recusa('read_my_ai_settings', [LOJA_A])).toMatch(/Workspace membership required/);
    });
  });
});

describe('Motor de IA: chaves dos provedores', () => {
  test('a dona guarda a chave já cifrada; a tela fica sabendo que existe e mostra só o final', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const depois = await chamar<{ keys: Record<string, Json> }>('save_my_ai_key', [LOJA_A, 'gemini', cifra('primeira'), 'x9Zk']);
      expect(depois.keys).toMatchObject({ gemini: { configured: true, hint: 'x9Zk' } });
      expect(depois.keys.openrouter).toBeUndefined();

      expect(await chamar('read_my_ai_key_ciphertext', [LOJA_A, 'gemini'])).toBe(cifra('primeira'));
      expect(await chamar('read_my_ai_key_ciphertext', [LOJA_A, 'openrouter'])).toBeNull();

      // A auditoria registra qual provedor e o final da chave; nunca a chave.
      const registro = await auditoria('ai_key_saved');
      expect(registro).toEqual([{ provider: 'gemini', key_hint: 'x9Zk' }]);
      expect(JSON.stringify(registro)).not.toContain('primeira');
    });
  });

  test('trocar a chave substitui a anterior; apagar tira de vez', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await chamar('save_my_ai_key', [LOJA_A, 'openrouter', cifra('antiga'), 'aaaa']);
      const trocada = await chamar<{ keys: Record<string, Json> }>('save_my_ai_key', [LOJA_A, 'openrouter', cifra('novinha'), 'bbbb']);
      expect(trocada.keys.openrouter).toMatchObject({ configured: true, hint: 'bbbb' });
      expect(await chamar('read_my_ai_key_ciphertext', [LOJA_A, 'openrouter'])).toBe(cifra('novinha'));

      const apagada = await chamar<{ keys: Json }>('delete_my_ai_key', [LOJA_A, 'openrouter']);
      expect(apagada.keys).toEqual({});
      expect(await chamar('read_my_ai_key_ciphertext', [LOJA_A, 'openrouter'])).toBeNull();
      // Apagar o que já não existe não dá erro nem gera registro.
      await chamar('delete_my_ai_key', [LOJA_A, 'openrouter']);
      expect(await auditoria('ai_key_deleted')).toEqual([{ provider: 'openrouter' }]);
    });
  });

  test('texto puro nunca é gravado: só entra o que tem a forma de uma chave cifrada pelo painel', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      for (const valor of [null, '', 'AIzaSyChaveDeVerdadeEmTextoPuro0123456789', 'sk-or-v1-0123456789abcdef', 'v1.curto.curto.curto', `v2.${'A'.repeat(16)}.${'B'.repeat(22)}.conteudo`, cifra('com espaço')]) {
        expect(await recusa('save_my_ai_key', [LOJA_A, 'gemini', valor, 'abcd']), String(valor)).toMatch(/Invalid ciphertext/);
      }
      for (const final of [null, '', 'tem espaço', 'longodemais']) {
        expect(await recusa('save_my_ai_key', [LOJA_A, 'gemini', cifra(), final]), String(final)).toMatch(/Invalid key hint/);
      }
      expect(await recusa('save_my_ai_key', [LOJA_A, 'outro', cifra(), 'abcd'])).toMatch(/Invalid provider/);
      expect(await recusa('delete_my_ai_key', [LOJA_A, 'outro'])).toMatch(/Invalid provider/);
      expect((await chamar<{ keys: Json }>('read_my_ai_settings', [LOJA_A])).keys).toEqual({});

      // Os três provedores guardam chave, cada um a sua.
      for (const provedor of ['gemini', 'openrouter', 'nvidia']) {
        await chamar('save_my_ai_key', [LOJA_A, provedor, cifra(provedor), provedor.slice(0, 4)]);
        expect(await chamar('read_my_ai_key_ciphertext', [LOJA_A, provedor])).toBe(cifra(provedor));
      }
      expect((await chamar<{ keys: Json }>('read_my_ai_settings', [LOJA_A])).keys).toMatchObject({
        gemini: { configured: true, hint: 'gemi' },
        openrouter: { configured: true, hint: 'open' },
        nvidia: { configured: true, hint: 'nvid' },
      });
      await chamar('delete_my_ai_key', [LOJA_A, 'nvidia']);
      expect(Object.keys((await chamar<{ keys: Json }>('read_my_ai_settings', [LOJA_A])).keys).sort()).toEqual(['gemini', 'openrouter']);
    });
  });

  test('a atendente sabe que a chave existe, mas não vê o final, não lê o texto cifrado e não mexe', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await chamar('save_my_ai_key', [LOJA_A, 'gemini', cifra('segredo1'), 'x9Zk']);

      await passarA(ATENDENTE_A);
      const lido = await chamar<{ keys: Record<string, Json> }>('read_my_ai_settings', [LOJA_A]);
      expect(lido.keys.gemini).toMatchObject({ configured: true, hint: null });
      expect(await recusa('read_my_ai_key_ciphertext', [LOJA_A, 'gemini'])).toMatch(/Workspace owner required/);
      expect(await recusa('save_my_ai_key', [LOJA_A, 'gemini', cifra('invasora'), 'zzzz'])).toMatch(/Workspace owner required/);
      expect(await recusa('delete_my_ai_key', [LOJA_A, 'gemini'])).toMatch(/Workspace owner required/);
    });
  });

  test('a chave de uma empresa não aparece para ninguém de fora, nem para o administrador da plataforma', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await chamar('save_my_ai_key', [LOJA_A, 'gemini', cifra('segredo1'), 'x9Zk']);

      for (const pessoa of [DONO_B, INTRUSO, SUSPENSO_A, MASTER]) {
        await passarA(pessoa);
        expect(await recusa('read_my_ai_key_ciphertext', [LOJA_A, 'gemini'])).toMatch(/Workspace owner required/);
        expect(await recusa('read_my_ai_settings', [LOJA_A])).toMatch(/Workspace membership required/);
      }
      await passarA(DONO_B);
      expect((await chamar<{ keys: Json }>('read_my_ai_settings', [LOJA_B])).keys).toEqual({});
      expect(await chamar('read_my_ai_key_ciphertext', [LOJA_B, 'gemini'])).toBeNull();
    });
  });

  test('o navegador não lê nem escreve direto nas tabelas do Motor de IA; visitante não chama nada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(() => banco.db.query('select * from private.workspace_ai_secrets'))).toMatch(/permission denied/);
      expect(await banco.esperarErro(() => banco.db.query('select * from public.workspace_ai_settings'))).toMatch(/permission denied/);
      expect(
        await banco.esperarErro(() => banco.db.query("insert into public.workspace_ai_settings (workspace_id, provider) values ($1, 'openrouter')", [LOJA_A])),
      ).toMatch(/permission denied/);
    });
    await banco.comoAnonimo(async () => {
      for (const [funcao, argumentos] of [
        ['read_my_ai_settings', [LOJA_A]],
        ['save_my_ai_settings', [LOJA_A, {}]],
        ['save_my_ai_key', [LOJA_A, 'gemini', cifra(), 'abcd']],
        ['delete_my_ai_key', [LOJA_A, 'gemini']],
        ['read_my_ai_key_ciphertext', [LOJA_A, 'gemini']],
      ] as Array<[string, unknown[]]>) {
        expect(await recusa(funcao, argumentos), funcao).toMatch(/permission denied/);
      }
    });
  });
});

interface Base extends Json {
  id: string;
  label: string;
  is_default: boolean;
  faqs: Array<{ id: string; question: string; answer: string; source: string }>;
  documents: Array<{ id: string; title: string; char_count: number; content?: string }>;
}

interface Lista {
  can_edit: boolean;
  agents: Array<Json & { id: string; label: string; is_default: boolean; instances: Array<{ id: string; display_name: string }> }>;
}

const criarBase = (dados: Json = {}, workspace = LOJA_A) => chamar<Base>('save_my_ai_agent', [workspace, null, dados]);

describe('Treinamento: bases', () => {
  test('a primeira base da empresa nasce como a padrão, com o nome Principal e os campos vazios', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await chamar<Lista>('read_my_ai_agents', [LOJA_A])).toEqual({ can_edit: true, agents: [] });

      const base = await criarBase();
      expect(base).toMatchObject({
        label: 'Principal',
        is_default: true,
        business_name: '',
        niche: '',
        assistant_name: '',
        tone: 'consultivo',
        solo_identity: false,
        company_summary: '',
        commercial_terms: '',
        golden_rules: '',
        extra_instructions: '',
        lock_until_manual_resume: false,
        prompt_shield_enabled: true,
        robot_question_policy: 'handoff',
        faqs: [],
        documents: [],
        can_edit: true,
      });

      // O chip da loja não tem base própria: usa a padrão.
      const lista = await chamar<Lista>('read_my_ai_agents', [LOJA_A]);
      expect(lista.agents).toHaveLength(1);
      expect(lista.agents[0]).toMatchObject({ id: base.id, label: 'Principal', is_default: true, faq_count: 0, document_count: 0 });
      expect(lista.agents[0]!.instances).toEqual([{ id: CHIP_A, display_name: 'Chip da Loja A' }]);
      expect(await auditoria('ai_agent_created')).toEqual([{ fields: [], faq_count: null }]);
    });
  });

  test('a dona altera só o que mandou; os textos são guardados sem espaços nas pontas', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase({ business_name: '  Pizzaria da Praça  ', tone: 'descontraido' });
      expect(base).toMatchObject({ business_name: 'Pizzaria da Praça', tone: 'descontraido', assistant_name: '' });

      const depois = await chamar<Base>('save_my_ai_agent', [
        LOJA_A,
        base.id,
        { assistant_name: 'Bia', solo_identity: true, golden_rules: '- Nunca invente preço.\n- Seja breve.\n', robot_question_policy: 'disclose', prompt_shield_enabled: false },
      ]);
      expect(depois).toMatchObject({
        id: base.id,
        business_name: 'Pizzaria da Praça',
        tone: 'descontraido',
        assistant_name: 'Bia',
        solo_identity: true,
        golden_rules: '- Nunca invente preço.\n- Seja breve.',
        robot_question_policy: 'disclose',
        prompt_shield_enabled: false,
        lock_until_manual_resume: false,
      });
      expect(await chamar<Base>('read_my_ai_agent', [LOJA_A, base.id])).toMatchObject({ assistant_name: 'Bia', can_edit: true });
      expect(await auditoria('ai_agent_updated')).toEqual([
        { fields: ['assistant_name', 'golden_rules', 'prompt_shield_enabled', 'robot_question_policy', 'solo_identity'], faq_count: null },
      ]);
    });
  });

  test('perguntas frequentes: a lista enviada substitui a anterior, na ordem em que veio', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase({
        faqs: [
          { question: ' Vocês entregam? ', answer: 'Sim, na cidade toda.' },
          { question: 'Qual o horário?', answer: 'Das 18h às 23h.', source: 'template' },
        ],
      });
      expect(base.faqs.map(({ question, answer, source }) => ({ question, answer, source }))).toEqual([
        { question: 'Vocês entregam?', answer: 'Sim, na cidade toda.', source: 'manual' },
        { question: 'Qual o horário?', answer: 'Das 18h às 23h.', source: 'template' },
      ]);

      // Salvar outros campos não mexe na lista.
      expect((await chamar<Base>('save_my_ai_agent', [LOJA_A, base.id, { niche: 'Pizzaria' }])).faqs).toHaveLength(2);

      const trocada = await chamar<Base>('save_my_ai_agent', [
        LOJA_A,
        base.id,
        { faqs: [{ question: 'Aceita PIX?', answer: 'Aceita.', source: 'correction' }, { question: 'Qual o horário?', answer: 'Das 18h às 23h.', source: 'inventada' }] },
      ]);
      expect(trocada.faqs.map(({ question, source }) => ({ question, source }))).toEqual([
        { question: 'Aceita PIX?', source: 'correction' },
        { question: 'Qual o horário?', source: 'manual' },
      ]);
      expect((await chamar<Base>('save_my_ai_agent', [LOJA_A, base.id, { faqs: [] }])).faqs).toEqual([]);
      expect((await chamar<Lista>('read_my_ai_agents', [LOJA_A])).agents[0]).toMatchObject({ faq_count: 0 });
    });
  });

  test('o que não cabe ou não faz sentido é recusado, e nada fica gravado pela metade', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase({ business_name: 'Loja', faqs: [{ question: 'P', answer: 'R' }] });
      const invalidos: Array<[Json | null | string, RegExp]> = [
        [null, /Invalid agent data/],
        ['texto', /Invalid agent data/],
        [{ nome: 'x' }, /Unknown agent field: nome/],
        [{ is_default: true }, /Unknown agent field/],
        [{ label: '   ' }, /Invalid label/],
        [{ label: 'a'.repeat(61) }, /Invalid label/],
        [{ business_name: 'a'.repeat(121) }, /Invalid business_name/],
        [{ business_name: 12 }, /Invalid business_name/],
        [{ assistant_name: 'a'.repeat(61) }, /Invalid assistant_name/],
        [{ company_summary: 'a'.repeat(4001) }, /Invalid company_summary/],
        [{ commercial_terms: 'a'.repeat(4001) }, /Invalid commercial_terms/],
        [{ golden_rules: 'a'.repeat(8001) }, /Invalid golden_rules/],
        [{ extra_instructions: 'a'.repeat(4001) }, /Invalid extra_instructions/],
        [{ tone: 'bravo' }, /Invalid tone/],
        [{ solo_identity: 'sim' }, /Invalid solo_identity/],
        [{ lock_until_manual_resume: 1 }, /Invalid lock_until_manual_resume/],
        [{ robot_question_policy: 'negar' }, /Invalid robot_question_policy/],
        [{ faqs: 'lista' }, /Invalid faqs/],
        [{ faqs: ['solta'] }, /Invalid faqs/],
        [{ faqs: [{ question: 'Só a pergunta' }] }, /Invalid faqs/],
        [{ faqs: [{ question: '   ', answer: 'R' }] }, /Invalid faqs/],
        [{ faqs: [{ question: 'P', answer: 'a'.repeat(2001) }] }, /Invalid faqs/],
        [{ faqs: [{ question: 'a'.repeat(501), answer: 'R' }] }, /Invalid faqs/],
        [{ faqs: Array.from({ length: 101 }, (_, n) => ({ question: `P${n}`, answer: 'R' })) }, /Invalid faqs/],
        // Um campo bom junto com uma pergunta ruim: nenhum dos dois entra.
        [{ business_name: 'Outra', faqs: [{ question: 'Boa', answer: 'R' }, { question: '', answer: 'R' }] }, /Invalid faqs/],
      ];
      for (const [valor, mensagem] of invalidos) {
        expect(await recusa('save_my_ai_agent', [LOJA_A, base.id, valor === null ? null : JSON.stringify(valor)]), JSON.stringify(valor)?.slice(0, 80)).toMatch(mensagem);
      }
      const intacta = await chamar<Base>('read_my_ai_agent', [LOJA_A, base.id]);
      expect(intacta).toMatchObject({ business_name: 'Loja', label: 'Principal' });
      expect(intacta.faqs.map((faq) => faq.question)).toEqual(['P']);

      // Os limites exatos cabem.
      const cheia = await chamar<Base>('save_my_ai_agent', [
        LOJA_A,
        base.id,
        { golden_rules: 'a'.repeat(8000), company_summary: 'b'.repeat(4000), faqs: Array.from({ length: 100 }, (_, n) => ({ question: `P${n}`, answer: 'R' })) },
      ]);
      expect(cheia.faqs).toHaveLength(100);
      expect(await recusa('save_my_ai_agent', [LOJA_A, '99999999-9999-4999-8999-999999999999', { niche: 'x' }])).toMatch(/Agent not found/);
    });
  });

  test('outras bases precisam de nome; nome repetido é recusado; o máximo é 10 por empresa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const principal = await criarBase();
      expect(await recusa('save_my_ai_agent', [LOJA_A, null, {}])).toMatch(/Invalid label/);
      expect(await recusa('save_my_ai_agent', [LOJA_A, null, { label: 'PRINCIPAL' }])).toMatch(/agent_label_taken/);

      const suporte = await criarBase({ label: 'Suporte' });
      expect(suporte).toMatchObject({ label: 'Suporte', is_default: false });
      expect(await recusa('save_my_ai_agent', [LOJA_A, suporte.id, { label: 'principal' }])).toMatch(/agent_label_taken/);
      // Renomear para o próprio nome (ou mudar só as maiúsculas) é aceito.
      expect(await chamar<Base>('save_my_ai_agent', [LOJA_A, suporte.id, { label: 'SUPORTE' }])).toMatchObject({ label: 'SUPORTE' });

      for (let n = 3; n <= 10; n += 1) await criarBase({ label: `Base ${n}` });
      expect(await recusa('save_my_ai_agent', [LOJA_A, null, { label: 'Base 11' }])).toMatch(/agent_limit_reached/);

      const lista = await chamar<Lista>('read_my_ai_agents', [LOJA_A]);
      expect(lista.agents).toHaveLength(10);
      expect(lista.agents[0]).toMatchObject({ id: principal.id, is_default: true });
      expect(lista.agents.filter((base) => base.is_default)).toHaveLength(1);
    });
  });

  test('trocar a base padrão; a padrão não pode ser apagada; chip de base apagada volta para a padrão', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const principal = await criarBase();
      const suporte = await criarBase({ label: 'Suporte' });
      await comoAdmin(() => banco.db.query('update public.instances set ai_agent_id = $1 where id = $2', [suporte.id, CHIP_A]));

      let lista = await chamar<Lista>('read_my_ai_agents', [LOJA_A]);
      expect(lista.agents.map((base) => [base.label, base.instances.length])).toEqual([
        ['Principal', 0],
        ['Suporte', 1],
      ]);

      expect(await recusa('delete_my_ai_agent', [LOJA_A, principal.id])).toMatch(/default_agent_required/);
      lista = await chamar<Lista>('set_my_default_ai_agent', [LOJA_A, suporte.id]);
      expect(lista.agents.map((base) => [base.label, base.is_default])).toEqual([
        ['Suporte', true],
        ['Principal', false],
      ]);
      // Escolher de novo a que já é padrão não muda nada nem gera outro registro.
      await chamar('set_my_default_ai_agent', [LOJA_A, suporte.id]);
      expect(await auditoria('ai_agent_default_changed')).toHaveLength(1);

      // Volta a padrão para a Principal e apaga a Suporte: o chip passa a usar a padrão.
      await chamar('set_my_default_ai_agent', [LOJA_A, principal.id]);
      lista = await chamar<Lista>('delete_my_ai_agent', [LOJA_A, suporte.id]);
      expect(lista.agents.map((base) => [base.label, base.instances.length])).toEqual([['Principal', 1]]);
      const { rows } = await comoAdmin(() => banco.db.query<{ ai_agent_id: string | null }>('select ai_agent_id from public.instances where id = $1', [CHIP_A]));
      expect(rows[0]!.ai_agent_id).toBeNull();
      expect(await auditoria('ai_agent_deleted')).toEqual([{ label: 'Suporte' }]);

      expect(await recusa('delete_my_ai_agent', [LOJA_A, suporte.id])).toMatch(/Agent not found/);
      expect(await recusa('set_my_default_ai_agent', [LOJA_A, suporte.id])).toMatch(/Agent not found/);
    });
  });

  test('cada chip pode usar uma base; sem escolha, usa a padrão; só a dona escolhe', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await criarBase();
      const suporte = await criarBase({ label: 'Suporte' });
      const chipsDe = (lista: Lista) => lista.agents.map((base) => [base.label, base.instances.map((chip) => chip.display_name)]);

      // Sem escolha nenhuma, o chip aparece na base padrão.
      expect(chipsDe(await chamar<Lista>('read_my_ai_agents', [LOJA_A]))).toEqual([
        ['Principal', ['Chip da Loja A']],
        ['Suporte', []],
      ]);

      expect(chipsDe(await chamar<Lista>('set_my_instance_ai_agent', [LOJA_A, CHIP_A, suporte.id]))).toEqual([
        ['Principal', []],
        ['Suporte', ['Chip da Loja A']],
      ]);
      // Escolher de novo a mesma base não muda nada nem gera outro registro.
      await chamar('set_my_instance_ai_agent', [LOJA_A, CHIP_A, suporte.id]);
      expect(await auditoria('instance_ai_agent_changed')).toEqual([{ ai_agent_id: suporte.id, previous_ai_agent_id: null }]);

      // Sem base (vazio) = voltar a usar a padrão.
      expect(chipsDe(await chamar<Lista>('set_my_instance_ai_agent', [LOJA_A, CHIP_A, null]))).toEqual([
        ['Principal', ['Chip da Loja A']],
        ['Suporte', []],
      ]);
      expect(await auditoria('instance_ai_agent_changed')).toHaveLength(2);

      // Base que não existe, chip que não existe, chip de outra empresa e chip removido: recusados.
      expect(await recusa('set_my_instance_ai_agent', [LOJA_A, CHIP_A, '99999999-0000-4000-8000-000000000000'])).toMatch(/Agent not found/);
      expect(await recusa('set_my_instance_ai_agent', [LOJA_A, '99999999-0000-4000-8000-000000000000', suporte.id])).toMatch(/Instance not found/);
      expect(await recusa('set_my_instance_ai_agent', [LOJA_A, CHIP_B, suporte.id])).toMatch(/Instance not found/);
      await comoAdmin(() => banco.db.query("update public.instances set status = 'revoked' where id = $1", [CHIP_A]));
      expect(await recusa('set_my_instance_ai_agent', [LOJA_A, CHIP_A, suporte.id])).toMatch(/Instance not found/);
      await comoAdmin(() => banco.db.query("update public.instances set status = 'connected' where id = $1", [CHIP_A]));

      // A atendente não escolhe; o dono de outra empresa não usa a base alheia nem mexe no chip alheio.
      await passarA(ATENDENTE_A);
      expect(await recusa('set_my_instance_ai_agent', [LOJA_A, CHIP_A, suporte.id])).toMatch(/Workspace owner required/);
      await passarA(DONO_B);
      expect(await recusa('set_my_instance_ai_agent', [LOJA_A, CHIP_A, suporte.id])).toMatch(/Workspace owner required/);
      expect(await recusa('set_my_instance_ai_agent', [LOJA_B, CHIP_B, suporte.id])).toMatch(/Agent not found/);
      expect(await recusa('set_my_instance_ai_agent', [LOJA_B, CHIP_A, null])).toMatch(/Instance not found/);
      expect(await auditoria('instance_ai_agent_changed')).toHaveLength(2);
    });
  });

  test('a atendente lê o treinamento, mas não altera; quem é de fora não lê', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase({ business_name: 'Pizzaria da Praça', faqs: [{ question: 'P', answer: 'R' }] });
      const outra = await criarBase({ label: 'Outra' });

      await passarA(ATENDENTE_A);
      expect(await chamar<Lista>('read_my_ai_agents', [LOJA_A])).toMatchObject({ can_edit: false });
      expect(await chamar<Base>('read_my_ai_agent', [LOJA_A, base.id])).toMatchObject({ business_name: 'Pizzaria da Praça', can_edit: false });
      expect(await recusa('save_my_ai_agent', [LOJA_A, base.id, { niche: 'x' }])).toMatch(/Workspace owner required/);
      expect(await recusa('save_my_ai_agent', [LOJA_A, null, { label: 'Minha' }])).toMatch(/Workspace owner required/);
      expect(await recusa('set_my_default_ai_agent', [LOJA_A, outra.id])).toMatch(/Workspace owner required/);
      expect(await recusa('delete_my_ai_agent', [LOJA_A, outra.id])).toMatch(/Workspace owner required/);
      expect(await recusa('add_my_ai_agent_document', [LOJA_A, base.id, 'a.txt', 'conteúdo'])).toMatch(/Workspace owner required/);

      for (const pessoa of [SUSPENSO_A, INTRUSO, DONO_B, MASTER]) {
        await passarA(pessoa);
        expect(await recusa('read_my_ai_agents', [LOJA_A])).toMatch(/Workspace membership required/);
        expect(await recusa('read_my_ai_agent', [LOJA_A, base.id])).toMatch(/Workspace membership required/);
        expect(await recusa('save_my_ai_agent', [LOJA_A, base.id, { niche: 'x' }])).toMatch(/Workspace owner required/);
      }
    });
  });

  test('uma empresa não enxerga nem altera a base da outra, mesmo sabendo o identificador', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const daA = await criarBase({ business_name: 'Loja A' });
      await chamar('add_my_ai_agent_document', [LOJA_A, daA.id, 'precos.txt', 'Tabela secreta da Loja A']);

      await passarA(DONO_B);
      const daB = await criarBase({ business_name: 'Loja B' }, LOJA_B);
      expect((await chamar<Lista>('read_my_ai_agents', [LOJA_B])).agents.map((base) => base.id)).toEqual([daB.id]);
      // O dono da B, dentro da empresa DELE, tentando alcançar a base da A.
      expect(await recusa('read_my_ai_agent', [LOJA_B, daA.id])).toMatch(/Agent not found/);
      expect(await recusa('save_my_ai_agent', [LOJA_B, daA.id, { business_name: 'Invadida' }])).toMatch(/Agent not found/);
      expect(await recusa('set_my_default_ai_agent', [LOJA_B, daA.id])).toMatch(/Agent not found/);
      expect(await recusa('delete_my_ai_agent', [LOJA_B, daA.id])).toMatch(/Agent not found/);
      expect(await recusa('add_my_ai_agent_document', [LOJA_B, daA.id, 'a.txt', 'x'])).toMatch(/Agent not found/);
      const documentoDaA = (await comoAdmin(() => banco.db.query<{ id: string }>('select id from public.ai_agent_documents'))).rows[0]!.id;
      expect(await recusa('delete_my_ai_agent_document', [LOJA_B, documentoDaA])).toMatch(/Document not found/);

      await passarA(DONA_A);
      expect(await chamar<Base>('read_my_ai_agent', [LOJA_A, daA.id])).toMatchObject({ business_name: 'Loja A' });
      expect((await chamar<Base>('read_my_ai_agent', [LOJA_A, daA.id])).documents).toHaveLength(1);
    });
  });

  test('o navegador não lê nem escreve direto nas tabelas do treinamento; visitante não chama nada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      for (const tabela of ['ai_agents', 'ai_agent_faqs', 'ai_agent_documents']) {
        expect(await banco.esperarErro(() => banco.db.query(`select * from public.${tabela}`)), tabela).toMatch(/permission denied/);
        expect(await banco.esperarErro(() => banco.db.query(`delete from public.${tabela}`)), tabela).toMatch(/permission denied/);
      }
      expect(await banco.esperarErro(() => banco.db.query('update public.instances set ai_agent_id = null'))).toMatch(/permission denied/);
    });
    await banco.comoAnonimo(async () => {
      const id = '99999999-9999-4999-8999-999999999999';
      for (const [funcao, argumentos] of [
        ['read_my_ai_agents', [LOJA_A]],
        ['read_my_ai_agent', [LOJA_A, id, false]],
        ['save_my_ai_agent', [LOJA_A, null, {}]],
        ['set_my_default_ai_agent', [LOJA_A, id]],
        ['delete_my_ai_agent', [LOJA_A, id]],
        ['add_my_ai_agent_document', [LOJA_A, id, 'a.txt', 'x']],
        ['delete_my_ai_agent_document', [LOJA_A, id]],
        ['set_my_instance_ai_agent', [LOJA_A, id, id]],
      ] as Array<[string, unknown[]]>) {
        expect(await recusa(funcao, argumentos), funcao).toMatch(/permission denied/);
      }
    });
  });
});

describe('Treinamento: arquivos de conhecimento', () => {
  test('anexar um arquivo: aparece na base com o tamanho; o conteúdo só vem quando pedido', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase();
      const depois = await chamar<Base>('add_my_ai_agent_document', [LOJA_A, base.id, '  Tabela de preços.csv ', '\nPizza grande;59,90\nPizza média;45,00\n\n']);
      expect(depois.documents).toHaveLength(1);
      expect(depois.documents[0]).toMatchObject({ title: 'Tabela de preços.csv', char_count: 36 });
      expect(depois.documents[0]).not.toHaveProperty('content');

      const comConteudo = await chamar<Base>('read_my_ai_agent', [LOJA_A, base.id, true]);
      expect(comConteudo.documents[0]).toMatchObject({ content: 'Pizza grande;59,90\nPizza média;45,00' });
      expect((await chamar<Lista>('read_my_ai_agents', [LOJA_A])).agents[0]).toMatchObject({ document_count: 1 });
      expect(await auditoria('ai_document_added')).toMatchObject([{ title: 'Tabela de preços.csv', char_count: 36 }]);
      // O conteúdo do arquivo não vai para a auditoria.
      expect(JSON.stringify(await auditoria('ai_document_added'))).not.toContain('59,90');
    });
  });

  test('limites: arquivo vazio, 30 mil caracteres por arquivo, 10 arquivos e 120 mil caracteres por base', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase();
      expect(await recusa('add_my_ai_agent_document', [LOJA_A, base.id, 'vazio.txt', '   \n  '])).toMatch(/document_empty/);
      expect(await recusa('add_my_ai_agent_document', [LOJA_A, base.id, 'grande.txt', 'a'.repeat(30001)])).toMatch(/document_too_large/);
      expect(await recusa('add_my_ai_agent_document', [LOJA_A, base.id, '   ', 'conteúdo'])).toMatch(/Invalid title/);
      expect(await recusa('add_my_ai_agent_document', [LOJA_A, base.id, 'a'.repeat(161), 'conteúdo'])).toMatch(/Invalid title/);
      expect(await recusa('add_my_ai_agent_document', [LOJA_A, '99999999-9999-4999-8999-999999999999', 'a.txt', 'conteúdo'])).toMatch(/Agent not found/);

      // Quatro arquivos no tamanho máximo ocupam os 120 mil caracteres.
      for (let n = 1; n <= 4; n += 1) await chamar('add_my_ai_agent_document', [LOJA_A, base.id, `cheio-${n}.txt`, 'a'.repeat(30000)]);
      expect(await recusa('add_my_ai_agent_document', [LOJA_A, base.id, 'mais-um.txt', 'a'])).toMatch(/document_space_exceeded/);

      // Outra base da mesma empresa tem o próprio espaço. Dez arquivos pequenos enchem a lista.
      const outra = await criarBase({ label: 'Outra' });
      for (let n = 1; n <= 10; n += 1) await chamar('add_my_ai_agent_document', [LOJA_A, outra.id, `pequeno-${n}.txt`, 'conteúdo']);
      expect(await recusa('add_my_ai_agent_document', [LOJA_A, outra.id, 'o-11.txt', 'conteúdo'])).toMatch(/document_limit_reached/);
      expect((await chamar<Base>('read_my_ai_agent', [LOJA_A, outra.id])).documents).toHaveLength(10);
    });
  });

  test('apagar um arquivo libera o espaço; apagar a base leva junto as perguntas e os arquivos', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await criarBase();
      const base = await criarBase({ label: 'Temporária', faqs: [{ question: 'P', answer: 'R' }] });
      const comDois = await chamar<Base>('add_my_ai_agent_document', [LOJA_A, base.id, 'um.txt', 'um']).then(() =>
        chamar<Base>('add_my_ai_agent_document', [LOJA_A, base.id, 'dois.txt', 'dois']),
      );
      // Os dois nasceram no mesmo instante (mesma transação do teste): a ordem entre eles não é garantida aqui.
      expect(comDois.documents.map((documento) => documento.title).sort()).toEqual(['dois.txt', 'um.txt']);
      const primeiro = comDois.documents.find((documento) => documento.title === 'um.txt')!;

      const depois = await chamar<Base>('delete_my_ai_agent_document', [LOJA_A, primeiro.id]);
      expect(depois.documents.map((documento) => documento.title)).toEqual(['dois.txt']);
      expect(await recusa('delete_my_ai_agent_document', [LOJA_A, primeiro.id])).toMatch(/Document not found/);
      expect(await auditoria('ai_document_deleted')).toMatchObject([{ title: 'um.txt' }]);

      await chamar('delete_my_ai_agent', [LOJA_A, base.id]);
      const sobras = await comoAdmin(() =>
        banco.db.query<{ perguntas: number; arquivos: number }>(
          `select (select count(*)::int from public.ai_agent_faqs where agent_id = $1) as perguntas,
                  (select count(*)::int from public.ai_agent_documents where agent_id = $1) as arquivos`,
          [base.id],
        ),
      );
      expect(sobras.rows[0]).toEqual({ perguntas: 0, arquivos: 0 });
    });
  });
});
