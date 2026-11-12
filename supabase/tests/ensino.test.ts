/**
 * Fase 2, terceira parte: ensinar a IA sem sair da conversa ("corrigir resposta em 1 clique")
 * e a revisão das bases de treinamento.
 *
 * O que estes testes garantem: só o dono ensina; o que é ensinado vai para a base que o chip da
 * conversa usa; a mesma pergunta não entra duas vezes; os limites valem; e uma gravação feita com
 * a tela desatualizada é recusada, em vez de apagar o que foi ensinado depois.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import { ATENDENTE_A, CHIP_A, DONA_A, DONO_B, INTRUSO, LOJA_A, LOJA_B, MASTER, SUSPENSO_A, bancoComCenario } from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await bancoComCenario();
});

type Json = Record<string, unknown>;

interface Pergunta {
  id: string;
  question: string;
  answer: string;
  source: string;
}
interface Base {
  id: string;
  label: string;
  is_default: boolean;
  golden_rules: string;
  revision: number;
  faqs: Pergunta[];
}
interface Ensino {
  agent_id: string;
  agent_label: string;
  target: string;
  result: string;
  revision: number;
}

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

/** A mensagem que o cenário pôs na conversa de cada loja (veio do contato). */
async function mensagemDa(loja: string): Promise<string> {
  const { rows } = await comoAdmin(() =>
    banco.db.query<{ id: string }>('select id from public.messages where workspace_id = $1 order by created_at, id limit 1', [loja]),
  );
  return rows[0]!.id;
}

const criarBase = (dados: Json = {}, workspace = LOJA_A) => chamar<Base>('save_my_ai_agent', [workspace, null, dados]);
const gravarBase = (id: string, dados: Json, workspace = LOJA_A) => chamar<Base>('save_my_ai_agent', [workspace, id, dados]);
const lerBase = (id: string, workspace = LOJA_A) => chamar<Base>('read_my_ai_agent', [workspace, id, false]);
const ensinar = (mensagem: string, destino: string | null, pergunta: string | null, resposta: string | null, workspace = LOJA_A) =>
  chamar<Ensino>('teach_my_ai_from_message', [workspace, mensagem, destino, pergunta, resposta]);
const recusaAoEnsinar = (mensagem: string, destino: string | null, pergunta: string | null, resposta: string | null, workspace = LOJA_A) =>
  recusa('teach_my_ai_from_message', [workspace, mensagem, destino, pergunta, resposta]);

const resumo = (base: Base) => base.faqs.map((item) => [item.question, item.answer, item.source]);

