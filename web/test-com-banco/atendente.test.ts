/**
 * O atendente de IA de ponta a ponta.
 *
 * De verdade aqui: a porta de entrada dos avisos da Evolution, o código do atendente e o banco (o mesmo
 * Postgres em memória dos testes de banco, com todas as migrações).
 * De mentira: a Evolution e os provedores de IA (servidores locais que anotam o que receberam), e a
 * "porta" do Supabase (um servidor pequeno que só repassa cada chamada de função para o banco).
 *
 * Cada teste roda dentro de uma transação que é desfeita no fim.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BancoDeTeste } from '../../supabase/tests/helpers/banco';
import { ATENDENTE_A, CHIP_A, CONTATO_A, CONVERSA_A, DONA_A, LOJA_A, bancoComCenario } from '../../supabase/tests/helpers/cenario';
import { CHAVE_GEMINI_DE_TESTE, CHAVE_NVIDIA_DE_TESTE, CHAVE_OPENROUTER_DE_TESTE } from '../e2e/apoio/chaves-de-ia.mjs';
import { CHAVE_DE_TESTE as CHAVE_DA_EVOLUTION, criarEvolutionFalsa } from '../e2e/apoio/evolution-falsa.mjs';
import { criarIaFalsa, type PedidoRecebido } from '../e2e/apoio/ia-falsa.mjs';

/** O que a rota deixa para depois de responder à Evolution: o teste guarda e roda quando quiser. */
const depois = vi.hoisted(() => ({ tarefas: [] as Array<() => unknown> }));
vi.mock('next/server', () => ({
  after: (tarefa: () => unknown) => {
    depois.tarefas.push(tarefa);
  },
}));
async function rodarOQueFicouParaDepois() {
  const tarefas = depois.tarefas.splice(0);
  // Como no servidor de verdade: buscar o arquivo e responder acontecem ao mesmo tempo.
  await Promise.all(tarefas.map((tarefa) => tarefa()));
}

const SEGREDO_DO_COFRE = 'c'.repeat(64);
const SEGREDO_DO_CHIP = 'segredo-do-chip-de-ponta-a-ponta';
const RESUMO = createHash('sha256').update(SEGREDO_DO_CHIP).digest('hex');
const CHIP_NA_EVOLUTION = 'ienvia-ponta-0001';
const CLIENTE = '5586900000001';
const BASE = 'aaaaaaaa-2222-4222-8222-00000000b001';

let banco: BancoDeTeste;
let POST: (pedido: Request) => Promise<Response>;
let cifrar: (texto: string, contexto: string, chave: Buffer) => string;
let contextoDaChaveDeIa: (empresa: string, provedor: string) => string;

/** O que a "IA" responde em cada teste. */
let roteiro: (pedido: PedidoRecebido) => string = () => 'Resposta padrão.';
const ia = criarIaFalsa({ responder: (pedido) => roteiro(pedido) });
const evolution = criarEvolutionFalsa({ instancias: [{ nome: CHIP_NA_EVOLUTION, estado: 'open', telefone: '5586911110000' }] });
let enderecoDaIa = '';
let enderecoDaEvolution = '';

/** O "depósito": o que foi guardado, por caminho. */
const deposito = new Map<string, { dados: Buffer; conteudo: string }>();

/**
 * A "porta" do Supabase: cada chamada de função vira um `select public.funcao(...)` no banco de teste,
 * dentro da transação do teste. As chamadas entram em fila, uma de cada vez, e um erro desfaz só a própria chamada.
 */
let fila: Promise<unknown> = Promise.resolve();
let ponto = 0;
const porta = http.createServer((req, res) => {
  const partes: Buffer[] = [];
  req.on('data', (parte: Buffer) => partes.push(parte));
  req.on('end', () => {
    const corpo = Buffer.concat(partes);
    const endereco = decodeURIComponent(String(req.url).split('?')[0]!);
    const responder = (status: number, conteudo: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(conteudo));
    };

    if (endereco.startsWith('/storage/v1/object/midias/')) {
      const caminho = endereco.replace('/storage/v1/object/midias/', '');
      if (req.method === 'POST' || req.method === 'PUT') {
        deposito.set(caminho, { dados: corpo, conteudo: String(req.headers['content-type'] ?? 'application/octet-stream') });
        return responder(200, { Key: `midias/${caminho}`, Id: 'id-de-teste' });
      }
      const guardado = deposito.get(caminho);
      if (!guardado) return responder(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      res.writeHead(200, { 'content-type': guardado.conteudo, 'content-length': guardado.dados.length });
      return res.end(guardado.dados);
    }

    if (!endereco.startsWith('/rest/v1/rpc/')) return responder(404, { message: `não imitado: ${endereco}` });
    const funcao = endereco.replace('/rest/v1/rpc/', '');
    const parametros = JSON.parse(corpo.toString('utf8') || '{}') as Record<string, unknown>;
    const nomes = Object.keys(parametros);
    const nomeValido = /^[a-z_][a-z0-9_]*$/;
    if (!nomeValido.test(funcao) || nomes.some((nome) => !nomeValido.test(nome))) return responder(400, { message: 'pedido inválido' });

    fila = fila.then(async () => {
      ponto += 1;
      const marca = `porta_${ponto}`;
      await banco.db.exec(`savepoint ${marca}`);
      try {
        const { rows } = await banco.db.query<{ r: unknown }>(
          `select public.${funcao}(${nomes.map((nome, indice) => `${nome} => $${indice + 1}`).join(', ')}) as r`,
          nomes.map((nome) => parametros[nome]),
        );
        await banco.db.exec(`release savepoint ${marca}`);
        responder(200, rows[0]?.r ?? null);
      } catch (erro) {
        await banco.db.exec(`rollback to savepoint ${marca}`);
        await banco.db.exec(`release savepoint ${marca}`);
        const { code, message } = erro as { code?: string; message?: string };
        responder(400, { code: code ?? 'XX000', message: message ?? 'erro', details: null, hint: null });
      }
    });
  });
});

