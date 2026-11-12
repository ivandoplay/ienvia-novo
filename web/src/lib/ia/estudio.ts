/**
 * Estúdio de Mensagens, Skills, Objeções, Cérebro Completo e Pacote Turbo (.zip / .json).
 *
 * Código puro (sem banco, sem `node:*` e sem navegador): roda igual no servidor Next.js,
 * no navegador (prévia/exportação) e na Supabase Edge Function (Deno) ao selecionar o contexto do turno.
 */

export type ModoDeContextoDoCerebro = 'inteligente' | 'completo';

export interface MensagemAprovada {
  id: string;
  titulo: string;
  categoria: string;
  texto: string;
  ativa: boolean;
}

export interface SkillOperacional {
  id: string;
  nome: string;
  quando: string;
  exemploDeResposta: string;
  conteudoMd: string;
  ativa: boolean;
}

export interface SkillDeHumanizacao {
  id: string;
  nome: string;
  gatilho: string;
  objetivo: string;
  evitar: string;
  respostaRuim: string;
  respostaMelhor: string;
  conteudoMd: string;
  ativa: boolean;
}

export interface ObjecaoDeAtendimento {
  id: string;
  padraoDeEntrada: string;
  natureza: string;
  skillId: string;
  estrategiaDeResposta: string;
  evitar: string;
  ativa: boolean;
}

export interface PersonaDoCerebro {
  id: string;
  nome: string;
  sinais: string;
  conteudoMd: string;
}

export interface ParBomRuim {
  id: string;
  titulo: string;
  contexto: string;
  naoUsar: string;
  melhorResposta: string;
  licao: string;
}

export interface RespostaDeReferencia {
  id: string;
  titulo: string;
  quando: string;
  exemploEntrada: string;
  skillId: string;
  cuidado: string;
  comportamento: string;
}

export interface CerebroCompleto {
  id: string;
  nome: string;
  versao: string;
  importadoEm: string | null;
  modoDeContexto: ModoDeContextoDoCerebro;
  playbookCentral: string;
  regrasCanonicas: string;
  fatosDoNegocio: Record<string, unknown>;
  filtrosDeVoz: string[];
  personas: PersonaDoCerebro[];
  paresBomRuim: ParBomRuim[];
  respostasDeReferencia: RespostaDeReferencia[];
}

export interface DadosDoEstudio {
  mensagensAprovadas: MensagemAprovada[];
  habilidadesOperacionais: SkillOperacional[];
  habilidadesDeHumanizacao: SkillDeHumanizacao[];
  objecoes: ObjecaoDeAtendimento[];
  cerebroCompleto: CerebroCompleto | null;
}

export const LIMITES_DO_ESTUDIO = {
  mensagensAprovadas: 100,
  habilidadesOperacionais: 100,
  habilidadesDeHumanizacao: 100,
  objecoes: 150,
  id: 60,
  titulo: 160,
  categoria: 80,
  textoDaMensagem: 4000,
  nomeDaSkill: 200,
  quando: 500,
  exemploDeResposta: 2000,
  conteudoMd: 8000,
  padraoDeEntrada: 500,
  estrategia: 2000,
  playbookCentral: 12_000,
  regrasCanonicas: 12_000,
  arquivoZipBytes: 4 * 1024 * 1024,
  expandidoZipBytes: 8 * 1024 * 1024,
  entradasZip: 250,
} as const;

type Json = Record<string, unknown>;
const objeto = (valor: unknown): Json => (valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Json) : {});
const lista = (valor: unknown): unknown[] => (Array.isArray(valor) ? valor : []);
const txt = (valor: unknown): string => (typeof valor === 'string' ? valor : '');
const aparar = (valor: string): string => valor.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
const cortar = (valor: string, maximo: number): string => {
  const limpo = aparar(valor.replace(/\u0000/g, ''));
  return Array.from(limpo).length <= maximo ? limpo : Array.from(limpo).slice(0, maximo).join('');
};

export const ESTUDIO_VAZIO: DadosDoEstudio = {
  mensagensAprovadas: [],
  habilidadesOperacionais: [],
  habilidadesDeHumanizacao: [],
  objecoes: [],
  cerebroCompleto: null,
};

export function gerarProximoCodigo(itens: ReadonlyArray<{ id: string }>, prefixo: 'M' | 'S' | 'H' | 'O', casas = 2): string {
  const existentes = new Set(itens.map((item) => item.id.trim().toUpperCase()));
  for (let n = 1; n <= 999; n += 1) {
    const candidato = `${prefixo}${String(n).padStart(casas, '0')}`;
    if (!existentes.has(candidato)) return candidato;
  }
  return `${prefixo}${Date.now().toString().slice(-4)}`;
}

// =============================================================================================
// Leitura e gravação no formato do banco (snake_case ↔ camelCase)
// =============================================================================================

function lerMensagem(bruto: unknown, indice: number): MensagemAprovada | null {
  const d = objeto(bruto);
  const texto = cortar(txt(d.texto) || txt(d.text), LIMITES_DO_ESTUDIO.textoDaMensagem);
  if (!texto) return null;
  const id = cortar(txt(d.id) || `M${String(indice + 1).padStart(2, '0')}`, LIMITES_DO_ESTUDIO.id);
  return {
    id: id || `M${String(indice + 1).padStart(2, '0')}`,
    titulo: cortar(txt(d.titulo) || txt(d.title) || id, LIMITES_DO_ESTUDIO.titulo) || id,
    categoria: cortar(txt(d.categoria) || txt(d.category), LIMITES_DO_ESTUDIO.categoria),
    texto,
    ativa: d.ativa !== false && d.enabled !== false,
  };
}

function lerSkillOp(bruto: unknown, indice: number): SkillOperacional | null {
  const d = objeto(bruto);
  const nome = cortar(txt(d.nome) || txt(d.name) || txt(d.titulo), LIMITES_DO_ESTUDIO.nomeDaSkill);
  if (!nome) return null;
  const id = cortar(txt(d.id) || `S${String(indice + 1).padStart(2, '0')}`, LIMITES_DO_ESTUDIO.id);
  return {
    id: id || `S${String(indice + 1).padStart(2, '0')}`,
    nome,
    quando: cortar(txt(d.quando) || txt(d.when), LIMITES_DO_ESTUDIO.quando),
    exemploDeResposta: cortar(txt(d.exemploDeResposta) || txt(d.example_response), LIMITES_DO_ESTUDIO.exemploDeResposta),
    conteudoMd: cortar(txt(d.conteudoMd) || txt(d.body_md) || txt(d.bodyMd), LIMITES_DO_ESTUDIO.conteudoMd),
    ativa: d.ativa !== false && d.enabled !== false,
  };
}

function lerSkillHum(bruto: unknown, indice: number): SkillDeHumanizacao | null {
  const d = objeto(bruto);
  const nome = cortar(txt(d.nome) || txt(d.name) || txt(d.titulo), LIMITES_DO_ESTUDIO.nomeDaSkill);
  if (!nome) return null;
  const id = cortar(txt(d.id) || `H${String(indice + 1).padStart(2, '0')}`, LIMITES_DO_ESTUDIO.id);
  return {
    id: id || `H${String(indice + 1).padStart(2, '0')}`,
    nome,
    gatilho: cortar(txt(d.gatilho) || txt(d.trigger), LIMITES_DO_ESTUDIO.quando),
    objetivo: cortar(txt(d.objetivo) || txt(d.goal), LIMITES_DO_ESTUDIO.quando),
    evitar: cortar(txt(d.evitar) || txt(d.avoid), LIMITES_DO_ESTUDIO.quando),
    respostaRuim: cortar(txt(d.respostaRuim) || txt(d.bad_response), LIMITES_DO_ESTUDIO.exemploDeResposta),
    respostaMelhor: cortar(txt(d.respostaMelhor) || txt(d.better_response), LIMITES_DO_ESTUDIO.exemploDeResposta),
    conteudoMd: cortar(txt(d.conteudoMd) || txt(d.body_md) || txt(d.bodyMd), LIMITES_DO_ESTUDIO.conteudoMd),
    ativa: d.ativa !== false && d.enabled !== false,
  };
}

function lerObjecao(bruto: unknown, indice: number): ObjecaoDeAtendimento | null {
  const d = objeto(bruto);
  const padraoDeEntrada = cortar(txt(d.padraoDeEntrada) || txt(d.input_pattern), LIMITES_DO_ESTUDIO.padraoDeEntrada);
  if (!padraoDeEntrada) return null;
  const id = cortar(txt(d.id) || `O${String(indice + 1).padStart(3, '0')}`, LIMITES_DO_ESTUDIO.id);
  return {
    id: id || `O${String(indice + 1).padStart(3, '0')}`,
    padraoDeEntrada,
    natureza: cortar(txt(d.natureza) || txt(d.nature), 160),
    skillId: cortar(txt(d.skillId) || txt(d.skill_id), LIMITES_DO_ESTUDIO.id),
    estrategiaDeResposta: cortar(txt(d.estrategiaDeResposta) || txt(d.response_strategy), LIMITES_DO_ESTUDIO.estrategia),
    evitar: cortar(txt(d.evitar) || txt(d.avoid), LIMITES_DO_ESTUDIO.estrategia),
    ativa: d.ativa !== false && d.enabled !== false,
  };
}