describe('Ensinar a IA pela conversa: perguntas frequentes', () => {
  test('a dona ensina uma pergunta: entra em primeiro lugar, marcada como correção, e a revisão da base sobe', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase({
        faqs: [
          { question: 'Vocês entregam?', answer: 'Sim, na cidade toda.' },
          { question: 'Aceitam pix?', answer: 'Sim.', source: 'template' },
        ],
      });
      expect(base.revision).toBe(1);

      const ensino = await ensinar(mensagem, 'faq', '  Qual o horário?\n', '\tDas 8h às 18h, de segunda a sábado.  ');
      expect(ensino).toEqual({ agent_id: base.id, agent_label: 'Principal', target: 'faq', result: 'added', revision: 2 });

      const depois = await lerBase(base.id);
      expect(depois.revision).toBe(2);
      // Guardada sem os espaços das pontas, no topo; as outras ficam como estavam (ordem e origem).
      expect(resumo(depois)).toEqual([
        ['Qual o horário?', 'Das 8h às 18h, de segunda a sábado.', 'correction'],
        ['Vocês entregam?', 'Sim, na cidade toda.', 'manual'],
        ['Aceitam pix?', 'Sim.', 'template'],
      ]);

      // As posições ficam em sequência, sem buraco nem empate.
      const posicoes = await comoAdmin(() =>
        banco.db.query<{ position: number }>('select position from public.ai_agent_faqs where agent_id = $1 order by position, id', [base.id]),
      );
      expect(posicoes.rows.map((linha) => linha.position)).toEqual([0, 1, 2]);

      // A auditoria diz o que foi feito e a partir de qual mensagem, sem guardar o texto ensinado.
      expect(await auditoria('ai_agent_taught')).toEqual([{ target: 'faq', result: 'added', message_id: mensagem, message_actor: 'contact' }]);
    });
  });

  test('a mesma pergunta de novo (mesmo com outras maiúsculas) troca a resposta, sem duplicar, e volta para o topo', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase({
        faqs: [
          { question: 'Vocês entregam?', answer: 'Sim.' },
          { question: 'Qual o horário?', answer: 'Das 9h às 17h.' },
        ],
      });

      const ensino = await ensinar(mensagem, 'faq', 'QUAL O HORÁRIO?', 'Das 8h às 18h.');
      expect(ensino).toMatchObject({ result: 'replaced', revision: 2 });
      expect(resumo(await lerBase(base.id))).toEqual([
        ['QUAL O HORÁRIO?', 'Das 8h às 18h.', 'correction'],
        ['Vocês entregam?', 'Sim.', 'manual'],
      ]);

      // Ensinar outra pergunta e depois a primeira de novo: continuam sendo só três.
      await ensinar(mensagem, 'faq', 'Tem estacionamento?', 'Tem, na rua de trás.');
      await ensinar(mensagem, 'faq', 'vocês entregam?', 'Sim, com taxa de R$ 7.');
      expect(resumo(await lerBase(base.id))).toEqual([
        ['vocês entregam?', 'Sim, com taxa de R$ 7.', 'correction'],
        ['Tem estacionamento?', 'Tem, na rua de trás.', 'correction'],
        ['QUAL O HORÁRIO?', 'Das 8h às 18h.', 'correction'],
      ]);
      expect((await lerBase(base.id)).revision).toBe(4);
    });
  });

  test('cabem 100 perguntas por base: a 101ª é recusada; trocar a resposta de uma que já existe continua valendo', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase({ faqs: Array.from({ length: 100 }, (_, n) => ({ question: `Pergunta ${n + 1}`, answer: `Resposta ${n + 1}` })) });

      expect(await recusaAoEnsinar(mensagem, 'faq', 'Uma pergunta a mais', 'Não cabe.')).toMatch(/faq_limit_reached/);
      expect((await lerBase(base.id)).faqs).toHaveLength(100);
      expect((await lerBase(base.id)).revision).toBe(1);

      expect(await ensinar(mensagem, 'faq', 'pergunta 57', 'Resposta nova.')).toMatchObject({ result: 'replaced' });
      const depois = await lerBase(base.id);
      expect(depois.faqs).toHaveLength(100);
      expect(resumo(depois)[0]).toEqual(['pergunta 57', 'Resposta nova.', 'correction']);
      expect(resumo(depois)[1]).toEqual(['Pergunta 1', 'Resposta 1', 'manual']);
    });
  });

  test('o que não cabe ou não faz sentido é recusado, e nada muda', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase();

      expect(await recusaAoEnsinar(mensagem, 'faq', '   ', 'Resposta.')).toMatch(/Invalid question/);
      expect(await recusaAoEnsinar(mensagem, 'faq', null, 'Resposta.')).toMatch(/Invalid question/);
      expect(await recusaAoEnsinar(mensagem, 'faq', 'p'.repeat(501), 'Resposta.')).toMatch(/Invalid question/);
      expect(await recusaAoEnsinar(mensagem, 'faq', 'Pergunta?', ' \n ')).toMatch(/Invalid answer/);
      expect(await recusaAoEnsinar(mensagem, 'faq', 'Pergunta?', null)).toMatch(/Invalid answer/);
      expect(await recusaAoEnsinar(mensagem, 'faq', 'Pergunta?', 'r'.repeat(2001))).toMatch(/Invalid answer/);
      expect(await recusaAoEnsinar(mensagem, 'documento', 'Pergunta?', 'Resposta.')).toMatch(/Invalid target/);
      expect(await recusaAoEnsinar(mensagem, null, 'Pergunta?', 'Resposta.')).toMatch(/Invalid target/);

      // No limite exato, entra.
      await ensinar(mensagem, 'faq', 'p'.repeat(500), 'r'.repeat(2000));
      const depois = await lerBase(base.id);
      expect(depois.faqs).toHaveLength(1);
      expect(depois.revision).toBe(2);
      expect(await auditoria('ai_agent_taught')).toHaveLength(1);
    });
  });
});

