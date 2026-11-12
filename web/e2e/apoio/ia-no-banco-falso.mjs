/**
 * A parte de IA do "Supabase de mentira": o Motor de IA (configurações e chaves) e o Treinamento
 * (bases, perguntas frequentes e arquivos de conhecimento).
 *
 * Segue as mesmas regras do banco de verdade (supabase/migrations/20261112002400_ai_engine_and_training.sql):
 * só o dono grava, a equipe lê, quem é de fora não vê nada, e os mesmos limites e nomes de erro.
 * As regras de verdade são testadas à parte, em supabase/tests/ia.test.ts, contra a migração real.
 */
import crypto from 'node:crypto';
import { CHIP_SUPORTE, PARTICIPACOES, USUARIOS, WORKSPACE_INBOX } from './dados.mjs';
import { CHAVE_GEMINI_DE_TESTE } from './chaves-de-ia.mjs';

/** O segredo do cofre usado nos testes e na prévia com dados de exemplo (nunca em produção). */
export const SEGREDO_DO_COFRE_DE_TESTE = '0f1e2d3c4b5a69788796a5b4c3d2e1f00123456789abcdeffedcba9876543210';

/**
 * Cifra uma chave do mesmo jeito que o painel (src/lib/ia/cofre.ts), para o cenário de exemplo já
 * começar com uma chave cadastrada. Um teste confere que o painel consegue abrir o que sai daqui.
 */
export function cifrarComoOPainel(texto, workspaceId, provedor, segredo = process.env.IENVIA_CHAVE_DOS_SEGREDOS || SEGREDO_DO_COFRE_DE_TESTE) {
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', Buffer.from(segredo, 'hex'), iv);
  cifrador.setAAD(Buffer.from(`ienvia:chave-de-ia:${workspaceId}:${provedor}`, 'utf8'));
  const conteudo = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  return ['v1', iv.toString('base64url'), cifrador.getAuthTag().toString('base64url'), conteudo.toString('base64url')].join('.');
}

export const BASE_PRINCIPAL_DA_INBOX = 'e1000000-0000-4000-8000-000000000001';
export const BASE_DE_SUPORTE_DA_INBOX = 'e1000000-0000-4000-8000-000000000002';
export const ARQUIVO_DE_EXEMPLO_DA_INBOX = 'e3000000-0000-4000-8000-000000000001';

const PROVEDORES = ['gemini', 'openrouter', 'nvidia'];

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
  admin_alert_enabled: false,
  admin_alert_whatsapp: '',
  admin_alert_events: ['handoff', 'silent_handoff', 'uncertain_send', 'error', 'safety'],
  admin_alert_include_messages: true,
};

const BASE_VAZIA = {
  business_name: '',
  niche: '',
  assistant_name: '',
  tone: 'consultivo',
  solo_identity: false,
  company_summary: '',
  commercial_terms: '',
  golden_rules: '',
  extra_instructions: '',
  escalation_rules: '',
  lock_until_manual_resume: false,
  prompt_shield_enabled: true,
  robot_question_policy: 'handoff',
  approved_messages: [],
  operational_skills: [],
  humanization_skills: [],
  objections: [],
  brain_pack: {},
};

const LIMITES_DE_TEXTO = {
  label: 60,
  business_name: 120,
  niche: 120,
  assistant_name: 60,
  company_summary: 4000,
  commercial_terms: 4000,
  golden_rules: 8000,
  extra_instructions: 4000,
  escalation_rules: 4000,
};
const LIGA_DESLIGA = ['solo_identity', 'lock_until_manual_resume', 'prompt_shield_enabled'];
const TONS = ['consultivo', 'acolhedor', 'descontraido', 'profissional', 'formal'];
const NOME_DE_MODELO = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
const TEXTO_CIFRADO = /^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22}[.][A-Za-z0-9_-]+$/;

/** Conta caracteres como o Postgres (por letra, não por pedaço de emoji). */
const tamanho = (texto) => Array.from(texto).length;

/**
 * O cenário de exemplo: a "Empresa da Inbox" já tem a chave do Gemini cadastrada e duas bases de
 * treinamento (a Principal, preenchida, e a de Suporte, usada pelo chip Suporte). As outras empresas
 * começam sem nada, como uma conta recém-criada.
 */