const ouvir = (servidor: http.Server) =>
  new Promise<string>((pronto) => servidor.listen(0, '127.0.0.1', () => pronto(`http://127.0.0.1:${(servidor.address() as AddressInfo).port}`)));

const ambienteAntes = { ...process.env };

beforeAll(async () => {
  banco = await bancoComCenario();
  enderecoDaIa = await ouvir(ia);
  enderecoDaEvolution = await ouvir(evolution);
  const enderecoDaPorta = await ouvir(porta);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: enderecoDaPorta,
    SUPABASE_SERVICE_ROLE_KEY: 'chave-do-servidor-de-teste',
    EVOLUTION_API_URL: enderecoDaEvolution,
    EVOLUTION_API_KEY: CHAVE_DA_EVOLUTION,
    IENVIA_GEMINI_URL: enderecoDaIa,
    IENVIA_OPENROUTER_URL: `${enderecoDaIa}/openrouter/api/v1`,
    IENVIA_NVIDIA_URL: `${enderecoDaIa}/nvidia/v1`,
    IENVIA_CHAVE_DOS_SEGREDOS: SEGREDO_DO_COFRE,
  });
  ({ POST } = await import('@/app/api/webhooks/evolution/route'));
  ({ cifrar, contextoDaChaveDeIa } = await import('@/lib/ia/cofre'));
});

afterAll(async () => {
  for (const servidor of [ia, evolution, porta]) servidor.close();
  for (const nome of Object.keys(process.env)) if (!(nome in ambienteAntes)) delete process.env[nome];
  Object.assign(process.env, ambienteAntes);
});

/** Tudo de volta ao começo: o que os servidores de mentira anotaram, o depósito e o roteiro da IA. */
async function recomecar() {
  depois.tarefas.length = 0;
  deposito.clear();
  roteiro = () => 'Entregamos sim, até as 23h!';
  await fetch(`${enderecoDaIa}/controle/reiniciar`, { method: 'POST' });
  await fetch(`${enderecoDaEvolution}/controle/enviadas`, { method: 'DELETE' });
  await fetch(`${enderecoDaEvolution}/controle/falha?tipo=nenhuma`);
}

beforeEach(async () => {
  await recomecar();
  // O atendente registra no console o que deu errado; aqui o registro é guardado para conferência, sem sujar a saída.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

type Json = Record<string, unknown>;

/** Dentro da transação do teste (que roda como o servidor), age um instante como administrador do banco. */
async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await fila;
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role service_role');
  }
}
const sql = (texto: string) => comoAdmin(() => banco.db.exec(texto));
const ler = <T = Json>(consulta: string, parametros: unknown[] = []) => comoAdmin(async () => (await banco.db.query<T>(consulta, parametros)).rows);

/** Uma pessoa da empresa faz algo pelo painel (as funções das pessoas, com o login dela). */
async function comoPessoa<T>(usuario: string, fn: () => Promise<T>): Promise<T> {
  await fila;
  await banco.db.exec('set local role authenticated');
  await banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [usuario]);
  try {
    return await fn();
  } finally {
    await banco.db.query("select set_config('request.jwt.claim.sub', '', true)");
    await banco.db.exec('set local role service_role');
  }
}

interface Preparo {
  provedor?: 'gemini' | 'openrouter' | 'nvidia';
  reserva?: 'gemini' | 'openrouter' | 'nvidia' | 'none';
  chaves?: Array<'gemini' | 'openrouter' | 'nvidia'>;
  dividir?: boolean;
  digitando?: boolean;
  trava?: boolean;
}

const CHAVE_DE_TESTE = { gemini: CHAVE_GEMINI_DE_TESTE, openrouter: CHAVE_OPENROUTER_DE_TESTE, nvidia: CHAVE_NVIDIA_DE_TESTE } as const;

/** Deixa a Loja A pronta: chip com a IA ligada, Motor de IA configurado, chaves cifradas e uma base de treinamento. */
async function preparar(opcoes: Preparo = {}) {
  const provedor = opcoes.provedor ?? 'nvidia';
  const reserva = opcoes.reserva ?? 'openrouter';
  const cofre = Buffer.from(SEGREDO_DO_COFRE, 'hex');
  const chaves = (opcoes.chaves ?? ['nvidia', 'openrouter'])
    .map((nome) => `('${LOJA_A}', '${nome}', '${cifrar(CHAVE_DE_TESTE[nome], contextoDaChaveDeIa(LOJA_A, nome), cofre)}', 'test')`)
    .join(', ');
  await sql(`
    update public.instances set provider_instance_name = '${CHIP_NA_EVOLUTION}' where id = '${CHIP_A}';
    insert into private.evolution_webhook_auth(workspace_id, instance_id, token_sha256) values ('${LOJA_A}', '${CHIP_A}', '${RESUMO}');
    insert into public.workspace_ai_settings(workspace_id, provider, fallback_provider, debounce_seconds, split_long_messages, simulate_typing)
      values ('${LOJA_A}', '${provedor}', '${reserva}', 1, ${opcoes.dividir !== false}, ${opcoes.digitando !== false});
    ${chaves ? `insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint) values ${chaves};` : ''}
    insert into public.ai_agents(id, workspace_id, label, is_default, business_name, assistant_name, company_summary, lock_until_manual_resume)
      values ('${BASE}', '${LOJA_A}', 'Principal', true, 'Pizzaria do Zé', 'Bia', 'Pizzas artesanais com entrega.', ${opcoes.trava === true});
  `);
}