describe('Ensinar a IA pela conversa: regras de ouro', () => {
  test('a dona ensina uma regra: entra como uma linha nova com hífen; quebra de linha dentro da regra vira espaço', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase({ golden_rules: 'Nunca prometa prazo de entrega.' });

      // A pergunta não é usada quando o destino são as regras.
      const ensino = await ensinar(mensagem, 'rule', null, '  Sempre confirme\n  o endereço antes de fechar o pedido. ');
      expect(ensino).toEqual({ agent_id: base.id, agent_label: 'Principal', target: 'rule', result: 'added', revision: 2 });

      const depois = await lerBase(base.id);
      expect(depois.golden_rules).toBe('Nunca prometa prazo de entrega.\n- Sempre confirme o endereço antes de fechar o pedido.');
      expect(depois.faqs).toEqual([]);
      expect(await auditoria('ai_agent_taught')).toEqual([{ target: 'rule', result: 'added', message_id: mensagem, message_actor: 'contact' }]);
    });
  });

  test('numa base sem regras, a regra ensinada é a primeira linha', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase();
      await ensinar(await mensagemDa(LOJA_A), 'rule', 'ignorada', 'Não ofereça desconto.');
      expect((await lerBase(base.id)).golden_rules).toBe('- Não ofereça desconto.');
    });
  });

  test('a mesma regra duas vezes não repete: nada muda, a revisão não sobe e nada vai para a auditoria', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase();
      await ensinar(mensagem, 'rule', null, 'Não ofereça desconto.');

      const repetida = await ensinar(mensagem, 'rule', null, 'NÃO OFEREÇA   desconto.');
      expect(repetida).toEqual({ agent_id: base.id, agent_label: 'Principal', target: 'rule', result: 'unchanged', revision: 2 });

      const depois = await lerBase(base.id);
      expect(depois.golden_rules).toBe('- Não ofereça desconto.');
      expect(depois.revision).toBe(2);
      expect(await auditoria('ai_agent_taught')).toHaveLength(1);
    });
  });

  test('limites: uma regra tem até 1.000 caracteres, e as regras da base, até 8.000', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase({ golden_rules: 'x'.repeat(7990) });

      expect(await recusaAoEnsinar(mensagem, 'rule', null, 'r'.repeat(1001))).toMatch(/Invalid answer/);
      expect(await recusaAoEnsinar(mensagem, 'rule', null, '   ')).toMatch(/Invalid answer/);
      // 7.990 + quebra de linha + "- " + 8 letras = 8.001: não cabe.
      expect(await recusaAoEnsinar(mensagem, 'rule', null, 'abcdefgh')).toMatch(/rules_limit_reached/);
      expect((await lerBase(base.id)).golden_rules).toBe('x'.repeat(7990));
      expect((await lerBase(base.id)).revision).toBe(1);

      // Com 7 letras fecha em 8.000 exatos: entra.
      await ensinar(mensagem, 'rule', null, 'abcdefg');
      expect((await lerBase(base.id)).golden_rules).toHaveLength(8000);
    });
  });
});