function cenarioInicial() {
  const dona = USUARIOS[6].id;
  const base = (id, label, padrao, campos, criadaEm) => ({
    workspace_id: WORKSPACE_INBOX,
    id,
    label,
    is_default: padrao,
    ...BASE_VAZIA,
    ...campos,
    created_at: criadaEm,
    updated_at: criadaEm,
    updated_by: dona,
    revision: 1,
  });
  const pergunta = (numero, agentId, posicao, question, answer, source = 'manual') => ({
    workspace_id: WORKSPACE_INBOX,
    agent_id: agentId,
    id: `e2000000-0000-4000-8000-${String(numero).padStart(12, '0')}`,
    position: posicao,
    question,
    answer,
    source,
  });

  return {
    configuracoes: new Map(),
    chaves: new Map([
      [
        `${WORKSPACE_INBOX}:gemini`,
        { ciphertext: cifrarComoOPainel(CHAVE_GEMINI_DE_TESTE, WORKSPACE_INBOX, 'gemini'), key_hint: CHAVE_GEMINI_DE_TESTE.slice(-4), updated_at: '2026-11-10T14:00:00Z' },
      ],
    ]),
    bases: [
      base(
        BASE_PRINCIPAL_DA_INBOX,
        'Principal',
        true,
        {
          business_name: 'Flor de Sal Moda',
          niche: 'Moda feminina',
          assistant_name: 'Lia',
          tone: 'acolhedor',
          company_summary:
            'Loja de moda feminina em Fortaleza, no bairro Aldeota. Vendemos vestidos, blusas, saias e acessórios, do P ao GG.\nAtendemos de segunda a sábado, das 9h às 18h.',
          commercial_terms:
            'Aceitamos PIX, cartão em até 3x sem juros e dinheiro na retirada.\nEntregamos em toda Fortaleza. O frete é R$ 10,00 e sai grátis em compras acima de R$ 200,00.\nTrocas em até 7 dias, com a etiqueta.',
          golden_rules:
            'Nunca prometa prazo de entrega para o mesmo dia.\nNão dê desconto por conta própria: passe para a dona.\nSe a cliente pedir uma peça que não está na lista, diga que vai conferir no estoque e passe para a dona.',
        },
        '2026-11-01T12:00:00Z',
      ),
      base(
        BASE_DE_SUPORTE_DA_INBOX,
        'Suporte',
        false,
        {
          business_name: 'Flor de Sal Moda',
          niche: 'Moda feminina',
          assistant_name: 'Lia',
          tone: 'profissional',
          company_summary: 'Atendimento de quem já comprou: trocas, devoluções e acompanhamento de entrega.',
          golden_rules: 'Peça sempre o número do pedido antes de qualquer coisa.',
          lock_until_manual_resume: true,
        },
        '2026-11-05T12:00:00Z',
      ),
    ],
    perguntas: [
      pergunta(1, BASE_PRINCIPAL_DA_INBOX, 0, 'Vocês entregam no centro?', 'Entregamos em toda Fortaleza, inclusive no Centro. O frete é R$ 10,00.'),
      pergunta(2, BASE_PRINCIPAL_DA_INBOX, 1, 'Qual o valor do frete?', 'O frete é R$ 10,00 para toda Fortaleza, e sai grátis em compras acima de R$ 200,00.'),
      pergunta(3, BASE_PRINCIPAL_DA_INBOX, 2, 'Posso trocar se não servir?', 'Pode sim. A troca é em até 7 dias, com a etiqueta na peça.', 'correction'),
    ],
    documentos: [
      {
        workspace_id: WORKSPACE_INBOX,
        agent_id: BASE_PRINCIPAL_DA_INBOX,
        id: ARQUIVO_DE_EXEMPLO_DA_INBOX,
        title: 'tabela-de-precos.csv',
        content: 'produto,tamanhos,preco\nVestido midi floral,P M G,R$ 189,90\nBlusa de linho,P M G GG,R$ 119,90\nSaia plissada,P M G,R$ 139,90\nBolsa de palha,único,R$ 89,90',
        created_at: '2026-11-02T12:00:00Z',
      },
    ],
    /** chip → base escolhida para ele (quem não está aqui usa a base padrão). */
    baseDoChip: new Map([[CHIP_SUPORTE, BASE_DE_SUPORTE_DA_INBOX]]),
  };
}