export function lerCerebro(bruto: unknown): CerebroCompleto | null {
  const d = objeto(bruto);
  if (Object.keys(d).length === 0) return null;
  const id = cortar(txt(d.id), 100);
  const nome = cortar(txt(d.nome) || txt(d.name), 200);
  const playbookCentral = cortar(txt(d.playbookCentral) || txt(d.playbook_central), LIMITES_DO_ESTUDIO.playbookCentral);
  const regrasCanonicas = cortar(txt(d.regrasCanonicas) || txt(d.canonical_rules), LIMITES_DO_ESTUDIO.regrasCanonicas);
  const filtrosDeVoz = lista(d.filtrosDeVoz ?? d.voice_filters).map((x) => cortar(txt(x), 300)).filter(Boolean).slice(0, 30);
  const personas = lista(d.personas ?? d.interlocutor_profiles)
    .map((raw, i) => {
      const p = objeto(raw);
      const pn = cortar(txt(p.nome) || txt(p.name), 160);
      if (!pn) return null;
      return {
        id: cortar(txt(p.id) || `P${String(i + 1).padStart(2, '0')}`, 60),
        nome: pn,
        sinais: cortar(txt(p.sinais) || txt(p.signals), 600),
        conteudoMd: cortar(txt(p.conteudoMd) || txt(p.body_md) || txt(p.bodyMd), 4000),
      };
    })
    .filter((x): x is PersonaDoCerebro => x !== null)
    .slice(0, 20);
  const paresBomRuim = lista(d.paresBomRuim ?? d.good_bad_pairs)
    .map((raw, i) => {
      const p = objeto(raw);
      const titulo = cortar(txt(p.titulo) || txt(p.title), 160);
      if (!titulo) return null;
      return {
        id: cortar(txt(p.id) || `B${String(i + 1).padStart(2, '0')}`, 60),
        titulo,
        contexto: cortar(txt(p.contexto) || txt(p.context), 400),
        naoUsar: cortar(txt(p.naoUsar) || txt(p.do_not_use), 1000),
        melhorResposta: cortar(txt(p.melhorResposta) || txt(p.better_response), 1000),
        licao: cortar(txt(p.licao) || txt(p.lesson), 600),
      };
    })
    .filter((x): x is ParBomRuim => x !== null)
    .slice(0, 40);
  const respostasDeReferencia = lista(d.respostasDeReferencia ?? d.reference_responses)
    .map((raw, i) => {
      const r = objeto(raw);
      const titulo = cortar(txt(r.titulo) || txt(r.title), 200);
      if (!titulo) return null;
      return {
        id: cortar(txt(r.id) || `R${String(i + 1).padStart(2, '0')}`, 60),
        titulo,
        quando: cortar(txt(r.quando) || txt(r.when), 500),
        exemploEntrada: cortar(txt(r.exemploEntrada) || txt(r.example_input), 500),
        skillId: cortar(txt(r.skillId) || txt(r.skill_id), 60),
        cuidado: cortar(txt(r.cuidado) || txt(r.caution), 500),
        comportamento: cortar(txt(r.comportamento) || txt(r.recommended_behavior) || 'responder', 80),
      };
    })
    .filter((x): x is RespostaDeReferencia => x !== null)
    .slice(0, 80);

  if (!id && !nome && !playbookCentral && !regrasCanonicas && personas.length === 0 && paresBomRuim.length === 0 && respostasDeReferencia.length === 0) {
    return null;
  }

  return {
    id: id || 'cerebro-principal',
    nome: nome || 'Cérebro completo',
    versao: cortar(txt(d.versao) || txt(d.version) || '1.0', 40),
    importadoEm: txt(d.importadoEm) || txt(d.imported_at) || null,
    modoDeContexto: d.modoDeContexto === 'completo' || d.context_mode === 'full' ? 'completo' : 'inteligente',
    playbookCentral,
    regrasCanonicas,
    fatosDoNegocio: objeto(d.fatosDoNegocio ?? d.business_facts),
    filtrosDeVoz,
    personas,
    paresBomRuim,
    respostasDeReferencia,
  };
}

export function lerEstudioDoBanco(dados: unknown): DadosDoEstudio {
  const d = objeto(dados);
  return {
    mensagensAprovadas: lista(d.approved_messages)
      .map((item, idx) => lerMensagem(item, idx))
      .filter((x): x is MensagemAprovada => x !== null)
      .slice(0, LIMITES_DO_ESTUDIO.mensagensAprovadas),
    habilidadesOperacionais: lista(d.operational_skills)
      .map((item, idx) => lerSkillOp(item, idx))
      .filter((x): x is SkillOperacional => x !== null)
      .slice(0, LIMITES_DO_ESTUDIO.habilidadesOperacionais),
    habilidadesDeHumanizacao: lista(d.humanization_skills)
      .map((item, idx) => lerSkillHum(item, idx))
      .filter((x): x is SkillDeHumanizacao => x !== null)
      .slice(0, LIMITES_DO_ESTUDIO.habilidadesDeHumanizacao),
    objecoes: lista(d.objections)
      .map((item, idx) => lerObjecao(item, idx))
      .filter((x): x is ObjecaoDeAtendimento => x !== null)
      .slice(0, LIMITES_DO_ESTUDIO.objecoes),
    cerebroCompleto: lerCerebro(d.brain_pack),
  };
}

export type ConferenciaDoEstudio =
  | {
      ok: true;
      paraOBanco: {
        approved_messages: unknown[];
        operational_skills: unknown[];
        humanization_skills: unknown[];
        objections: unknown[];
        brain_pack: Record<string, unknown>;
      };
    }
  | { ok: false; erro: string; aba: 'mensagens' | 'skills' | 'cerebro' };

export function conferirEstudio(entrada: Partial<DadosDoEstudio>): ConferenciaDoEstudio {
  const mensagens = lista(entrada.mensagensAprovadas);
  if (mensagens.length > LIMITES_DO_ESTUDIO.mensagensAprovadas) {
    return { ok: false, erro: `Cabem até ${LIMITES_DO_ESTUDIO.mensagensAprovadas} mensagens prontas por base.`, aba: 'mensagens' };
  }
  const approved_messages: unknown[] = [];
  const idsMsg = new Set<string>();
  for (const [i, bruto] of mensagens.entries()) {
    const item = lerMensagem(bruto, i);
    if (!item) return { ok: false, erro: `A mensagem pronta ${i + 1} precisa de um código e do texto.`, aba: 'mensagens' };
    if (idsMsg.has(item.id.toUpperCase())) return { ok: false, erro: `Código duplicado nas mensagens prontas: ${item.id}.`, aba: 'mensagens' };
    idsMsg.add(item.id.toUpperCase());
    approved_messages.push({ id: item.id, title: item.titulo, category: item.categoria, text: item.texto, enabled: item.ativa });
  }

  const skillsOp = lista(entrada.habilidadesOperacionais);
  if (skillsOp.length > LIMITES_DO_ESTUDIO.habilidadesOperacionais) {
    return { ok: false, erro: `Cabem até ${LIMITES_DO_ESTUDIO.habilidadesOperacionais} skills operacionais por base.`, aba: 'skills' };
  }
  const operational_skills: unknown[] = [];
  const idsOp = new Set<string>();
  for (const [i, bruto] of skillsOp.entries()) {
    const item = lerSkillOp(bruto, i);
    if (!item) return { ok: false, erro: `A skill operacional ${i + 1} precisa de código e nome.`, aba: 'skills' };
    if (idsOp.has(item.id.toUpperCase())) return { ok: false, erro: `Código duplicado nas skills operacionais: ${item.id}.`, aba: 'skills' };
    idsOp.add(item.id.toUpperCase());
    operational_skills.push({
      id: item.id,
      name: item.nome,
      when: item.quando,
      example_response: item.exemploDeResposta,
      body_md: item.conteudoMd,
      enabled: item.ativa,
    });
  }

  const skillsHum = lista(entrada.habilidadesDeHumanizacao);
  if (skillsHum.length > LIMITES_DO_ESTUDIO.habilidadesDeHumanizacao) {
    return { ok: false, erro: `Cabem até ${LIMITES_DO_ESTUDIO.habilidadesDeHumanizacao} skills de humanização por base.`, aba: 'skills' };
  }
  const humanization_skills: unknown[] = [];
  const idsHum = new Set<string>();
  for (const [i, bruto] of skillsHum.entries()) {
    const item = lerSkillHum(bruto, i);
    if (!item) return { ok: false, erro: `A skill de humanização ${i + 1} precisa de código e nome.`, aba: 'skills' };
    if (idsHum.has(item.id.toUpperCase())) return { ok: false, erro: `Código duplicado nas skills de humanização: ${item.id}.`, aba: 'skills' };
    idsHum.add(item.id.toUpperCase());
    humanization_skills.push({
      id: item.id,
      name: item.nome,
      trigger: item.gatilho,
      goal: item.objetivo,
      avoid: item.evitar,
      bad_response: item.respostaRuim,
      better_response: item.respostaMelhor,
      body_md: item.conteudoMd,
      enabled: item.ativa,
    });
  }

  const objRaw = lista(entrada.objecoes);
  if (objRaw.length > LIMITES_DO_ESTUDIO.objecoes) {
    return { ok: false, erro: `Cabem até ${LIMITES_DO_ESTUDIO.objecoes} objeções mapeadas por base.`, aba: 'skills' };
  }
  const objections: unknown[] = [];
  const idsObj = new Set<string>();
  for (const [i, bruto] of objRaw.entries()) {
    const item = lerObjecao(bruto, i);
    if (!item) return { ok: false, erro: `A objeção ${i + 1} precisa de código e gatilho/padrão de fala.`, aba: 'skills' };
    if (idsObj.has(item.id.toUpperCase())) return { ok: false, erro: `Código duplicado nas objeções: ${item.id}.`, aba: 'skills' };
    idsObj.add(item.id.toUpperCase());
    objections.push({
      id: item.id,
      input_pattern: item.padraoDeEntrada,
      nature: item.natureza,
      skill_id: item.skillId,
      response_strategy: item.estrategiaDeResposta,
      avoid: item.evitar,
      enabled: item.ativa,
    });
  }

  const cerebro = lerCerebro(entrada.cerebroCompleto);
  const brain_pack: Record<string, unknown> = cerebro
    ? {
        id: cerebro.id,
        name: cerebro.nome,
        version: cerebro.versao,
        imported_at: cerebro.importadoEm,
        context_mode: cerebro.modoDeContexto === 'completo' ? 'full' : 'smart',
        playbook_central: cerebro.playbookCentral,
        canonical_rules: cerebro.regrasCanonicas,
        business_facts: cerebro.fatosDoNegocio,
        voice_filters: cerebro.filtrosDeVoz,
        interlocutor_profiles: cerebro.personas.map((p) => ({
          id: p.id,
          name: p.nome,
          signals: p.sinais,
          body_md: p.conteudoMd,
        })),
        good_bad_pairs: cerebro.paresBomRuim.map((b) => ({
          id: b.id,
          title: b.titulo,
          context: b.contexto,
          do_not_use: b.naoUsar,
          better_response: b.melhorResposta,
          lesson: b.licao,
        })),
        reference_responses: cerebro.respostasDeReferencia.map((r) => ({
          id: r.id,
          title: r.titulo,
          when: r.quando,
          example_input: r.exemploEntrada,
          skill_id: r.skillId,
          caution: r.cuidado,
          recommended_behavior: r.comportamento,
        })),
      }
    : {};

  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  if (bytes(approved_messages) > 260_000) return { ok: false, erro: 'As mensagens prontas passaram do tamanho máximo (256 KB).', aba: 'mensagens' };
  if (bytes(operational_skills) > 390_000) return { ok: false, erro: 'As skills operacionais passaram do tamanho máximo (384 KB).', aba: 'skills' };
  if (bytes(humanization_skills) > 260_000) return { ok: false, erro: 'As skills de humanização passaram do tamanho máximo (256 KB).', aba: 'skills' };
  if (bytes(objections) > 260_000) return { ok: false, erro: 'A matriz de objeções passou do tamanho máximo (256 KB).', aba: 'skills' };
  if (bytes(brain_pack) > 390_000) return { ok: false, erro: 'Os dados do cérebro completo passaram do tamanho máximo (384 KB).', aba: 'cerebro' };

  return {
    ok: true,
    paraOBanco: { approved_messages, operational_skills, humanization_skills, objections, brain_pack },
  };
}