describe('Ensinar a IA pela conversa: qual base aprende', () => {
  test('aprende a base que o chip da mensagem usa; sem base própria, a padrão', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const principal = await criarBase();
      const suporte = await criarBase({ label: 'Suporte' });

      // O chip ainda não tem base própria: aprende a padrão.
      expect(await ensinar(mensagem, 'faq', 'Vocês entregam?', 'Sim.')).toMatchObject({ agent_id: principal.id, agent_label: 'Principal' });

      // Agora o chip usa a base Suporte: é ela que aprende, e a Principal fica como estava.
      await chamar('set_my_instance_ai_agent', [LOJA_A, CHIP_A, suporte.id]);
      expect(await ensinar(mensagem, 'faq', 'Como abro um chamado?', 'Pelo site.')).toMatchObject({ agent_id: suporte.id, agent_label: 'Suporte', revision: 2 });
      expect(resumo(await lerBase(suporte.id))).toEqual([['Como abro um chamado?', 'Pelo site.', 'correction']]);
      expect(resumo(await lerBase(principal.id))).toEqual([['Vocês entregam?', 'Sim.', 'correction']]);

      // A mesma pergunta pode existir nas duas bases: cada uma tem a sua resposta.
      await ensinar(mensagem, 'faq', 'Vocês entregam?', 'O suporte não faz entregas.');
      expect((await lerBase(suporte.id)).faqs).toHaveLength(2);
      expect((await lerBase(principal.id)).faqs).toHaveLength(1);

      // Trocar a padrão não muda quem o chip usa: ele continua com a Suporte.
      await chamar('set_my_instance_ai_agent', [LOJA_A, CHIP_A, null]);
      await chamar('set_my_default_ai_agent', [LOJA_A, suporte.id]);
      expect(await ensinar(mensagem, 'rule', null, 'Peça o número do pedido.')).toMatchObject({ agent_id: suporte.id });
    });
  });

  test('sem nenhuma base de treinamento, a resposta é que falta o treinamento', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await recusaAoEnsinar(await mensagemDa(LOJA_A), 'faq', 'Pergunta?', 'Resposta.')).toMatch(/ai_training_missing/);
    });
  });

  test('a mensagem precisa existir e ser da própria empresa', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await criarBase();
      const daOutraLoja = await mensagemDa(LOJA_B);
      expect(await recusaAoEnsinar(daOutraLoja, 'faq', 'Pergunta?', 'Resposta.')).toMatch(/Message not found/);
      expect(await recusaAoEnsinar('00000000-0000-4000-8000-000000000000', 'faq', 'Pergunta?', 'Resposta.')).toMatch(/Message not found/);
    });
  });
});

describe('Ensinar a IA pela conversa: quem pode', () => {
  test('só a dona ensina: atendente, ex-funcionário, quem é de fora e o administrador da plataforma são recusados', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase();

      for (const pessoa of [ATENDENTE_A, SUSPENSO_A, INTRUSO, MASTER, DONO_B]) {
        await passarA(pessoa);
        expect(await recusaAoEnsinar(mensagem, 'faq', 'Pergunta?', 'Resposta.')).toMatch(/Workspace owner required/);
        expect(await recusaAoEnsinar(mensagem, 'rule', null, 'Regra.')).toMatch(/Workspace owner required/);
      }

      await passarA(DONA_A);
      expect((await lerBase(base.id)).faqs).toEqual([]);
      expect((await lerBase(base.id)).golden_rules).toBe('');
    });
  });

  test('o dono de uma loja não ensina com uma mensagem da outra, nem a base da outra', async () => {
    await banco.comoUsuario(DONO_B, async () => {
      const daLojaA = await mensagemDa(LOJA_A);
      await criarBase({}, LOJA_B);
      expect(await recusaAoEnsinar(daLojaA, 'faq', 'Pergunta?', 'Resposta.', LOJA_B)).toMatch(/Message not found/);
      expect(await recusaAoEnsinar(daLojaA, 'faq', 'Pergunta?', 'Resposta.', LOJA_A)).toMatch(/Workspace owner required/);
    });
  });

  test('visitante sem login não chama a função', async () => {
    await banco.comoAnonimo(async () => {
      expect(await recusaAoEnsinar('00000000-0000-4000-8000-000000000000', 'faq', 'Pergunta?', 'Resposta.')).toMatch(/permission denied/);
    });
  });
});