export const FUNCOES_DA_IA = [
  'read_my_ai_settings',
  'save_my_ai_settings',
  'save_my_ai_key',
  'delete_my_ai_key',
  'read_my_ai_key_ciphertext',
  'read_my_ai_agents',
  'read_my_ai_agent',
  'save_my_ai_agent',
  'set_my_default_ai_agent',
  'delete_my_ai_agent',
  'add_my_ai_agent_document',
  'delete_my_ai_agent_document',
  'set_my_instance_ai_agent',
  'teach_my_ai_from_message',
];

/**
 * @param {{ tabelas: Record<string, any[]>, responder: (res: any, status: number, corpo: unknown) => void }} apoio
 */
export function criarIaDoBanco({ tabelas, responder }) {
  let estado = cenarioInicial();

  const papelDe = (usuario, workspaceId) =>
    PARTICIPACOES.find((p) => p.user_id === usuario.id && p.workspace_id === workspaceId && p.status === 'active')?.role ?? null;

  const lerConfiguracoes = (workspaceId, ehDono) => {
    const gravadas = estado.configuracoes.get(workspaceId);
    const chaves = {};
    for (const provedor of PROVEDORES) {
      const chave = estado.chaves.get(`${workspaceId}:${provedor}`);
      if (chave) chaves[provedor] = { configured: true, hint: ehDono ? chave.key_hint : null, updated_at: chave.updated_at };
    }
    return { ...PADROES, updated_at: null, ...gravadas, keys: chaves, can_edit: ehDono };
  };

  const baseEmJson = (base, comConteudo) => ({
    id: base.id,
    label: base.label,
    is_default: base.is_default,
    ...Object.fromEntries(Object.keys(BASE_VAZIA).map((campo) => [campo, base[campo]])),
    updated_at: base.updated_at,
    revision: base.revision ?? 1,
    faqs: estado.perguntas
      .filter((item) => item.agent_id === base.id)
      .sort((a, b) => a.position - b.position)
      .map(({ id, question, answer, source }) => ({ id, question, answer, source })),
    documents: estado.documentos
      .filter((item) => item.agent_id === base.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((documento) => ({
        id: documento.id,
        title: documento.title,
        char_count: tamanho(documento.content),
        created_at: documento.created_at,
        ...(comConteudo ? { content: documento.content } : {}),
      })),
  });

  const listaDeBases = (workspaceId, ehDono) => {
    const chips = tabelas.instances
      .filter((chip) => chip.workspace_id === workspaceId && chip.status !== 'revoked')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return {
      can_edit: ehDono,
      agents: estado.bases
        .filter((base) => base.workspace_id === workspaceId)
        .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.created_at.localeCompare(b.created_at))
        .map((base) => ({
          id: base.id,
          label: base.label,
          is_default: base.is_default,
          business_name: base.business_name,
          updated_at: base.updated_at,
          faq_count: estado.perguntas.filter((item) => item.agent_id === base.id).length,
          document_count: estado.documentos.filter((item) => item.agent_id === base.id).length,
          instances: chips
            .filter((chip) => {
              const escolhida = estado.baseDoChip.get(chip.id) ?? null;
              return escolhida === base.id || (escolhida === null && base.is_default);
            })
            .map((chip) => ({ id: chip.id, display_name: chip.display_name })),
        })),
    };
  };

  function acoesDaIa(res, usuario, nome, corpo) {
    const erro = (status, code, message) => responder(res, status, { code, details: null, hint: null, message });
    const invalido = (campo) => erro(400, '22023', `Invalid ${campo}`);
    const workspaceId = corpo.p_workspace_id;
    const papel = papelDe(usuario, workspaceId);
    const ehDono = papel === 'owner';
    const agora = () => new Date().toISOString();
    const baseDaEmpresa = (id) => estado.bases.find((base) => base.workspace_id === workspaceId && base.id === id);

    const LEITURAS = ['read_my_ai_settings', 'read_my_ai_agents', 'read_my_ai_agent'];
    if (LEITURAS.includes(nome)) {
      if (!papel) return erro(403, '42501', 'Workspace membership required');
    } else if (!ehDono) {
      return erro(403, '42501', 'Workspace owner required');
    }

    /* ---------- Motor de IA ---------- */

    if (nome === 'read_my_ai_settings') return responder(res, 200, lerConfiguracoes(workspaceId, ehDono));

    if (nome === 'save_my_ai_settings') {
      const mudancas = corpo.p_settings;
      if (!mudancas || typeof mudancas !== 'object' || Array.isArray(mudancas)) return invalido('settings');
      for (const campo of Object.keys(mudancas)) {
        if (!(campo in PADROES)) return erro(400, '22023', `Unknown setting: ${campo.slice(0, 60)}`);
      }
      const novo = { ...PADROES, ...estado.configuracoes.get(workspaceId), ...mudancas };
      delete novo.updated_at;
      const inteiroEntre = (valor, minimo, maximo) => Number.isInteger(valor) && valor >= minimo && valor <= maximo;
      if (!PROVEDORES.includes(novo.provider)) return invalido('provider');
      if (![...PROVEDORES, 'none'].includes(novo.fallback_provider)) return invalido('fallback_provider');
      if (![...PROVEDORES, 'none'].includes(novo.second_fallback_provider)) return invalido('second_fallback_provider');
      // Igual ao banco: a ordem não repete provedor, e não existe segunda reserva sem a primeira.
      if (
        novo.fallback_provider === novo.provider ||
        novo.second_fallback_provider === novo.provider ||
        (novo.second_fallback_provider !== 'none' && (novo.fallback_provider === 'none' || novo.second_fallback_provider === novo.fallback_provider))
      ) {
        return invalido('provider order');
      }
      for (const campo of ['gemini_model', 'openrouter_model', 'nvidia_model']) {
        if (typeof novo[campo] !== 'string' || !NOME_DE_MODELO.test(novo[campo])) return invalido(campo);
      }
      if (typeof novo.temperature !== 'number' || !(novo.temperature >= 0 && novo.temperature <= 1)) return invalido('temperature');
      if (!inteiroEntre(novo.max_history_messages, 4, 60)) return invalido('max_history_messages');
      if (!inteiroEntre(novo.debounce_seconds, 1, 20)) return invalido('debounce_seconds');
      if (!inteiroEntre(novo.human_pause_minutes, 5, 1440)) return invalido('human_pause_minutes');
      for (const campo of ['simulate_typing', 'split_long_messages', 'pause_on_human_reply', 'admin_alert_enabled', 'admin_alert_include_messages']) {
        if (typeof novo[campo] !== 'boolean') return invalido(campo);
      }
      if (typeof novo.admin_alert_whatsapp !== 'string' || (novo.admin_alert_whatsapp !== '' && !/^[0-9]{10,15}$/.test(novo.admin_alert_whatsapp))) {
        return invalido('admin_alert_whatsapp');
      }
      if (!Array.isArray(novo.admin_alert_events)) return invalido('admin_alert_events');
      const EVENTOS_VALIDOS = new Set(['handoff', 'silent_handoff', 'uncertain_send', 'error', 'safety']);
      if (novo.admin_alert_events.some((ev) => !EVENTOS_VALIDOS.has(ev))) return invalido('admin_alert_events');
      novo.admin_alert_events = Array.from(new Set(novo.admin_alert_events));
      novo.temperature = Math.round(novo.temperature * 100) / 100;
      estado.configuracoes.set(workspaceId, { ...novo, updated_at: agora() });
      return responder(res, 200, lerConfiguracoes(workspaceId, true));
    }

    if (['save_my_ai_key', 'delete_my_ai_key', 'read_my_ai_key_ciphertext'].includes(nome)) {
      const provedor = corpo.p_provider;
      const lugar = `${workspaceId}:${provedor}`;
      if (nome === 'read_my_ai_key_ciphertext') return responder(res, 200, estado.chaves.get(lugar)?.ciphertext ?? null);
      if (!PROVEDORES.includes(provedor)) return invalido('provider');
      if (nome === 'delete_my_ai_key') {
        estado.chaves.delete(lugar);
        return responder(res, 200, lerConfiguracoes(workspaceId, true));
      }
      const cifra = corpo.p_ciphertext;
      // Igual ao banco: o que não tem a forma de um texto cifrado pelo painel não entra (texto puro nunca é gravado).
      if (typeof cifra !== 'string' || !TEXTO_CIFRADO.test(cifra) || cifra.length < 50 || cifra.length > 1600) return invalido('ciphertext');
      if (typeof corpo.p_key_hint !== 'string' || !/^[A-Za-z0-9._-]{1,8}$/.test(corpo.p_key_hint)) return invalido('key hint');
      estado.chaves.set(lugar, { ciphertext: cifra, key_hint: corpo.p_key_hint, updated_at: agora() });
      return responder(res, 200, lerConfiguracoes(workspaceId, true));
    }

    /* ---------- Treinamento ---------- */

    if (nome === 'read_my_ai_agents') return responder(res, 200, listaDeBases(workspaceId, ehDono));

    if (nome === 'read_my_ai_agent') {
      const base = baseDaEmpresa(corpo.p_agent_id);
      if (!base) return erro(400, 'P0002', 'Agent not found');
      return responder(res, 200, { ...baseEmJson(base, corpo.p_include_content === true), can_edit: ehDono });
    }

    if (nome === 'save_my_ai_agent') {
      const dados = corpo.p_data;
      if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return invalido('agent data');
      const limpos = {};
      let perguntas = null;
      let revisaoEsperada = null;
      for (const [campo, valor] of Object.entries(dados)) {
        if (campo === 'expected_revision') {
          // A revisão que a tela tinha quando abriu a base (não é um campo da base).
          if (!Number.isInteger(valor) || valor < 1) return invalido('expected_revision');
          revisaoEsperada = valor;
        } else if (campo in LIMITES_DE_TEXTO) {
          if (typeof valor !== 'string' || tamanho(valor.trim()) > LIMITES_DE_TEXTO[campo]) return invalido(campo);
          limpos[campo] = valor.trim();
        } else if (LIGA_DESLIGA.includes(campo)) {
          if (typeof valor !== 'boolean') return invalido(campo);
          limpos[campo] = valor;
        } else if (campo === 'tone') {
          if (!TONS.includes(valor)) return invalido('tone');
          limpos.tone = valor;
        } else if (campo === 'robot_question_policy') {
          if (!['handoff', 'disclose'].includes(valor)) return invalido('robot_question_policy');
          limpos.robot_question_policy = valor;
        } else if (['approved_messages', 'operational_skills', 'humanization_skills', 'objections'].includes(campo)) {
          if (!Array.isArray(valor)) return invalido(campo);
          limpos[campo] = valor;
        } else if (campo === 'brain_pack') {
          if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return invalido('brain_pack');
          limpos.brain_pack = valor;
        } else if (campo === 'faqs') {
          if (!Array.isArray(valor) || valor.length > 100) return invalido('faqs');
          perguntas = [];
          for (const item of valor) {
            if (!item || typeof item !== 'object' || typeof item.question !== 'string' || typeof item.answer !== 'string') return invalido('faqs');
            const question = item.question.trim();
            const answer = item.answer.trim();
            if (tamanho(question) < 1 || tamanho(question) > 500 || tamanho(answer) < 1 || tamanho(answer) > 2000) return invalido('faqs');
            perguntas.push({ question, answer, source: ['correction', 'template'].includes(item.source) ? item.source : 'manual' });
          }
        } else {
          return erro(400, '22023', `Unknown agent field: ${campo.slice(0, 60)}`);
        }
      }
      if ('label' in limpos && limpos.label === '') return invalido('label');

      const daEmpresa = estado.bases.filter((base) => base.workspace_id === workspaceId);
      const agentId = corpo.p_agent_id ?? null;
      if ('label' in limpos && daEmpresa.some((base) => base.id !== agentId && base.label.toLowerCase() === limpos.label.toLowerCase())) {
        return erro(400, 'P0001', 'agent_label_taken');
      }

      let base;
      if (agentId === null) {
        if (daEmpresa.length >= 10) return erro(400, 'P0001', 'agent_limit_reached');
        if (!('label' in limpos)) {
          if (daEmpresa.length > 0) return invalido('label');
          limpos.label = 'Principal';
        }
        // A primeira base da empresa já nasce como a padrão.
        base = { workspace_id: workspaceId, id: crypto.randomUUID(), label: limpos.label, is_default: daEmpresa.length === 0, ...BASE_VAZIA, created_at: agora(), revision: 1 };
        estado.bases.push(base);
      } else {
        base = baseDaEmpresa(agentId);
        if (!base) return erro(400, 'P0002', 'Agent not found');
        // A base mudou depois que a tela abriu (outra aba, ou uma resposta ensinada pela Inbox): recusa.
        if (revisaoEsperada !== null && (base.revision ?? 1) !== revisaoEsperada) return erro(400, 'P0001', 'agent_changed');
        base.revision = (base.revision ?? 1) + 1;
      }
      Object.assign(base, limpos, { updated_at: agora(), updated_by: usuario.id });

      if (perguntas) {
        estado.perguntas = estado.perguntas.filter((item) => item.agent_id !== base.id);
        perguntas.forEach((item, posicao) => {
          estado.perguntas.push({ workspace_id: workspaceId, agent_id: base.id, id: crypto.randomUUID(), position: posicao, ...item });
        });
      }
      return responder(res, 200, { ...baseEmJson(base, false), can_edit: true });
    }

    if (nome === 'set_my_default_ai_agent') {
      const base = baseDaEmpresa(corpo.p_agent_id);
      if (!base) return erro(400, 'P0002', 'Agent not found');
      for (const outra of estado.bases) if (outra.workspace_id === workspaceId) outra.is_default = outra.id === base.id;
      return responder(res, 200, listaDeBases(workspaceId, true));
    }

    if (nome === 'delete_my_ai_agent') {
      const base = baseDaEmpresa(corpo.p_agent_id);
      if (!base) return erro(400, 'P0002', 'Agent not found');
      if (base.is_default) return erro(400, 'P0001', 'default_agent_required');
      estado.bases = estado.bases.filter((item) => item.id !== base.id);
      estado.perguntas = estado.perguntas.filter((item) => item.agent_id !== base.id);
      estado.documentos = estado.documentos.filter((item) => item.agent_id !== base.id);
      // Os chips que usavam a base apagada voltam a usar a padrão.
      for (const [chip, escolhida] of estado.baseDoChip) if (escolhida === base.id) estado.baseDoChip.delete(chip);
      return responder(res, 200, listaDeBases(workspaceId, true));
    }

    if (nome === 'add_my_ai_agent_document') {
      const titulo = String(corpo.p_title ?? '').trim();
      const conteudo = String(corpo.p_content ?? '').trim();
      if (tamanho(titulo) < 1 || tamanho(titulo) > 160) return invalido('title');
      if (tamanho(conteudo) < 1) return erro(400, 'P0001', 'document_empty');
      if (tamanho(conteudo) > 30000) return erro(400, 'P0001', 'document_too_large');
      const base = baseDaEmpresa(corpo.p_agent_id);
      if (!base) return erro(400, 'P0002', 'Agent not found');
      const jaAnexados = estado.documentos.filter((item) => item.agent_id === base.id);
      if (jaAnexados.length >= 10) return erro(400, 'P0001', 'document_limit_reached');
      if (jaAnexados.reduce((soma, item) => soma + tamanho(item.content), 0) + tamanho(conteudo) > 120000) {
        return erro(400, 'P0001', 'document_space_exceeded');
      }
      estado.documentos.push({ workspace_id: workspaceId, agent_id: base.id, id: crypto.randomUUID(), title: titulo, content: conteudo, created_at: agora() });
      base.updated_at = agora();
      return responder(res, 200, { ...baseEmJson(base, false), can_edit: true });
    }

    if (nome === 'delete_my_ai_agent_document') {
      const documento = estado.documentos.find((item) => item.workspace_id === workspaceId && item.id === corpo.p_document_id);
      if (!documento) return erro(400, 'P0002', 'Document not found');
      estado.documentos = estado.documentos.filter((item) => item.id !== documento.id);
      const base = baseDaEmpresa(documento.agent_id);
      base.updated_at = agora();
      return responder(res, 200, { ...baseEmJson(base, false), can_edit: true });
    }

    if (nome === 'set_my_instance_ai_agent') {
      const agentId = corpo.p_agent_id ?? null;
      if (agentId !== null && !baseDaEmpresa(agentId)) return erro(400, 'P0002', 'Agent not found');
      const chip = tabelas.instances.find((item) => item.workspace_id === workspaceId && item.id === corpo.p_instance_id && item.status !== 'revoked');
      if (!chip) return erro(400, 'P0002', 'Instance not found');
      if (agentId === null) estado.baseDoChip.delete(chip.id);
      else estado.baseDoChip.set(chip.id, agentId);
      return responder(res, 200, listaDeBases(workspaceId, true));
    }

    if (nome === 'teach_my_ai_from_message') {
      const destino = corpo.p_target;
      if (destino !== 'faq' && destino !== 'rule') return invalido('target');
      const pergunta = String(corpo.p_question ?? '').trim();
      const resposta = String(corpo.p_answer ?? '').trim();
      if (destino === 'faq' && (tamanho(pergunta) < 1 || tamanho(pergunta) > 500)) return invalido('question');
      if (tamanho(resposta) < 1 || tamanho(resposta) > (destino === 'faq' ? 2000 : 1000)) return invalido('answer');

      const mensagem = tabelas.messages.find((item) => item.workspace_id === workspaceId && item.id === corpo.p_message_id);
      if (!mensagem) return erro(400, 'P0002', 'Message not found');
      // A base que o chip da mensagem usa; sem base própria, a padrão da empresa.
      const escolhida = estado.baseDoChip.get(mensagem.instance_id) ?? null;
      const base = estado.bases.find((item) => item.workspace_id === workspaceId && (escolhida ? item.id === escolhida : item.is_default));
      if (!base) return erro(400, 'P0001', 'ai_training_missing');
      const daBase = () => estado.perguntas.filter((item) => item.agent_id === base.id).sort((a, b) => a.position - b.position);

      let resultado = 'added';
      if (destino === 'faq') {
        let ensinada = daBase().find((item) => item.question.toLowerCase() === pergunta.toLowerCase());
        if (ensinada) {
          resultado = 'replaced';
          Object.assign(ensinada, { question: pergunta, answer: resposta, source: 'correction' });
        } else {
          if (daBase().length >= 100) return erro(400, 'P0001', 'faq_limit_reached');
          ensinada = { workspace_id: workspaceId, agent_id: base.id, id: crypto.randomUUID(), position: 0, question: pergunta, answer: resposta, source: 'correction' };
          estado.perguntas.push(ensinada);
        }
        // A pergunta ensinada passa a ser a primeira; as outras continuam na ordem em que estavam.
        [ensinada, ...daBase().filter((item) => item !== ensinada)].forEach((item, posicao) => {
          item.position = posicao;
        });
      } else {
        const linha = `- ${resposta.replace(/\s+/g, ' ')}`;
        if (base.golden_rules.toLowerCase().includes(linha.toLowerCase())) {
          return responder(res, 200, { agent_id: base.id, agent_label: base.label, target: destino, result: 'unchanged', revision: base.revision ?? 1 });
        }
        const regras = base.golden_rules === '' ? linha : `${base.golden_rules}\n${linha}`;
        if (tamanho(regras) > 8000) return erro(400, 'P0001', 'rules_limit_reached');
        base.golden_rules = regras;
      }
      base.revision = (base.revision ?? 1) + 1;
      Object.assign(base, { updated_at: agora(), updated_by: usuario.id });
      return responder(res, 200, { agent_id: base.id, agent_label: base.label, target: destino, result: resultado, revision: base.revision });
    }

    return erro(404, 'PGRST202', `Função não imitada: ${nome}`);
  }

  return {
    acoesDaIa,
    /**
     * O que falta para a IA poder ser ligada num chip, como o banco de verdade responde:
     * 'ai_key_missing' (sem a chave do provedor principal), 'ai_training_missing' (sem base de treinamento) ou null.
     */
    faltaParaAIa(workspaceId, chipId = null) {
      const principal = estado.configuracoes.get(workspaceId)?.provider ?? PADROES.provider;
      if (!estado.chaves.has(`${workspaceId}:${principal}`)) return 'ai_key_missing';
      const baseDoChip = chipId ? estado.baseDoChip.get(chipId) : null;
      const temBase = estado.bases.some((base) => base.workspace_id === workspaceId && (base.is_default || base.id === baseDoChip));
      return temBase ? null : 'ai_training_missing';
    },
    /** Só para os testes: põe o Motor de IA e o Treinamento de volta no começo. */
    reiniciarIa() {
      estado = cenarioInicial();
    },
  };
}