// =============================================================================================
// Seleção inteligente por turno (port fiel + evolução do selectTurnPackContext)
// =============================================================================================

export function dobrarPt(valor: string): string {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const STOPWORDS_PT = new Set([
  'a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'nas', 'nos', 'um', 'uma', 'uns', 'umas',
  'que', 'para', 'pra', 'pro', 'com', 'sem', 'por', 'como', 'mais', 'mas', 'se', 'eu', 'voce', 'vc', 'ele', 'ela',
  'me', 'te', 'seu', 'sua', 'isso', 'isto', 'aqui', 'ali', 'la', 'ja', 'nao', 'sim', 'oi', 'ola', 'bom', 'boa',
  'tudo', 'bem', 'dia', 'tarde', 'noite', 'sobre', 'ser', 'ter', 'tem', 'esta', 'estou', 'ta', 'to', 'pode', 'quero',
]);

interface ClusterDeIntencao {
  gatilhos: readonly string[];
  reforcos: readonly string[];
}

const CLUSTERS_DE_INTENCAO: readonly ClusterDeIntencao[] = [
  { gatilhos: ['quanto custa', 'valor', 'preco', 'mensalidade', 'orcamento', 'investimento', 'plano', 'verba'], reforcos: ['valor', 'preco', 'mensalidade', 'chamar_humano', 's15', 's16', 'comercial'] },
  { gatilhos: ['ja perdi dinheiro', 'agencia', 'promessa', 'desconfi', 'nao acredito', 'golpe', 'medo'], reforcos: ['objecao', 'ceticismo', 'desconfianca', 'qualificacao', 'o001', 's09'] },
  { gatilhos: ['como funciona', 'me explica', 'o que voce faz', 'como voces trabalham', 'detalhe', 'servico'], reforcos: ['explicar', 'funcionamento', 'escopo', 'abertura', 's01', 's02', 's03', 'm01'] },
  { gatilhos: ['agendar', 'reuniao', 'ligacao', 'call', 'horario', 'amanha', 'hoje', 'atender'], reforcos: ['agenda', 'horario', 'reuniao', 's18', 's19'] },
  { gatilhos: ['quero fechar', 'fechar', 'contratar', 'comecar', 'vamos nessa', 'pix', 'pagar', 'comprovante'], reforcos: ['fechamento', 'contratar', 'comprovante', 'chamar_humano', 's20', 's21'] },
  { gatilhos: ['robo', 'ia', 'automatico', 'bot', 'humano', 'pessoa real', 'falar com alguem'], reforcos: ['robo', 'humano', 'identidade', 'handoff', 's14', 's28'] },
  { gatilhos: ['nao tenho interesse', 'agora nao', 'talvez depois', 'depois eu vejo', 'sem interesse'], reforcos: ['recusa', 'encerramento', 's23', 's24'] },
  { gatilhos: ['pare de mandar', 'me remove', 'nao mande mais', 'bloquear', 'spam'], reforcos: ['parar', 'opt_out', 's25', 's26'] },
];

export function tokenizarPt(texto: string): string[] {
  return Array.from(
    new Set(
      dobrarPt(texto)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS_PT.has(t)),
    ),
  );
}

function pontuar(blob: string, tokens: readonly string[], textoAtual: string, reforcos: readonly string[]): number {
  const dobrado = dobrarPt(blob);
  let pontos = 0;
  for (const t of tokens) {
    if (dobrado.includes(t)) pontos += textoAtual.includes(t) ? 3 : 1.5;
  }
  for (const r of reforcos) {
    if (dobrado.includes(r)) pontos += 4;
  }
  return pontos;
}

export interface ContextoSelecionadoDoTurno {
  modo: ModoDeContextoDoCerebro;
  mensagens: MensagemAprovada[];
  skillsOperacionais: SkillOperacional[];
  skillsHumanizacao: SkillDeHumanizacao[];
  objecoes: ObjecaoDeAtendimento[];
  personas: PersonaDoCerebro[];
  respostasReferencia: RespostaDeReferencia[];
  paresBomRuim: ParBomRuim[];
  playbookCentral: string;
  regrasCanonicas: string;
  filtrosDeVoz: string[];
}