describe('Treinamento: revisão da base', () => {
  test('a base nasce na revisão 1 e sobe 1 a cada gravação dos campos ou das perguntas', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase({ niche: 'Pizzaria' });
      expect(base.revision).toBe(1);
      expect((await gravarBase(base.id, { niche: 'Hamburgueria' })).revision).toBe(2);
      expect((await gravarBase(base.id, { faqs: [{ question: 'Abre domingo?', answer: 'Não.' }] })).revision).toBe(3);
      expect((await lerBase(base.id)).revision).toBe(3);

      // Uma base criada já com a conferência no pedido nasce na revisão 1 do mesmo jeito.
      expect((await criarBase({ label: 'Suporte', expected_revision: 7 })).revision).toBe(1);
    });
  });

  test('gravar com a tela desatualizada é recusado e não apaga o que foi ensinado; com a revisão certa, grava', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const mensagem = await mensagemDa(LOJA_A);
      const base = await criarBase({ faqs: [{ question: 'Vocês entregam?', answer: 'Sim.' }] });

      // A tela do Treinamento foi aberta aqui (revisão 1). Depois, uma correção foi feita na Inbox.
      await ensinar(mensagem, 'faq', 'Qual o horário?', 'Das 8h às 18h.');

      // A tela antiga tenta gravar a lista que ela conhecia: sem a pergunta ensinada.
      const telaAntiga = { expected_revision: 1, niche: 'Pizzaria', faqs: [{ question: 'Vocês entregam?', answer: 'Sim, sempre.' }] };
      expect(await recusa('save_my_ai_agent', [LOJA_A, base.id, telaAntiga])).toMatch(/agent_changed/);

      const intacta = await lerBase(base.id);
      expect(intacta.revision).toBe(2);
      expect(resumo(intacta)).toEqual([
        ['Qual o horário?', 'Das 8h às 18h.', 'correction'],
        ['Vocês entregam?', 'Sim.', 'manual'],
      ]);

      // Depois de recarregar, a tela conhece a revisão 2 e grava normalmente.
      const gravada = await gravarBase(base.id, { expected_revision: 2, niche: 'Pizzaria' });
      expect(gravada.revision).toBe(3);
      expect(gravada.faqs).toHaveLength(2);
    });
  });

  test('sem a conferência a gravação continua valendo; valor estranho é recusado; a conferência não entra na auditoria como campo', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase();
      expect((await gravarBase(base.id, { niche: 'Padaria' })).revision).toBe(2);

      for (const estranho of [0, -1, 1.5, '2', null, true, [2]]) {
        expect(await recusa('save_my_ai_agent', [LOJA_A, base.id, { expected_revision: estranho, niche: 'Outra' }])).toMatch(/Invalid expected_revision/);
      }
      expect((await lerBase(base.id)).revision).toBe(2);

      await gravarBase(base.id, { expected_revision: 2, niche: 'Confeitaria' });
      expect(await auditoria('ai_agent_updated')).toEqual([
        { fields: ['niche'], faq_count: null },
        { fields: ['niche'], faq_count: null },
      ]);
    });
  });

  test('duas telas abertas na mesma revisão: a primeira grava, a segunda é avisada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      const base = await criarBase();
      expect((await gravarBase(base.id, { expected_revision: 1, niche: 'Primeira aba' })).revision).toBe(2);
      expect(await recusa('save_my_ai_agent', [LOJA_A, base.id, { expected_revision: 1, niche: 'Segunda aba' }])).toMatch(/agent_changed/);
      expect(await lerBase(base.id)).toMatchObject({ niche: 'Primeira aba', revision: 2 });
    });
  });
});