let sequencia = 0;
interface OpcoesDoAviso {
  numero?: string;
  id?: string;
  mensagem?: Json;
  deMim?: boolean;
}

/** A Evolution avisa o painel de uma mensagem. Devolve o que o painel respondeu. */
async function chegou(textoDaMensagem: string, opcoes: OpcoesDoAviso = {}) {
  sequencia += 1;
  const resposta = await POST(
    new Request('https://painel.teste.invalid/api/webhooks/evolution', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SEGREDO_DO_CHIP}` },
      body: JSON.stringify({
        event: 'messages.upsert',
        instance: CHIP_NA_EVOLUTION,
        data: {
          key: { remoteJid: `${opcoes.numero ?? CLIENTE}@s.whatsapp.net`, fromMe: opcoes.deMim === true, id: opcoes.id ?? `PONTA-${sequencia}` },
          pushName: 'Maria',
          message: opcoes.mensagem ?? { conversation: textoDaMensagem },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      }),
    }),
  );
  await fila;
  return { status: resposta.status, corpo: (await resposta.json()) as { ok: boolean; resultado: string } };
}

const pedidosDaIa = async () => (await (await fetch(`${enderecoDaIa}/controle/pedidos`)).json()) as PedidoRecebido[];
const enviadasPelaEvolution = async () =>
  (await (await fetch(`${enderecoDaEvolution}/controle/enviadas`)).json()) as Array<{ numero: string; texto: string; digitando?: number; id: string }>;
const tentativasNaEvolution = async () => (await (await fetch(`${enderecoDaEvolution}/controle/tentativas`)).json()) as Array<{ numero: string; texto: string }>;

interface Conversa {
  id: string;
  stage: string;
  unread_count: number;
  automation_paused: boolean;
  ai_pause_reason: string | null;
  ai_handoff_note: string | null;
  pausada: boolean;
}
async function conversaDe(numero = CLIENTE): Promise<Conversa> {
  const linhas = await ler<Conversa>(
    `select c.id, c.stage, c.unread_count, c.automation_paused, c.ai_pause_reason, c.ai_handoff_note,
            (c.ai_paused_until is not null and c.ai_paused_until > clock_timestamp()) as pausada
       from public.conversations c join public.contacts ct on ct.id = c.contact_id
      where c.workspace_id = $1 and ct.external_user_id = $2 order by c.created_at desc, c.id limit 1`,
    [LOJA_A, `${numero}@s.whatsapp.net`],
  );
  return linhas[0]!;
}
const mensagensDaIa = (conversa: string) =>
  ler<{ status: string; body_text: string; provider_message_id: string | null }>(
    "select status, body_text, provider_message_id from public.messages where conversation_id = $1 and actor_type = 'ai' order by created_at, idempotency_key",
    [conversa],
  );
const vezesDe = (conversa: string) =>
  ler<{ status: string; outcome_detail: string | null; provider: string | null; model: string | null; attempts: Json[] }>(
    'select status, outcome_detail, provider, model, attempts from public.ai_turns where conversation_id = $1 order by due_at, id',
    [conversa],
  );

describe('a IA responde uma mensagem que chegou', () => {
  test('do aviso da Evolution até a resposta no WhatsApp', async () => {
    await banco.comoServico(async () => {
      await preparar();
      expect(await chegou('Vocês entregam?')).toEqual({ status: 200, corpo: { ok: true, resultado: 'accepted' } });
      // A Evolution já recebeu o "ok"; a resposta é preparada depois.
      expect(await enviadasPelaEvolution()).toEqual([]);
      expect(await conversaDe()).toMatchObject({ id: CONVERSA_A, stage: 'ai', unread_count: 3 });

      await rodarOQueFicouParaDepois();

      const [pedido] = await pedidosDaIa();
      expect(pedido).toMatchObject({ provedor: 'nvidia', modelo: 'nvidia/nemotron-3.5-super-vl-120b-a12b', anexo: null, temperatura: 0.35, semPensar: true });
      expect(pedido!.sistema).toContain('Pizzaria do Zé');
      // O nome do contato (o que já estava na ficha dele) vai nas instruções.
      expect(pedido!.sistema).toContain('Cliente da A');
      // As duas mensagens do contato que estavam sem resposta chegam juntas, na ordem.
      expect(pedido!.conversa).toEqual([{ de: 'cliente', texto: 'Oi, tem pizza?\nVocês entregam?' }]);

      const enviadas = await enviadasPelaEvolution();
      expect(enviadas).toMatchObject([{ numero: CLIENTE, texto: 'Entregamos sim, até as 23h!' }]);
      // Antes de a mensagem sair, o contato vê "digitando…" por um tempo proporcional ao texto.
      expect(enviadas[0]!.digitando).toBeGreaterThanOrEqual(1500);
      expect(enviadas[0]!.digitando).toBeLessThanOrEqual(5200);

      expect(await mensagensDaIa(CONVERSA_A)).toEqual([{ status: 'sent', body_text: 'Entregamos sim, até as 23h!', provider_message_id: enviadas[0]!.id }]);
      expect(await conversaDe()).toMatchObject({ stage: 'ai', unread_count: 0, automation_paused: false, pausada: false });
      expect(await vezesDe(CONVERSA_A)).toEqual([
        { status: 'answered', outcome_detail: null, provider: 'nvidia', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', attempts: [] },
      ]);
    });
  });

  test('mensagens picadas viram uma resposta só', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await chegou('Oi');
      await chegou('tem pizza doce?');
      await chegou('e entrega no Centro?');
      await rodarOQueFicouParaDepois();

      const pedidos = await pedidosDaIa();
      expect(pedidos).toHaveLength(1);
      expect(pedidos[0]!.conversa.at(-1)).toEqual({ de: 'cliente', texto: 'Oi, tem pizza?\nOi\ntem pizza doce?\ne entrega no Centro?' });
      expect(await enviadasPelaEvolution()).toHaveLength(1);
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'answered' }]);
    });
  });

  test('a conversa anterior vai junto: o que a IA e as pessoas já disseram', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = () => 'Temos calabresa e marguerita.';
      await chegou('Quais sabores?');
      await rodarOQueFicouParaDepois();
      roteiro = () => 'A calabresa sai por R$ 40.';
      await chegou('Quanto é a calabresa?');
      await rodarOQueFicouParaDepois();

      const pedidos = await pedidosDaIa();
      expect(pedidos[1]!.conversa).toEqual([
        { de: 'cliente', texto: 'Oi, tem pizza?\nQuais sabores?' },
        { de: 'atendente', texto: 'Temos calabresa e marguerita.' },
        { de: 'cliente', texto: 'Quanto é a calabresa?' },
      ]);
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Temos calabresa e marguerita.', 'A calabresa sai por R$ 40.']);
    });
  });

  test('resposta comprida, com parágrafos, sai em balões separados e na ordem', async () => {
    await banco.comoServico(async () => {
      await preparar();
      const paragrafos = [
        'Entregamos sim! A taxa depende do bairro e o pedido chega em até 50 minutos depois da confirmação.',
        'Hoje temos calabresa, marguerita, quatro queijos e a doce de chocolate com morango, todas no tamanho grande.',
        'Quer que eu já anote o seu pedido? É só me dizer o sabor e o endereço completo com um ponto de referência.',
      ];
      roteiro = () => paragrafos.join('\n\n');
      await chegou('Como funciona?');
      await rodarOQueFicouParaDepois();
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(paragrafos);
      expect((await mensagensDaIa(CONVERSA_A)).map((mensagem) => mensagem.status)).toEqual(['sent', 'sent', 'sent']);
    });
    await recomecar();
    await banco.comoServico(async () => {
      await preparar({ dividir: false, digitando: false });
      roteiro = () => `${'Primeiro parágrafo bem comprido. '.repeat(6)}\n\n${'Segundo parágrafo bem comprido. '.repeat(6)}`;
      await chegou('Como funciona?');
      await rodarOQueFicouParaDepois();
      const enviadas = await enviadasPelaEvolution();
      // Com as opções desligadas no Motor de IA: um balão só, e sem "digitando…".
      expect(enviadas).toHaveLength(1);
      expect(enviadas[0]).not.toHaveProperty('digitando');
    });
  });

  test('os comandos da IA nunca chegam ao contato', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = () => 'Claro! **Calabresa** é a mais pedida. [[COMANDO_QUE_NAO_EXISTE:xyz]]';
      await chegou('Qual a mais pedida?');
      await rodarOQueFicouParaDepois();
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Claro! *Calabresa* é a mais pedida.']);
    });
  });
});

describe('a IA passa a conversa para uma pessoa', () => {
  test('quando ela pede: o contato recebe o aviso curto, e a conversa vai para "Esperando você" com o recado', async () => {
    await banco.comoServico(async () => {
      await preparar();
      const recado = 'Cenário: cliente novo | Gatilho: quer fechar o pedido | Próxima jogada: confirmar endereço';
      roteiro = () => `Um minutinho que já confirmo isso pra você! [[CHAMAR_HUMANO:${recado}]]`;
      await chegou('Quero fechar o pedido');
      await rodarOQueFicouParaDepois();

      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Um minutinho que já confirmo isso pra você!']);
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_human', unread_count: 1, ai_pause_reason: 'handoff', ai_handoff_note: recado, automation_paused: false, pausada: true });
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'handed_off', outcome_detail: 'asked', provider: 'nvidia' }]);

      // Enquanto a pausa durar, a IA não responde mais nesta conversa.
      await chegou('Alô?');
      await rodarOQueFicouParaDepois();
      expect(await pedidosDaIa()).toHaveLength(1);
      expect(await enviadasPelaEvolution()).toHaveLength(1);
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_human', unread_count: 2 });
    });
  });

  test('com a trava permanente do treinamento, a IA só volta quando alguém devolver a conversa', async () => {
    await banco.comoServico(async () => {
      await preparar({ trava: true });
      roteiro = () => 'Já te respondo! [[CHAMAR_HUMANO:Pediu o responsável]]';
      await chegou('Quero falar com o dono');
      await rodarOQueFicouParaDepois();
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_human', automation_paused: true, ai_pause_reason: 'handoff' });

      await comoPessoa(ATENDENTE_A, () => banco.db.query('select public.transition_workspace_conversation($1,$2,$3)', [LOJA_A, CONVERSA_A, 'release']));
      roteiro = () => 'Voltei! Em que posso ajudar?';
      await chegou('Oi de novo');
      await rodarOQueFicouParaDepois();
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Já te respondo!', 'Voltei! Em que posso ajudar?']);
      expect(await conversaDe()).toMatchObject({ stage: 'ai', automation_paused: false, ai_handoff_note: null });
    });
  });

  test('quando ela não entende a mensagem: não envia nada e chama uma pessoa', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = () => '[[PAUSA_SILENCIOSA:Mensagem solta, sem contexto]]';
      await chegou('aquele de ontem');
      await rodarOQueFicouParaDepois();
      expect(await tentativasNaEvolution()).toEqual([]);
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_human', automation_paused: true, ai_pause_reason: 'silent_handoff', ai_handoff_note: 'Mensagem solta, sem contexto' });
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'handed_off', outcome_detail: 'silent_pause' }]);
    });
  });

  test('quando perguntam se é um robô (padrão): a IA não responde e passa para uma pessoa', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = (pedido) => (pedido.sistema.includes('Responda SOMENTE com [[CHAMAR_HUMANO:Perguntou se é robô]]') ? '[[CHAMAR_HUMANO:Perguntou se é robô]]' : 'Sou uma pessoa.');
      await chegou('Você é um robô?');
      await rodarOQueFicouParaDepois();
      expect(await tentativasNaEvolution()).toEqual([]);
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_human', ai_handoff_note: 'Perguntou se é robô', pausada: true });
    });
  });

  test('quando ela tenta enviar foto, áudio ou PIX (ainda não faz): o texto sai e uma pessoa é chamada', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = () => 'Vou te mandar a foto do cardápio! [[ENVIAR_ITEM:cardapio]]';
      await chegou('Tem foto do cardápio?');
      await rodarOQueFicouParaDepois();
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Vou te mandar a foto do cardápio!']);
      const conversa = await conversaDe();
      expect(conversa).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'handoff' });
      expect(conversa.ai_handoff_note).toBe('A IA quis enviar uma foto ou arquivo do catálogo, e isso ela ainda não faz.');
    });
  });

  test('"ok, obrigado" final: a IA fica em silêncio e a conversa não fica pendente', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = () => '[[SILENCIO_CORTESIA]]';
      await chegou('ok, obrigado');
      await rodarOQueFicouParaDepois();
      expect(await tentativasNaEvolution()).toEqual([]);
      expect(await conversaDe()).toMatchObject({ stage: 'ai', unread_count: 0, automation_paused: false, pausada: false });
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'silent', outcome_detail: 'courtesy' }]);
    });
  });

  test('recusa e pedido para parar: a IA se despede e encerra a conversa', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = () => 'Sem problema! Se mudar de ideia, é só chamar. [[ENCERRAR_CONTATO:Sem interesse no momento]]';
      await chegou('Não tenho interesse');
      await rodarOQueFicouParaDepois();
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Sem problema! Se mudar de ideia, é só chamar.']);
      expect(await conversaDe()).toMatchObject({ stage: 'resolved', automation_paused: true, ai_pause_reason: 'closed', ai_handoff_note: 'Sem interesse no momento' });
      expect(await ler('select consent_status from public.contacts where id = $1', [CONTATO_A])).toEqual([{ consent_status: 'unknown' }]);
    });
    await recomecar();
    await banco.comoServico(async () => {
      await preparar();
      roteiro = () => 'Entendido, não envio mais mensagens por aqui. [[PARAR_CONTATO:Pediu para parar]]';
      await chegou('Pare de me mandar mensagem');
      await rodarOQueFicouParaDepois();
      expect(await conversaDe()).toMatchObject({ stage: 'resolved', ai_pause_reason: 'opt_out' });
      expect(await ler('select consent_status from public.contacts where id = $1', [CONTATO_A])).toEqual([{ consent_status: 'opted_out' }]);
    });
  });
});

describe('quando algo dá errado, a conversa vai para uma pessoa (nada fica perdido)', () => {
  test('o provedor principal falha: a reserva responde', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await fetch(`${enderecoDaIa}/controle/falha?tipo=pane&vezes=1&provedor=nvidia`, { method: 'POST' });
      await chegou('Vocês entregam?');
      await rodarOQueFicouParaDepois();
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Entregamos sim, até as 23h!']);
      expect(await vezesDe(CONVERSA_A)).toEqual([
        {
          status: 'answered',
          outcome_detail: null,
          provider: 'openrouter',
          model: 'deepseek/deepseek-chat',
          attempts: [{ provider: 'nvidia', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', error: 'indisponivel' }],
        },
      ]);
    });
  });

  test('todos os provedores falham: nada é enviado, e a pessoa recebe a explicação', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await fetch(`${enderecoDaIa}/controle/falha?tipo=limite&vezes=5`, { method: 'POST' });
      await chegou('Vocês entregam?');
      await rodarOQueFicouParaDepois();
      expect(await tentativasNaEvolution()).toEqual([]);
      const conversa = await conversaDe();
      expect(conversa).toMatchObject({ stage: 'waiting_human', unread_count: 3, ai_pause_reason: 'error', pausada: true });
      expect(conversa.ai_handoff_note).toBe('A NVIDIA avisou que o limite de uso desta chave foi atingido. Espere um pouco e tente de novo. A reserva também falhou.');
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'failed', outcome_detail: 'limite', provider: null }]);
    });
  });

  test('sem a chave do provedor, sem treinamento ou com a chave que não abre: a pessoa fica sabendo o motivo', async () => {
    await banco.comoServico(async () => {
      await preparar({ chaves: [] });
      await chegou('Oi');
      await rodarOQueFicouParaDepois();
      expect((await conversaDe()).ai_handoff_note).toBe('Falta a chave da NVIDIA no Motor de IA.');
      expect(await pedidosDaIa()).toEqual([]);
    });
    await recomecar();
    await banco.comoServico(async () => {
      await preparar();
      await sql(`delete from public.ai_agents where id = '${BASE}'`);
      await chegou('Oi');
      await rodarOQueFicouParaDepois();
      expect((await conversaDe()).ai_handoff_note).toBe('Ainda não existe uma base de treinamento. Preencha a aba Treinamento.');
    });
    await recomecar();
    await banco.comoServico(async () => {
      await preparar({ reserva: 'none', chaves: ['nvidia'] });
      // A chave foi cifrada com outro segredo (o do servidor foi trocado, por exemplo).
      const outra = cifrar(CHAVE_NVIDIA_DE_TESTE, contextoDaChaveDeIa(LOJA_A, 'nvidia'), Buffer.from('d'.repeat(64), 'hex'));
      await sql(`update private.workspace_ai_secrets set ciphertext = '${outra}' where workspace_id = '${LOJA_A}'`);
      await chegou('Oi');
      await rodarOQueFicouParaDepois();
      expect((await conversaDe()).ai_handoff_note).toBe('A chave da NVIDIA guardada não abre mais. Cadastre a chave de novo no Motor de IA.');
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'failed', outcome_detail: 'key_unreadable' }]);
    });
  });

  test('não dá para saber se a resposta saiu: fica "sem confirmação", vai para uma pessoa e NUNCA é reenviada', async () => {
    await banco.comoServico(async () => {
      await preparar();
      // Número terminado em 0500: a Evolution de mentira responde com erro depois de receber o pedido.
      await chegou('Vocês entregam?', { numero: '5586900000500' });
      await rodarOQueFicouParaDepois();
      const conversa = await conversaDe('5586900000500');
      expect(await tentativasNaEvolution()).toHaveLength(1);
      expect(await mensagensDaIa(conversa.id)).toEqual([{ status: 'awaiting_human_confirmation', body_text: 'Entregamos sim, até as 23h!', provider_message_id: null }]);
      expect(conversa).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'uncertain_send', pausada: true });
      expect(conversa.ai_handoff_note).toBe('Confira no WhatsApp do chip e marque, na própria mensagem, se ela foi enviada ou não.');
      expect(await vezesDe(conversa.id)).toMatchObject([{ status: 'handed_off', outcome_detail: 'uncertain_part_1' }]);
    });
  });

  test('resposta em balões: se um balão fica incerto, os seguintes não saem', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = () => `${'Primeiro parágrafo bem comprido para dividir. '.repeat(4)}\n\n${'Segundo parágrafo bem comprido para dividir. '.repeat(4)}`;
      await chegou('Como funciona?', { numero: '5586900000500' });
      await rodarOQueFicouParaDepois();
      expect(await tentativasNaEvolution()).toHaveLength(1);
      expect(await mensagensDaIa((await conversaDe('5586900000500')).id)).toHaveLength(1);
    });
  });

  test('o número não tem WhatsApp: a mensagem fica "não enviada" e a pessoa é avisada', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await chegou('Oi', { numero: '5586900000404' });
      await rodarOQueFicouParaDepois();
      const conversa = await conversaDe('5586900000404');
      expect(await mensagensDaIa(conversa.id)).toMatchObject([{ status: 'failed' }]);
      expect(conversa).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'error', ai_handoff_note: 'A resposta não foi enviada: este número não tem WhatsApp.' });
      expect(await vezesDe(conversa.id)).toMatchObject([{ status: 'failed', outcome_detail: 'not_sent:sem_whatsapp' }]);
    });
  });

  test('a IA devolve uma resposta sem texto: nada é enviado e a pessoa é avisada', async () => {
    await banco.comoServico(async () => {
      await preparar({ reserva: 'none' });
      roteiro = () => '[[COMANDO_QUE_NAO_EXISTE]]';
      await chegou('Oi');
      await rodarOQueFicouParaDepois();
      expect(await tentativasNaEvolution()).toEqual([]);
      expect((await conversaDe()).ai_handoff_note).toBe('A NVIDIA devolveu uma resposta sem texto.');
    });
  });
});

describe('a IA não atropela ninguém', () => {
  test('uma pessoa responde pelo painel enquanto a IA esperava: a IA não responde', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await chegou('Vocês entregam?');
      await comoPessoa(DONA_A, async () => {
        const inicio = await banco.db.query<{ r: { message_id: string } }>('select public.start_my_text_message($1,$2,$3,$4) as r', [LOJA_A, CONVERSA_A, 'Entregamos!', 'chave-de-envio-ponta-1']);
        await banco.db.query('select public.finish_my_text_message($1,$2,$3,$4)', [LOJA_A, inicio.rows[0]!.r.message_id, 'sent', 'WA-HUMANA-1']);
      });
      await rodarOQueFicouParaDepois();
      expect(await pedidosDaIa()).toEqual([]);
      expect(await tentativasNaEvolution()).toEqual([]);
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_customer', ai_pause_reason: 'human_reply', pausada: true });
    });
  });

  test('alguém pausa tudo enquanto a IA preparava a resposta: nada é enviado', async () => {
    await banco.comoServico(async () => {
      await preparar();
      // A pausa acontece no meio do pedido ao provedor.
      roteiro = () => {
        void comoPessoa(ATENDENTE_A, () => banco.db.query('select public.pause_my_ai($1)', [LOJA_A]));
        return 'Entregamos sim!';
      };
      await chegou('Vocês entregam?');
      await rodarOQueFicouParaDepois();
      expect(await pedidosDaIa()).toHaveLength(1);
      expect(await tentativasNaEvolution()).toEqual([]);
      expect(await mensagensDaIa(CONVERSA_A)).toEqual([]);
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_human', unread_count: 3 });
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'skipped', outcome_detail: 'workspace_paused' }]);
    });
  });

  test('o cliente escreve de novo enquanto a IA preparava a resposta: a resposta velha é abandonada e sai uma só, com tudo', async () => {
    await banco.comoServico(async () => {
      await preparar();
      let pedidos = 0;
      let segundaMensagem: Promise<unknown> = Promise.resolve();
      roteiro = (pedido) => {
        pedidos += 1;
        // Durante o primeiro pedido ao provedor, chega mais uma mensagem do cliente.
        if (pedidos === 1) segundaMensagem = chegou('É no bairro Centro');
        return `Resposta ${pedidos} para: ${pedido.conversa.at(-1)!.texto.split('\n').at(-1)}`;
      };
      await chegou('Vocês entregam?');
      await rodarOQueFicouParaDepois();
      await segundaMensagem;
      await rodarOQueFicouParaDepois();

      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Resposta 2 para: É no bairro Centro']);
      expect((await pedidosDaIa())[1]!.conversa.at(-1)!.texto).toBe('Oi, tem pizza?\nVocês entregam?\nÉ no bairro Centro');
      expect(await vezesDe(CONVERSA_A)).toMatchObject([
        { status: 'skipped', outcome_detail: 'superseded' },
        { status: 'answered' },
      ]);
      expect(await conversaDe()).toMatchObject({ stage: 'ai', unread_count: 0 });
    });
  });

  test('com a IA desligada no chip ou pausada na empresa, a mensagem só é guardada', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await sql(`update public.instances set is_enabled = false where id = '${CHIP_A}'`);
      await chegou('Oi');
      await rodarOQueFicouParaDepois();
      expect(await pedidosDaIa()).toEqual([]);
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_human', unread_count: 3 });
      expect(await vezesDe(CONVERSA_A)).toEqual([]);
    });
  });

  test('mensagem enviada pelo celular do chip não é respondida pela IA e ainda pausa a IA na conversa', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await chegou('Deixa comigo', { deMim: true });
      await rodarOQueFicouParaDepois();
      expect(await pedidosDaIa()).toEqual([]);
      expect(await conversaDe()).toMatchObject({ stage: 'waiting_customer', ai_pause_reason: 'human_reply', pausada: true });
    });
  });
});

describe('arquivos que o cliente manda', () => {
  const foto = { imageMessage: { url: 'https://mmg.whatsapp.net/v/foto.enc', mimetype: 'image/jpeg', caption: 'Essa pizza tem?', fileLength: '52000', height: 600, width: 800 } };
  const audio = { audioMessage: { url: 'https://mmg.whatsapp.net/v/audio.enc', mimetype: 'audio/ogg; codecs=opus', seconds: 7, ptt: true, fileLength: '9000' } };

  test('foto com legenda: a IA recebe a foto junto com a conversa', async () => {
    await banco.comoServico(async () => {
      await preparar();
      roteiro = (pedido) => (pedido.anexo ? 'Temos sim, é a marguerita!' : 'Não vi a foto.');
      await chegou('', { mensagem: foto });
      await rodarOQueFicouParaDepois();

      const [pedido] = await pedidosDaIa();
      expect(pedido!.anexo).toMatchObject({ tipo: 'image/png' });
      expect(pedido!.anexo!.bytes).toBeGreaterThan(1000);
      expect(pedido!.conversa.at(-1)).toEqual({ de: 'cliente', texto: 'Oi, tem pizza?\n[foto em anexo] Essa pizza tem?' });
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Temos sim, é a marguerita!']);
    });
  });

  test('áudio sem o Gemini na ordem de uso: a IA não ouve, não inventa, e chama uma pessoa', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await chegou('', { mensagem: audio });
      await rodarOQueFicouParaDepois();
      expect(await pedidosDaIa()).toEqual([]);
      expect(await tentativasNaEvolution()).toEqual([]);
      const conversa = await conversaDe();
      expect(conversa).toMatchObject({ stage: 'waiting_human', automation_paused: true, ai_pause_reason: 'silent_handoff' });
      expect(conversa.ai_handoff_note).toBe(
        'O contato mandou um áudio. A IA só escuta áudio pelo Google Gemini, que não está na ordem de uso do Motor de IA (ou está sem chave).',
      );
    });
  });

  test('áudio com o Gemini na ordem de uso: vai para o Gemini, mesmo ele sendo a reserva', async () => {
    await banco.comoServico(async () => {
      await preparar({ provedor: 'nvidia', reserva: 'gemini', chaves: ['nvidia', 'gemini'] });
      roteiro = (pedido) => (pedido.anexo?.tipo.startsWith('audio/') ? 'Ouvi! Entregamos sim.' : 'Não ouvi.');
      await chegou('', { mensagem: audio });
      await rodarOQueFicouParaDepois();
      const pedidos = await pedidosDaIa();
      expect(pedidos).toHaveLength(1);
      expect(pedidos[0]).toMatchObject({ provedor: 'gemini', anexo: { tipo: 'audio/wav' } });
      expect(pedidos[0]!.conversa.at(-1)).toEqual({ de: 'cliente', texto: 'Oi, tem pizza?\n[áudio em anexo]' });
      expect((await enviadasPelaEvolution()).map((envio) => envio.texto)).toEqual(['Ouvi! Entregamos sim.']);
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'answered', provider: 'gemini' }]);
    });
  });

  test('o arquivo não pôde ser trazido do WhatsApp: a IA não responde no escuro', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await chegou('', { mensagem: { imageMessage: { ...foto.imageMessage, caption: undefined } }, id: 'FOTO-SEM-ARQUIVO' });
      await rodarOQueFicouParaDepois();
      expect(await pedidosDaIa()).toEqual([]);
      expect((await conversaDe()).ai_handoff_note).toBe('O contato mandou uma foto, mas o painel não conseguiu trazer o arquivo do WhatsApp para a IA ver.');
    });
  });

  test('vídeo com legenda: a IA lê a legenda e sabe que há um vídeo que ela não vê', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await chegou('', { mensagem: { videoMessage: { url: 'https://mmg.whatsapp.net/v/video.enc', mimetype: 'video/mp4', caption: 'Olha o forno de vocês', seconds: 12, fileLength: '900000' } } });
      await rodarOQueFicouParaDepois();
      const [pedido] = await pedidosDaIa();
      expect(pedido!.anexo).toBeNull();
      expect(pedido!.conversa.at(-1)!.texto).toBe('Oi, tem pizza?\n[o contato enviou um vídeo que você não consegue ver] Olha o forno de vocês');
    });
  });
});

describe('o que ficou para trás', () => {
  test('uma vez que ficou sem dono é respondida no próximo aviso da empresa', async () => {
    await banco.comoServico(async () => {
      await preparar();
      // O aviso chegou, mas o servidor "caiu" antes de responder: a tarefa nunca rodou.
      await chegou('Vocês entregam?');
      depois.tarefas.length = 0;
      await sql(`update public.ai_turns set due_at = clock_timestamp() - interval '40 seconds'`);

      // Outro contato escreve. O pedido dele responde a ele e aproveita para cuidar do que ficou para trás.
      roteiro = (pedido) => `Resposta para: ${pedido.conversa.at(-1)!.texto.split('\n').at(-1)}`;
      await chegou('Qual o horário?', { numero: '5586900000077' });
      await rodarOQueFicouParaDepois();

      expect((await enviadasPelaEvolution()).map((envio) => `${envio.numero}: ${envio.texto}`).sort()).toEqual([
        `${CLIENTE}: Resposta para: Vocês entregam?`,
        '5586900000077: Resposta para: Qual o horário?',
      ]);
      expect(await vezesDe(CONVERSA_A)).toMatchObject([{ status: 'answered' }]);
    });
  });

  test('uma resposta interrompida no meio vai para uma pessoa, sem reenviar nada', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await chegou('Vocês entregam?');
      depois.tarefas.length = 0;
      await sql(`update public.ai_turns set status = 'running', claimed_at = clock_timestamp() - interval '5 minutes'`);

      await chegou('Qual o horário?', { numero: '5586900000077' });
      await rodarOQueFicouParaDepois();

      expect(await conversaDe()).toMatchObject({ stage: 'waiting_human', ai_pause_reason: 'error' });
      expect((await conversaDe()).ai_handoff_note).toMatch(/interrompida no meio de uma resposta/);
      expect((await enviadasPelaEvolution()).map((envio) => envio.numero)).toEqual(['5586900000077']);
    });
  });
});

describe('segredos', () => {
  test('a chave do cliente não aparece em nada do que o atendente grava', async () => {
    await banco.comoServico(async () => {
      await preparar();
      await fetch(`${enderecoDaIa}/controle/falha?tipo=pane&vezes=1&provedor=nvidia`, { method: 'POST' });
      await chegou('Vocês entregam?');
      await rodarOQueFicouParaDepois();
      const tudo = JSON.stringify([
        await ler('select * from public.ai_turns'),
        await ler('select * from public.messages'),
        await ler('select * from public.conversations'),
        await ler('select * from private.audit_events'),
      ]);
      for (const chave of [CHAVE_NVIDIA_DE_TESTE, CHAVE_OPENROUTER_DE_TESTE]) expect(tudo).not.toContain(chave);
      // E também não vai para os registros do servidor.
      const registros = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(registros).toContain('o provedor não respondeu');
      for (const chave of [CHAVE_NVIDIA_DE_TESTE, CHAVE_OPENROUTER_DE_TESTE]) expect(registros).not.toContain(chave);
    });
  });
});