export function selecionarContextoDoTurno(
  estudio: DadosDoEstudio,
  opcoes: { mensagemAtual?: string; historicoRecente?: readonly string[]; temAudio?: boolean; temFoto?: boolean } = {},
): ContextoSelecionadoDoTurno {
  const cerebro = estudio.cerebroCompleto;
  const modo: ModoDeContextoDoCerebro = cerebro?.modoDeContexto === 'completo' ? 'completo' : 'inteligente';

  const mensagensAtivas = estudio.mensagensAprovadas.filter((m) => m.ativa);
  const opsAtivas = estudio.habilidadesOperacionais.filter((s) => s.ativa);
  const humsAtivas = estudio.habilidadesDeHumanizacao.filter((h) => h.ativa);
  const objsAtivas = estudio.objecoes.filter((o) => o.ativa);

  if (modo === 'completo') {
    return {
      modo,
      mensagens: mensagensAtivas,
      skillsOperacionais: opsAtivas,
      skillsHumanizacao: humsAtivas,
      objecoes: objsAtivas,
      personas: cerebro?.personas ?? [],
      respostasReferencia: (cerebro?.respostasDeReferencia ?? []).slice(0, 12),
      paresBomRuim: (cerebro?.paresBomRuim ?? []).slice(0, 8),
      playbookCentral: cerebro?.playbookCentral ?? '',
      regrasCanonicas: cerebro?.regrasCanonicas ?? '',
      filtrosDeVoz: cerebro?.filtrosDeVoz ?? [],
    };
  }

  const atual = opcoes.mensagemAtual ?? '';
  const recente = [...(opcoes.historicoRecente ?? []).slice(-3), atual].join(' ');
  const atualDobrado = dobrarPt(atual);
  const contextoDobrado = dobrarPt(recente);
  const tokens = tokenizarPt(`${atual} ${atual} ${recente}`);

  const reforcosSet = new Set<string>();
  for (const c of CLUSTERS_DE_INTENCAO) {
    if (c.gatilhos.some((g) => atualDobrado.includes(g) || contextoDobrado.includes(g))) {
      for (const r of c.reforcos) reforcosSet.add(r);
    }
  }
  if (opcoes.temAudio) {
    reforcosSet.add('audio');
    reforcosSet.add('midia');
  }
  if (opcoes.temFoto) {
    reforcosSet.add('foto');
    reforcosSet.add('imagem');
    reforcosSet.add('comprovante');
  }
  if (tokens.length <= 2 && /^(sim|pode|ok|beleza|claro|nao|os dois|ambos|uhum|bora)\b/.test(atualDobrado)) {
    reforcosSet.add('sim');
    reforcosSet.add('contexto');
    reforcosSet.add('s05');
    reforcosSet.add('h03');
  }
  const reforcos = Array.from(reforcosSet);

  const ranquear = <T>(itens: readonly T[], textoDe: (item: T) => string, limite: number, minimoGarantido = 0) =>
    itens
      .map((item) => ({ item, pontos: pontuar(textoDe(item), tokens, atualDobrado, reforcos) }))
      .sort((a, b) => b.pontos - a.pontos)
      .slice(0, limite)
      .filter((x, idx) => x.pontos > 0 || idx < minimoGarantido)
      .map((x) => x.item);

  return {
    modo,
    mensagens: ranquear(mensagensAtivas, (m) => `${m.id} ${m.titulo} ${m.categoria} ${m.texto}`, 4, 1),
    skillsOperacionais: ranquear(opsAtivas, (s) => `${s.id} ${s.nome} ${s.quando} ${s.exemploDeResposta} ${s.conteudoMd}`, 6, 2),
    skillsHumanizacao: ranquear(humsAtivas, (h) => `${h.id} ${h.nome} ${h.gatilho} ${h.objetivo} ${h.conteudoMd}`, 4, 2),
    objecoes: ranquear(objsAtivas, (o) => `${o.id} ${o.padraoDeEntrada} ${o.natureza} ${o.skillId} ${o.estrategiaDeResposta}`, 4, 0),
    personas: ranquear(cerebro?.personas ?? [], (p) => `${p.id} ${p.nome} ${p.sinais} ${p.conteudoMd}`, 2, 0),
    respostasReferencia: ranquear(cerebro?.respostasDeReferencia ?? [], (r) => `${r.id} ${r.titulo} ${r.quando} ${r.exemploEntrada}`, 4, 0),
    paresBomRuim: ranquear(cerebro?.paresBomRuim ?? [], (b) => `${b.id} ${b.titulo} ${b.contexto} ${b.licao}`, 3, 0),
    playbookCentral: cerebro?.playbookCentral ?? '',
    regrasCanonicas: cerebro?.regrasCanonicas ?? '',
    filtrosDeVoz: cerebro?.filtrosDeVoz ?? [],
  };
}

// =============================================================================================
// Leitor / Escritor ZIP puro (sem dependências externas; compatível com Node, Deno e Browser)
// =============================================================================================

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

const CRC_TABELA = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABELA[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function caminhoSeguroNoZip(caminho: string): boolean {
  if (!caminho || caminho.length > 260) return false;
  if (caminho.includes('\0') || caminho.includes('\\') || caminho.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(caminho)) return false;
  const partes = caminho.split('/');
  return partes.every((p) => p !== '' && p !== '.' && p !== '..');
}

function juntarBytes(partes: readonly Uint8Array[]): Uint8Array {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

async function inflarDeflateRaw(dados: Uint8Array, limite: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Este ambiente não possui descompressor DEFLATE nativo.');
  }
  const copia = new Uint8Array(dados.byteLength);
  copia.set(dados);
  const fluxo = new Blob([copia]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const leitor = fluxo.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.length;
      if (total > limite) throw new Error('Arquivo ZIP expandido passou do limite de segurança.');
      pedacos.push(value);
    }
    return juntarBytes(pedacos);
  } finally {
    leitor.releaseLock();
  }
}

export interface EntradaZip {
  caminho: string;
  bytes: Uint8Array;
}

export async function lerZipDoTreinamento(bytes: Uint8Array): Promise<EntradaZip[]> {
  if (bytes.length < 22 || bytes.length > LIMITES_DO_ESTUDIO.arquivoZipBytes) {
    throw new Error('Arquivo ZIP vazio ou acima de 4 MB.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos -= 1) {
    if (view.getUint32(pos, true) === 0x06054b50 && pos + 22 + view.getUint16(pos + 20, true) === bytes.length) {
      eocd = pos;
      break;
    }
  }
  if (eocd < 0 || view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    throw new Error('Arquivo ZIP inválido ou dividido em partes.');
  }

  const totalEntradas = view.getUint16(eocd + 10, true);
  const cdTamanho = view.getUint32(eocd + 12, true);
  const cdInicio = view.getUint32(eocd + 16, true);
  if (totalEntradas < 1 || totalEntradas > LIMITES_DO_ESTUDIO.entradasZip || totalEntradas !== view.getUint16(eocd + 8, true) || cdInicio + cdTamanho !== eocd) {
    throw new Error('Estrutura interna do arquivo ZIP inválida.');
  }

  let cursor = cdInicio;
  let somaExpandida = 0;
  const saida: EntradaZip[] = [];
  const vistos = new Set<string>();

  for (let i = 0; i < totalEntradas; i += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('Cabeçalho do arquivo ZIP inválido.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const metodo = view.getUint16(cursor + 10, true);
    const crcEsperado = view.getUint32(cursor + 16, true);
    const comprimido = view.getUint32(cursor + 20, true);
    const original = view.getUint32(cursor + 24, true);
    const tamNome = view.getUint16(cursor + 28, true);
    const tamExtra = view.getUint16(cursor + 30, true);
    const tamCom = view.getUint16(cursor + 32, true);
    const disco = view.getUint16(cursor + 34, true);
    const attr = view.getUint32(cursor + 38, true);
    const localPos = view.getUint32(cursor + 42, true);

    if (
      cursor + 46 + tamNome + tamExtra + tamCom > eocd ||
      disco !== 0 ||
      (flags & ~0x808) !== 0 ||
      (metodo !== 0 && metodo !== 8) ||
      original > 2 * 1024 * 1024 ||
      (somaExpandida += original) > LIMITES_DO_ESTUDIO.expandidoZipBytes ||
      original > Math.max(1024, comprimido * 500) ||
      ((attr >>> 16) & 0xf000) === 0xa000
    ) {
      throw new Error('ZIP com compactação, link simbólico ou tamanho fora do limite permitido.');
    }

    const nomeBruto = dec.decode(bytes.subarray(cursor + 46, cursor + 46 + tamNome));
    cursor += 46 + tamNome + tamExtra + tamCom;

    // Ignora metadados de macOS (__MACOSX) ou pastas.
    const ehPasta = nomeBruto.endsWith('/');
    const caminho = ehPasta ? nomeBruto.slice(0, -1) : nomeBruto;
    if (!caminho) continue;
    if (!caminhoSeguroNoZip(caminho)) throw new Error(`Caminho inseguro dentro do ZIP: ${caminho.slice(0, 60)}.`);
    if (vistos.has(caminho)) throw new Error(`Arquivo duplicado dentro do ZIP: ${caminho.slice(0, 60)}.`);
    vistos.add(caminho);

    if (localPos + 30 > cdInicio || view.getUint32(localPos, true) !== 0x04034b50) {
      throw new Error('Entrada local inválida dentro do ZIP.');
    }
    const localExtra = view.getUint16(localPos + 28, true);
    const localNomeTam = view.getUint16(localPos + 26, true);
    const inicioDados = localPos + 30 + localNomeTam + localExtra;
    const fimDados = inicioDados + comprimido;
    if (fimDados > cdInicio) throw new Error('Entrada ZIP fora dos limites do arquivo.');

    if (ehPasta) continue;
    const bruto = bytes.subarray(inicioDados, fimDados);
    const extraido = metodo === 0 ? new Uint8Array(bruto) : await inflarDeflateRaw(bruto, Math.max(1, original + 64));
    if (extraido.length !== original || crc32(extraido) !== crcEsperado) {
      throw new Error(`Arquivo corrompido dentro do ZIP: ${caminho.slice(0, 60)}.`);
    }
    if (caminho.startsWith('__MACOSX/')) continue;
    saida.push({ caminho, bytes: extraido });
  }

  return saida;
}

export function gerarZipDoTreinamento(entradas: ReadonlyArray<{ caminho: string; conteudo: string | Uint8Array }>): Uint8Array {
  if (entradas.length === 0 || entradas.length > LIMITES_DO_ESTUDIO.entradasZip) {
    throw new Error('Quantidade de arquivos inválida para gerar backup.');
  }
  const locais: Uint8Array[] = [];
  const centrais: Uint8Array[] = [];
  const vistos = new Set<string>();
  let offset = 0;
  let total = 0;

  for (const entrada of entradas) {
    if (!caminhoSeguroNoZip(entrada.caminho) || vistos.has(entrada.caminho)) {
      throw new Error(`Caminho inválido ou duplicado no backup: ${entrada.caminho}`);
    }
    vistos.add(entrada.caminho);
    const nome = enc.encode(entrada.caminho);
    const dados = typeof entrada.conteudo === 'string' ? enc.encode(entrada.conteudo) : entrada.conteudo;
    total += dados.length;
    if (total > LIMITES_DO_ESTUDIO.expandidoZipBytes) throw new Error('Backup excede o limite de 8 MB.');

    const sum = crc32(dados);
    const cabLocal = new Uint8Array(30 + nome.length);
    const vl = new DataView(cabLocal.buffer);
    vl.setUint32(0, 0x04034b50, true);
    vl.setUint16(4, 20, true);
    vl.setUint16(6, 0x0800, true);
    vl.setUint32(14, sum, true);
    vl.setUint32(18, dados.length, true);
    vl.setUint32(22, dados.length, true);
    vl.setUint16(26, nome.length, true);
    cabLocal.set(nome, 30);

    const cabCentral = new Uint8Array(46 + nome.length);
    const vc = new DataView(cabCentral.buffer);
    vc.setUint32(0, 0x02014b50, true);
    vc.setUint16(4, 20, true);
    vc.setUint16(6, 20, true);
    vc.setUint16(8, 0x0800, true);
    vc.setUint32(16, sum, true);
    vc.setUint32(20, dados.length, true);
    vc.setUint32(24, dados.length, true);
    vc.setUint16(28, nome.length, true);
    vc.setUint32(42, offset, true);
    cabCentral.set(nome, 46);

    locais.push(cabLocal, dados);
    centrais.push(cabCentral);
    offset += cabLocal.length + dados.length;
  }

  const cdTamanho = centrais.reduce((n, c) => n + c.length, 0);
  const fim = new Uint8Array(22);
  const vf = new DataView(fim.buffer);
  vf.setUint32(0, 0x06054b50, true);
  vf.setUint16(8, entradas.length, true);
  vf.setUint16(10, entradas.length, true);
  vf.setUint32(12, cdTamanho, true);
  vf.setUint32(16, offset, true);

  const resultado = juntarBytes([...locais, ...centrais, fim]);
  if (resultado.length > LIMITES_DO_ESTUDIO.arquivoZipBytes) {
    throw new Error('Arquivo de backup excede 4 MB.');
  }
  return resultado;
}

// =============================================================================================
// Importador universal (Pacote Turbo .zip / Backup Ienvia / JSON / Markdown) + Extrator de Docs
// =============================================================================================

export interface SugestaoDeIdentidade {
  nomeDoNegocio?: string;
  nicho?: string;
  nomeDoAtendente?: string;
  primeiraPessoa?: boolean;
  resumo?: string;
  condicoes?: string;
  regras?: string;
  instrucoesExtras?: string;
  gatilhosDeRepasse?: string;
  perguntas?: Array<{ pergunta: string; resposta: string; origem: 'manual' | 'correction' | 'template' }>;
}

export interface ResultadoDaImportacao {
  sugestaoIdentidade: SugestaoDeIdentidade;
  estudio: DadosDoEstudio;
  resumo: {
    origem: string;
    mensagens: number;
    skillsOperacionais: number;
    skillsHumanizacao: number;
    objecoes: number;
    personas: number;
    respostasReferencia: number;
    perguntas: number;
  };
}

function tentarJson(texto: string): unknown | null {
  let limpo = texto.trim().replace(/^\ufeff/, '');
  if (/^```(?:json)?\s*\n/i.test(limpo)) {
    limpo = limpo.replace(/^```(?:json)?\s*\n/i, '').replace(/\n```\s*$/i, '');
  }
  try {
    return JSON.parse(limpo);
  } catch {
    return null;
  }
}

/** Tira um prefixo de pasta raiz comum quando todo o ZIP veio dentro de "PACOTE-XYZ/...". */
function removerRaizComum(entradas: ReadonlyArray<{ caminho: string; texto: string }>): { raiz: string; arquivos: Array<{ rel: string; texto: string }> } {
  const segmentos = entradas.map((e) => e.caminho.split('/')[0] ?? '').filter(Boolean);
  const primeiro = segmentos[0] ?? '';
  const todosNaMesmaRaiz =
    primeiro !== '' &&
    entradas.every((e) => e.caminho.startsWith(`${primeiro}/`)) &&
    entradas.some((e) => e.caminho.split('/').length >= 2);
  if (!todosNaMesmaRaiz) {
    return { raiz: '', arquivos: entradas.map((e) => ({ rel: e.caminho, texto: e.texto })) };
  }
  return {
    raiz: primeiro,
    arquivos: entradas.map((e) => ({ rel: e.caminho.slice(primeiro.length + 1), texto: e.texto })),
  };
}

/** Extrai blocos M01..M13, S01..S35, H01..H32, O001..O045 de arquivos Markdown já compilados (caso do banco atual!). */
export function extrairEstudioDeDocumentos(documentos: ReadonlyArray<{ titulo: string; conteudo: string }>): DadosDoEstudio {
  const mensagensAprovadas: MensagemAprovada[] = [];
  const habilidadesOperacionais: SkillOperacional[] = [];
  const habilidadesDeHumanizacao: SkillDeHumanizacao[] = [];
  const objecoes: ObjecaoDeAtendimento[] = [];
  let playbookCentral = '';
  let regrasCanonicas = '';

  for (const doc of documentos) {
    const texto = doc.conteudo || '';
    if (/playbook/i.test(doc.titulo) && !playbookCentral) {
      const idx = texto.search(/^##\s*M0?1\b/m);
      playbookCentral = cortar(idx > 0 ? texto.slice(0, idx) : texto, LIMITES_DO_ESTUDIO.playbookCentral);
    }

    // M01..M99
    const partesM = texto.split(/^(?=##+\s*M\d{2}\b)/m);
    for (const bloco of partesM) {
      const m = /^##+\s*(M\d{2})\s*(?:[-–—:]\s*|\s+)(.+)$/m.exec(bloco);
      if (!m) continue;
      const id = m[1]!.toUpperCase();
      const titulo = cortar(m[2]!, LIMITES_DO_ESTUDIO.titulo);
      const corpo = cortar(bloco.slice(m[0].length), LIMITES_DO_ESTUDIO.textoDaMensagem);
      if (corpo && !mensagensAprovadas.some((x) => x.id === id)) {
        mensagensAprovadas.push({ id, titulo, categoria: 'Aprovada', texto: corpo, ativa: true });
      }
    }

    // S01..S99
    const partesS = texto.split(/^(?=##+\s*S\d{2}\b)/m);
    for (const bloco of partesS) {
      const m = /^##+\s*(S\d{2})\s*(?:[-–—:]\s*|\s+)(.+)$/m.exec(bloco);
      if (!m) continue;
      const id = m[1]!.toUpperCase();
      const nome = cortar(m[2]!, LIMITES_DO_ESTUDIO.nomeDaSkill);
      const corpo = cortar(bloco.slice(m[0].length), LIMITES_DO_ESTUDIO.conteudoMd);
      const quandoMatch = /\*\*Quando\s+(?:usar|acionar)\s*:?\*\*\s*(.+)/i.exec(corpo) ?? /Quando\s*:?\s*(.+)/i.exec(corpo);
      const exMatch = /\*\*(?:Exemplo|Resposta[^*]*)\s*:?\*\*\s*([\s\S]+?)(?=\n\*\*|\n##|$)/i.exec(corpo);
      if (!habilidadesOperacionais.some((x) => x.id === id)) {
        habilidadesOperacionais.push({
          id,
          nome,
          quando: cortar(quandoMatch?.[1] ?? nome, LIMITES_DO_ESTUDIO.quando),
          exemploDeResposta: cortar(exMatch?.[1] ?? '', LIMITES_DO_ESTUDIO.exemploDeResposta),
          conteudoMd: corpo,
          ativa: true,
        });
      }
    }

    // H01..H99
    const partesH = texto.split(/^(?=##+\s*H\d{2}\b)/m);
    for (const bloco of partesH) {
      const m = /^##+\s*(H\d{2})\s*(?:[-–—:]\s*|\s+)(.+)$/m.exec(bloco);
      if (!m) continue;
      const id = m[1]!.toUpperCase();
      const nome = cortar(m[2]!, LIMITES_DO_ESTUDIO.nomeDaSkill);
      const corpo = cortar(bloco.slice(m[0].length), LIMITES_DO_ESTUDIO.conteudoMd);
      if (!habilidadesDeHumanizacao.some((x) => x.id === id)) {
        habilidadesDeHumanizacao.push({
          id,
          nome,
          gatilho: cortar(nome, LIMITES_DO_ESTUDIO.quando),
          objetivo: cortar(corpo.split('\n')[0] ?? '', LIMITES_DO_ESTUDIO.quando),
          evitar: '',
          respostaRuim: '',
          respostaMelhor: '',
          conteudoMd: corpo,
          ativa: true,
        });
      }
    }

    // O001..O999
    const partesO = texto.split(/^(?=(?:##+\s*|[-*]\s*\*\*)O\d{3}\b)/m);
    for (const bloco of partesO) {
      const m = /^(?:##+\s*|[-*]\s*\*\*)(O\d{3})\b[^:\n]*[:*—–-]*\s*(.+)$/m.exec(bloco);
      if (!m) continue;
      const id = m[1]!.toUpperCase();
      const padrao = cortar(m[2]!.replace(/\*+/g, ''), LIMITES_DO_ESTUDIO.padraoDeEntrada);
      const corpo = cortar(bloco.slice(m[0].length), LIMITES_DO_ESTUDIO.estrategia);
      if (!objecoes.some((x) => x.id === id)) {
        objecoes.push({
          id,
          padraoDeEntrada: padrao || id,
          natureza: '',
          skillId: '',
          estrategiaDeResposta: corpo || padrao,
          evitar: '',
          ativa: true,
        });
      }
    }

    if (/humanizac/i.test(doc.titulo) && !regrasCanonicas) {
      const idx = texto.search(/^##+\s*H\d{2}\b/m);
      regrasCanonicas = cortar(idx > 0 ? texto.slice(0, idx) : '', LIMITES_DO_ESTUDIO.regrasCanonicas);
    }
  }

  return {
    mensagensAprovadas: mensagensAprovadas.slice(0, LIMITES_DO_ESTUDIO.mensagensAprovadas),
    habilidadesOperacionais: habilidadesOperacionais.slice(0, LIMITES_DO_ESTUDIO.habilidadesOperacionais),
    habilidadesDeHumanizacao: habilidadesDeHumanizacao.slice(0, LIMITES_DO_ESTUDIO.habilidadesDeHumanizacao),
    objecoes: objecoes.slice(0, LIMITES_DO_ESTUDIO.objecoes),
    cerebroCompleto:
      mensagensAprovadas.length + habilidadesOperacionais.length + habilidadesDeHumanizacao.length + objecoes.length > 0 || playbookCentral
        ? {
            id: 'extraido-dos-arquivos',
            nome: 'Estúdio estruturado dos arquivos',
            versao: '1.0',
            importadoEm: new Date().toISOString(),
            modoDeContexto: 'inteligente',
            playbookCentral,
            regrasCanonicas,
            fatosDoNegocio: {},
            filtrosDeVoz: [],
            personas: [],
            paresBomRuim: [],
            respostasDeReferencia: [],
          }
        : null,
  };
}

function importarDeObjetoJson(raw: unknown, nomeArquivo: string): ResultadoDaImportacao {
  const d = objeto(raw);

  // Caso 1: Backup completo deste painel ("ienvia-treinamento-v2") ou v1 ("ienvia-training-draft-v1")
  const t = objeto(d.training ?? d.treinamento ?? d.profile ?? d.base ?? d);
  const p = objeto(d.pack ?? d.brain_pack ?? d.cerebro ?? (d.canonicalCore || d.operationalSkills ? d : null));
  const core = objeto(p.canonicalCore);

  const estudo = lerEstudioDoBanco({
    approved_messages: d.approved_messages ?? d.mensagensAprovadas ?? core.approvedMessages ?? p.approvedMessages,
    operational_skills: d.operational_skills ?? d.habilidadesOperacionais ?? p.operationalSkills,
    humanization_skills: d.humanization_skills ?? d.habilidadesDeHumanizacao ?? p.humanizationSkills,
    objections: d.objections ?? d.objecoes ?? p.objections,
    brain_pack: Object.keys(p).length > 0 ? p : d.cerebroCompleto ?? {},
  });

  const faqsRaw = lista(t.faqs ?? d.perguntas);
  const perguntas = faqsRaw
    .map((item) => {
      const f = objeto(item);
      const pergunta = cortar(txt(f.question) || txt(f.pergunta), 500);
      const resposta = cortar(txt(f.answer) || txt(f.resposta), 2000);
      if (!pergunta || !resposta) return null;
      const orig = txt(f.source) || txt(f.origem);
      return {
        pergunta,
        resposta,
        origem: orig === 'correction' || orig === 'template' ? (orig as 'correction' | 'template') : ('manual' as const),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 100);

  const sugestao: SugestaoDeIdentidade = {
    ...(txt(t.name) || txt(t.business_name) || txt(t.nomeDoNegocio)
      ? { nomeDoNegocio: cortar(txt(t.name) || txt(t.business_name) || txt(t.nomeDoNegocio), 120) }
      : {}),
    ...(txt(t.niche) || txt(t.nicho) ? { nicho: cortar(txt(t.niche) || txt(t.nicho), 120) } : {}),
    ...(txt(t.assistantName) || txt(t.assistant_name) || txt(t.nomeDoAtendente)
      ? { nomeDoAtendente: cortar(txt(t.assistantName) || txt(t.assistant_name) || txt(t.nomeDoAtendente), 60) }
      : {}),
    ...(typeof (t.soloIdentity ?? t.solo_identity ?? t.primeiraPessoa) === 'boolean'
      ? { primeiraPessoa: Boolean(t.soloIdentity ?? t.solo_identity ?? t.primeiraPessoa) }
      : {}),
    ...(txt(t.companySummary) || txt(t.company_summary) || txt(t.resumo)
      ? { resumo: cortar(txt(t.companySummary) || txt(t.company_summary) || txt(t.resumo), 4000) }
      : {}),
    ...(txt(t.deliveryAndPayment) || txt(t.commercial_terms) || txt(t.condicoes)
      ? { condicoes: cortar(txt(t.deliveryAndPayment) || txt(t.commercial_terms) || txt(t.condicoes), 4000) }
      : {}),
    ...(txt(t.goldenRules) || txt(t.golden_rules) || txt(t.regras)
      ? { regras: cortar(txt(t.goldenRules) || txt(t.golden_rules) || txt(t.regras), 8000) }
      : {}),
    ...(txt(t.extraInstructions) || txt(t.extra_instructions) || txt(t.instrucoesExtras)
      ? { instrucoesExtras: cortar(txt(t.extraInstructions) || txt(t.extra_instructions) || txt(t.instrucoesExtras), 4000) }
      : {}),
    ...(txt(t.escalationRules) || txt(t.escalation_rules) || txt(t.gatilhosDeRepasse)
      ? { gatilhosDeRepasse: cortar(txt(t.escalationRules) || txt(t.escalation_rules) || txt(t.gatilhosDeRepasse), 4000) }
      : {}),
    ...(perguntas.length > 0 ? { perguntas } : {}),
  };

  const temAlgo =
    Object.keys(sugestao).length > 0 ||
    estudo.mensagensAprovadas.length > 0 ||
    estudo.habilidadesOperacionais.length > 0 ||
    estudo.habilidadesDeHumanizacao.length > 0 ||
    estudo.objecoes.length > 0 ||
    estudo.cerebroCompleto !== null;

  if (!temAlgo) {
    throw new Error('O JSON não contém campos reconhecíveis de treinamento ou pacote.');
  }

  return {
    sugestaoIdentidade: sugestao,
    estudio: estudo,
    resumo: {
      origem: nomeArquivo,
      mensagens: estudo.mensagensAprovadas.length,
      skillsOperacionais: estudo.habilidadesOperacionais.length,
      skillsHumanizacao: estudo.habilidadesDeHumanizacao.length,
      objecoes: estudo.objecoes.length,
      personas: estudo.cerebroCompleto?.personas.length ?? 0,
      respostasReferencia: estudo.cerebroCompleto?.respostasDeReferencia.length ?? 0,
      perguntas: perguntas.length,
    },
  };
}

export async function importarPacoteDoTreinamento(bytes: Uint8Array, nomeArquivo: string): Promise<ResultadoDaImportacao> {
  if (bytes.length === 0) throw new Error('O arquivo está vazio.');
  if (bytes.length > LIMITES_DO_ESTUDIO.arquivoZipBytes) throw new Error('O arquivo ultrapassa o limite de 4 MB.');

  const ehZip = /\.zip$/i.test(nomeArquivo) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (!ehZip) {
    let texto: string;
    try {
      texto = dec.decode(bytes).replace(/^\ufeff/, '');
    } catch {
      throw new Error('Use um arquivo .zip, .json, .md ou .txt em UTF-8.');
    }
    if (/\.json$/i.test(nomeArquivo) || /^\s*(?:\{|```json)/i.test(texto)) {
      const json = tentarJson(texto);
      if (!json) throw new Error('JSON inválido. Confira a sintaxe do arquivo.');
      return importarDeObjetoJson(json, nomeArquivo);
    }
    if (!/\.(md|txt)$/i.test(nomeArquivo)) throw new Error('Formato não suportado. Use .zip, .json, .md ou .txt.');
    const extraido = extrairEstudioDeDocumentos([{ titulo: nomeArquivo, conteudo: texto }]);
    if (
      extraido.mensagensAprovadas.length +
        extraido.habilidadesOperacionais.length +
        extraido.habilidadesDeHumanizacao.length +
        extraido.objecoes.length ===
      0
    ) {
      throw new Error('Não encontrei códigos M01–M13, S01–S35, H01–H32 ou O001+ nesse texto. Use a aba Arquivos para textos livres.');
    }
    return {
      sugestaoIdentidade: {},
      estudio: extraido,
      resumo: {
        origem: nomeArquivo,
        mensagens: extraido.mensagensAprovadas.length,
        skillsOperacionais: extraido.habilidadesOperacionais.length,
        skillsHumanizacao: extraido.habilidadesDeHumanizacao.length,
        objecoes: extraido.objecoes.length,
        personas: 0,
        respostasReferencia: 0,
        perguntas: 0,
      },
    };
  }

  // Lê o ZIP e extrai todos os textos UTF-8 relevantes
  const entradas = await lerZipDoTreinamento(bytes);
  const textos: Array<{ caminho: string; texto: string }> = [];
  for (const entrada of entradas) {
    if (!/\.(json|md|txt|csv)$/i.test(entrada.caminho)) continue;
    try {
      textos.push({ caminho: entrada.caminho, texto: dec.decode(entrada.bytes).replace(/^\ufeff/, '').trim() });
    } catch {
      // ignora arquivo de texto com encoding estranho se houver outros válidos
    }
  }
  if (textos.length === 0) throw new Error('O arquivo ZIP não contém arquivos .json, .md ou .txt de treinamento.');

  const { raiz, arquivos } = removerRaizComum(textos);
  const achar = (predicado: (rel: string) => boolean) => arquivos.find((a) => predicado(a.rel));
  const mapaTexto = new Map(arquivos.map((a) => [a.rel, a.texto]));

  // Caso A: Backup do próprio Ienvia (v2 ou v1)
  const completo = achar((rel) => /(?:^|\/)(?:ienvia-treinamento-completo|ienvia-training-draft)\.json$/i.test(rel));
  if (completo) {
    const parsed = tentarJson(completo.texto);
    if (parsed) return importarDeObjetoJson(parsed, nomeArquivo);
  }

  // Caso B: Pacote compilado legado (ienvia-pack-compilado.json / zapia-pack-compilado.json + perfil-*.json)
  const perfilLegado = achar((rel) => /(?:^|\/)(?:perfil-ienvia|perfil-zapia-studio)\.json$/i.test(rel));
  const packCompilado = achar((rel) => /(?:^|\/)(?:ienvia-pack-compilado|zapia-pack-compilado)\.json$/i.test(rel));
  if (packCompilado) {
    const pJson = tentarJson(packCompilado.texto);
    if (pJson) {
      return importarDeObjetoJson(
        { training: perfilLegado ? tentarJson(perfilLegado.texto) ?? {} : {}, pack: pJson },
        nomeArquivo,
      );
    }
  }

  // Caso C: Pacote Turbo estruturado em pastas (PACOTE-LIZANDRO-CELESTINO.zip / zap-ia-studio)
  const fatosArquivo = achar((rel) => rel.toLowerCase().endsWith('fatos-do-negocio.json'));
  const fatos = objeto(fatosArquivo ? tentarJson(fatosArquivo.texto) : null);
  const resumoArquivo = achar((rel) => rel.toLowerCase().endsWith('resumo-do-treinamento.json'));
  const resumoMeta = objeto(resumoArquivo ? tentarJson(resumoArquivo.texto) : null);

  const regrasCanonicasArq = achar((rel) => /^00-regras-canonicas/i.test(rel.split('/').at(-1) ?? ''));
  const promptPrincipalArq = achar((rel) => /^prompt-principal/i.test(rel.split('/').at(-1) ?? ''));
  const playbookArq = achar((rel) => /^playbook-central/i.test(rel.split('/').at(-1) ?? ''));

  const negDocs = arquivos.filter((a) => /^01-negocio\/.*\.md$/i.test(a.rel)).sort((a, b) => a.rel.localeCompare(b.rel));
  const compDocs = arquivos.filter((a) => /^02-comportamento\/.*\.md$/i.test(a.rel)).sort((a, b) => a.rel.localeCompare(b.rel));
  const humCoreDocs = arquivos.filter((a) => /^12-humanizacao\/0[123]-.*\.md$/i.test(a.rel)).sort((a, b) => a.rel.localeCompare(b.rel));

  // 1) Mensagens aprovadas M01–M13
  const mensagensAprovadas: MensagemAprovada[] = [];
  const origJsonArq = achar((rel) => /m01-.*originais\.json$/i.test(rel));
  const origJson = objeto(origJsonArq ? tentarJson(origJsonArq.texto) : null);
  const textosM = objeto(origJson.textos);
  const titulosM = objeto(origJson.titulos);
  for (const [code, textVal] of Object.entries(textosM)) {
    const corpo = cortar(txt(textVal), LIMITES_DO_ESTUDIO.textoDaMensagem);
    if (!corpo) continue;
    mensagensAprovadas.push({
      id: cortar(code, LIMITES_DO_ESTUDIO.id),
      titulo: cortar(txt(titulosM[code]) || code, LIMITES_DO_ESTUDIO.titulo),
      categoria: 'Aprovada',
      texto: corpo,
      ativa: true,
    });
  }

  // 2) Skills operacionais S01–S35
  const habilidadesOperacionais: SkillOperacional[] = [];
  const caminhosUsados = new Set<string>();
  const opIndexArq = achar((rel) => rel.toLowerCase().endsWith('03-skills/indice-skills.json'));
  const opIndex = lista(opIndexArq ? tentarJson(opIndexArq.texto) : null);
  for (const [idx, bruto] of opIndex.entries()) {
    const item = objeto(bruto);
    const p = txt(item.path);
    if (p) caminhosUsados.add(p);
    const bodyMd = p ? (mapaTexto.get(p) ?? '') : '';
    const skill = lerSkillOp(
      {
        id: txt(item.id) || `S${String(idx + 1).padStart(2, '0')}`,
        nome: txt(item.name) || txt(item.title) || `Skill ${idx + 1}`,
        quando: txt(item.when),
        exemploDeResposta: txt(item.example_response),
        conteudoMd: bodyMd,
      },
      idx,
    );
    if (skill) habilidadesOperacionais.push(skill);
  }
  for (const arq of arquivos) {
    if (arq.rel.toLowerCase().endsWith('/skill.md') && !arq.rel.toLowerCase().startsWith('12-humanizacao/') && !caminhosUsados.has(arq.rel)) {
      const pasta = arq.rel.split('/').at(-2) ?? 'skill';
      const skill = lerSkillOp(
        {
          id: `SK_${habilidadesOperacionais.length + 1}`,
          nome: pasta.replace(/-/g, ' '),
          quando: pasta.replace(/-/g, ' '),
          conteudoMd: arq.texto,
        },
        habilidadesOperacionais.length,
      );
      if (skill) habilidadesOperacionais.push(skill);
    }
  }

  // 3) Skills de humanização H01–H32
  const habilidadesDeHumanizacao: SkillDeHumanizacao[] = [];
  const humIndexArq = achar((rel) => rel.toLowerCase().endsWith('indice-skills-humanizacao.json'));
  const humIndex = lista(humIndexArq ? tentarJson(humIndexArq.texto) : null);
  for (const [idx, bruto] of humIndex.entries()) {
    const item = objeto(bruto);
    const p = txt(item.path);
    const bodyMd = p ? (mapaTexto.get(p) ?? '') : '';
    const skill = lerSkillHum({ ...item, bodyMd }, idx);
    if (skill) habilidadesDeHumanizacao.push(skill);
  }

  // 4) Objeções O001–O045
  const objIndexArq = achar((rel) => rel.toLowerCase().endsWith('matriz-de-duvidas-e-objecoes.json'));
  const objIndex = lista(objIndexArq ? tentarJson(objIndexArq.texto) : null);
  const objecoes = objIndex.map((raw, i) => lerObjecao(raw, i)).filter((x): x is ObjecaoDeAtendimento => x !== null);

  // 5) Referências, Personas e Bom vs Ruim
  const refArq = achar((rel) => rel.toLowerCase().endsWith('respostas-de-referencia.json'));
  const respostasDeReferencia = lista(refArq ? tentarJson(refArq.texto) : null)
    .map((raw, i) => {
      const r = objeto(raw);
      const titulo = cortar(txt(r.title), 200);
      if (!titulo) return null;
      return {
        id: cortar(txt(r.id) || `R${String(i + 1).padStart(2, '0')}`, 60),
        titulo,
        quando: cortar(txt(r.when), 500),
        exemploEntrada: cortar(txt(r.example_input), 500),
        skillId: cortar(txt(r.skill_id), 60),
        cuidado: cortar(txt(r.caution), 500),
        comportamento: cortar(txt(r.recommended_behavior) || 'responder', 80),
      };
    })
    .filter((x): x is RespostaDeReferencia => x !== null)
    .slice(0, 80);

  const persArq = achar((rel) => rel.toLowerCase().endsWith('indice-personas.json'));
  const persJson = objeto(persArq ? tentarJson(persArq.texto) : null);
  const filtrosDeVoz = lista(persJson.voice_filters).map((x) => cortar(txt(x), 300)).filter(Boolean).slice(0, 30);
  const personas = lista(persJson.interlocutor_profiles)
    .map((raw, i) => {
      const p = objeto(raw);
      const nome = cortar(txt(p.name), 160);
      if (!nome) return null;
      const md = txt(p.path) ? (mapaTexto.get(txt(p.path)) ?? '') : '';
      return {
        id: cortar(txt(p.id) || `P${String(i + 1).padStart(2, '0')}`, 60),
        nome,
        sinais: cortar(txt(p.signals), 600),
        conteudoMd: cortar(md, 4000),
      };
    })
    .filter((x): x is PersonaDoCerebro => x !== null)
    .slice(0, 20);

  const bomRuimArq = achar((rel) => rel.toLowerCase().endsWith('bom-versus-ruim.json'));
  const paresBomRuim = lista(bomRuimArq ? tentarJson(bomRuimArq.texto) : null)
    .map((raw, i) => {
      const b = objeto(raw);
      const titulo = cortar(txt(b.title), 160);
      if (!titulo) return null;
      return {
        id: cortar(txt(b.id) || `B${String(i + 1).padStart(2, '0')}`, 60),
        titulo,
        contexto: cortar(txt(b.context), 400),
        naoUsar: cortar(txt(b.do_not_use), 1000),
        melhorResposta: cortar(txt(b.better_response), 1000),
        licao: cortar(txt(b.lesson), 600),
      };
    })
    .filter((x): x is ParBomRuim => x !== null)
    .slice(0, 40);

  // Fallback para markdown solto se nenhum JSON de índice veio no ZIP
  if (mensagensAprovadas.length + habilidadesOperacionais.length + habilidadesDeHumanizacao.length + objecoes.length === 0) {
    const mdExtraido = extrairEstudioDeDocumentos(arquivos.map((a) => ({ titulo: a.rel, conteudo: a.texto })));
    if (
      mdExtraido.mensagensAprovadas.length +
        mdExtraido.habilidadesOperacionais.length +
        mdExtraido.habilidadesDeHumanizacao.length +
        mdExtraido.objecoes.length >
      0
    ) {
      return {
        sugestaoIdentidade: {},
        estudio: mdExtraido,
        resumo: {
          origem: nomeArquivo,
          mensagens: mdExtraido.mensagensAprovadas.length,
          skillsOperacionais: mdExtraido.habilidadesOperacionais.length,
          skillsHumanizacao: mdExtraido.habilidadesDeHumanizacao.length,
          objecoes: mdExtraido.objecoes.length,
          personas: 0,
          respostasReferencia: 0,
          perguntas: 0,
        },
      };
    }
    throw new Error('ZIP sem estrutura de Pacote Turbo, backup Ienvia ou arquivos M/S/H/O reconhecíveis.');
  }

  const representante = txt(fatos.representative) || txt(fatos.owner_name);
  const nomeEmpresa = txt(fatos.commercial_name_from_approved_material) || txt(fatos.business_name);
  const nomeDoPacote =
    representante && nomeEmpresa
      ? `${representante} · ${nomeEmpresa}`
      : representante || nomeEmpresa || raiz || nomeArquivo.replace(/\.zip$/i, '');

  const playbookCentral = cortar(
    [playbookArq?.texto, promptPrincipalArq?.texto].filter(Boolean).join('\n\n'),
    LIMITES_DO_ESTUDIO.playbookCentral,
  );
  const regrasCanonicas = cortar(
    [regrasCanonicasArq?.texto, ...humCoreDocs.map((d) => d.texto)].filter(Boolean).join('\n\n'),
    LIMITES_DO_ESTUDIO.regrasCanonicas,
  );

  const sugestao: SugestaoDeIdentidade = {
    ...(representante || nomeEmpresa ? { nomeDoNegocio: cortar(representante || nomeEmpresa, 120) } : {}),
    ...(txt(fatos.niche) ? { nicho: cortar(txt(fatos.niche), 120) } : {}),
    ...(representante ? { nomeDoAtendente: cortar(representante.split(/\s+/)[0] ?? representante, 60) } : {}),
    ...(fatos.solo_identity === true ? { primeiraPessoa: true } : {}),
    ...(negDocs.length > 0 ? { resumo: cortar(negDocs.map((d) => d.texto).join('\n\n'), 4000) } : {}),
    ...(compDocs.length > 0 ? { regras: cortar(compDocs.map((d) => d.texto).join('\n\n'), 8000) } : {}),
  };

  return {
    sugestaoIdentidade: sugestao,
    estudio: {
      mensagensAprovadas: mensagensAprovadas.slice(0, LIMITES_DO_ESTUDIO.mensagensAprovadas),
      habilidadesOperacionais: habilidadesOperacionais.slice(0, LIMITES_DO_ESTUDIO.habilidadesOperacionais),
      habilidadesDeHumanizacao: habilidadesDeHumanizacao.slice(0, LIMITES_DO_ESTUDIO.habilidadesDeHumanizacao),
      objecoes: objecoes.slice(0, LIMITES_DO_ESTUDIO.objecoes),
      cerebroCompleto: {
        id: cortar(raiz || nomeArquivo.replace(/\.zip$/i, ''), 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'pacote-turbo',
        nome: cortar(nomeDoPacote, 160),
        versao: cortar(txt(fatos.version) || txt(resumoMeta.version) || 'turbo', 40),
        importadoEm: new Date().toISOString(),
        modoDeContexto: 'inteligente',
        playbookCentral,
        regrasCanonicas,
        fatosDoNegocio: fatos,
        filtrosDeVoz,
        personas,
        paresBomRuim,
        respostasDeReferencia,
      },
    },
    resumo: {
      origem: nomeArquivo,
      mensagens: Math.min(mensagensAprovadas.length, LIMITES_DO_ESTUDIO.mensagensAprovadas),
      skillsOperacionais: Math.min(habilidadesOperacionais.length, LIMITES_DO_ESTUDIO.habilidadesOperacionais),
      skillsHumanizacao: Math.min(habilidadesDeHumanizacao.length, LIMITES_DO_ESTUDIO.habilidadesDeHumanizacao),
      objecoes: Math.min(objecoes.length, LIMITES_DO_ESTUDIO.objecoes),
      personas: personas.length,
      respostasReferencia: respostasDeReferencia.length,
      perguntas: 0,
    },
  };
}

export function exportarTreinamentoZip(dados: {
  rotulo: string;
  nomeDoNegocio: string;
  nicho: string;
  nomeDoAtendente: string;
  primeiraPessoa: boolean;
  tom: string;
  resumo: string;
  condicoes: string;
  regras: string;
  instrucoesExtras: string;
  gatilhosDeRepasse: string;
  travaAteRetomar: boolean;
  blindagem: boolean;
  perguntaSobreRobo: string;
  perguntas: ReadonlyArray<{ pergunta: string; resposta: string; origem: string }>;
  estudio: DadosDoEstudio;
}): Uint8Array {
  const payload = {
    schema: 'ienvia-treinamento-v2',
    exported_at: new Date().toISOString(),
    training: {
      label: dados.rotulo,
      business_name: dados.nomeDoNegocio,
      niche: dados.nicho,
      assistant_name: dados.nomeDoAtendente,
      solo_identity: dados.primeiraPessoa,
      tone: dados.tom,
      company_summary: dados.resumo,
      commercial_terms: dados.condicoes,
      golden_rules: dados.regras,
      extra_instructions: dados.instrucoesExtras,
      escalation_rules: dados.gatilhosDeRepasse,
      lock_until_manual_resume: dados.travaAteRetomar,
      prompt_shield_enabled: dados.blindagem,
      robot_question_policy: dados.perguntaSobreRobo,
      faqs: dados.perguntas.map((p) => ({ question: p.pergunta, answer: p.resposta, source: p.origem })),
    },
    approved_messages: dados.estudio.mensagensAprovadas,
    operational_skills: dados.estudio.habilidadesOperacionais,
    humanization_skills: dados.estudio.habilidadesDeHumanizacao,
    objections: dados.estudio.objecoes,
    brain_pack: dados.estudio.cerebroCompleto,
  };

  return gerarZipDoTreinamento([
    { caminho: 'ienvia-treinamento-completo.json', conteudo: JSON.stringify(payload, null, 2) },
    {
      caminho: 'LEIA-ME.md',
      conteudo: [
        `# Backup completo do Treinamento — ${dados.rotulo}`,
        '',
        `- Negócio / Profissional: ${dados.nomeDoNegocio || '(não informado)'}`,
        `- Mensagens aprovadas: ${dados.estudio.mensagensAprovadas.length}`,
        `- Skills operacionais: ${dados.estudio.habilidadesOperacionais.length}`,
        `- Skills de humanização: ${dados.estudio.habilidadesDeHumanizacao.length}`,
        `- Matriz de objeções: ${dados.estudio.objecoes.length}`,
        '',
        'Para restaurar, importe este arquivo .zip na aba "Cérebro e Pacote" do Treinamento.',
      ].join('\n'),
    },
    { caminho: 'mensagens-aprovadas.json', conteudo: JSON.stringify(dados.estudio.mensagensAprovadas, null, 2) },
    { caminho: 'skills-operacionais.json', conteudo: JSON.stringify(dados.estudio.habilidadesOperacionais, null, 2) },
    { caminho: 'skills-humanizacao.json', conteudo: JSON.stringify(dados.estudio.habilidadesDeHumanizacao, null, 2) },
    { caminho: 'matriz-objecoes.json', conteudo: JSON.stringify(dados.estudio.objecoes, null, 2) },
  ]);
}
