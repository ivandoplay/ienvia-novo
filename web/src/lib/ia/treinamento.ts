/**
 * Regras do Treinamento que não dependem de banco nem de rede: os campos de uma base de treinamento,
 * os limites, a leitura do que o banco devolve, a conferência do que vem da tela e a conferência dos
 * arquivos de conhecimento. A tela, as ações do servidor e os testes usam as mesmas.
 * O banco confere tudo de novo ao gravar (supabase/migrations/20261112002400_ai_engine_and_training.sql).
 */
import { MODELOS_PRONTOS_DADOS } from '@/lib/ia/modelos-prontos';

export type Tom = 'consultivo' | 'acolhedor' | 'descontraido' | 'profissional' | 'formal';

/** Os tons de voz, com o rótulo da tela e a descrição que entra nas instruções da IA. */
export const TONS: ReadonlyArray<{ valor: Tom; rotulo: string; descricao: string }> = [
  {
    valor: 'consultivo',
    rotulo: 'Consultivo e vendedor (simpático e focado em conversão)',
    descricao: 'Simpático, consultivo, firme com educação e focado em conduzir com clareza sem pressionar.',
  },
  { valor: 'acolhedor', rotulo: 'Acolhedor e humanizado (ideal para clínicas, saúde e estética)', descricao: 'Humano, calmo, empático, educado e muito acolhedor.' },
  {
    valor: 'descontraido',
    rotulo: 'Ágil e descontraído (ideal para delivery, lanchonetes e varejo jovem)',
    descricao: 'Ágil, leve, amigável e próximo, usando linguagem natural do dia a dia no Brasil.',
  },
  {
    valor: 'profissional',
    rotulo: 'Técnico e objetivo (ideal para assistência, oficinas e vendas para empresas)',
    descricao: 'Objetivo, técnico na medida certa, claro e transmitindo máxima confiança.',
  },
  { valor: 'formal', rotulo: 'Executivo e formal (ideal para advocacia, contabilidade e alto padrão)', descricao: 'Executivo, polido, elegante e respeitoso.' },
];

export const ehTom = (valor: unknown): valor is Tom => TONS.some((tom) => tom.valor === valor);

/**
 * O que a IA faz quando o contato pergunta se está falando com um robô:
 *   handoff  — não nega nem confirma: passa a conversa para uma pessoa;
 *   disclose — diz que é a assistente virtual do negócio.
 * Não existe a opção "negar": o painel não instrui a IA a se passar por gente quando perguntam.
 */
export type PerguntaSobreRobo = 'handoff' | 'disclose';

export type OrigemDaPergunta = 'manual' | 'correction' | 'template';

export interface PerguntaFrequente {
  pergunta: string;
  resposta: string;
  /** manual = digitada na tela; correction = veio de "corrigir resposta"; template = veio de um modelo pronto. */
  origem: OrigemDaPergunta;
}

export interface ArquivoDeConhecimento {
  id: string;
  titulo: string;
  /** Tamanho em caracteres. */
  letras: number;
  criadoEm: string | null;
  /** Só vem quando pedido (para montar as instruções da IA). */
  conteudo?: string;
}

/** Os campos que a pessoa edita numa base de treinamento. */
export interface CamposDaBase {
  rotulo: string;
  nomeDoNegocio: string;
  nicho: string;
  nomeDoAtendente: string;
  tom: Tom;
  /** O WhatsApp é de uma pessoa só, que fala como "eu", sem citar empresa nem equipe. */
  primeiraPessoa: boolean;
  resumo: string;
  condicoes: string;
  regras: string;
  instrucoesExtras: string;
  /** Depois de passar para uma pessoa, a IA só volta quando alguém mandar (um "ok" do contato não reabre). */
  travaAteRetomar: boolean;
  blindagem: boolean;
  perguntaSobreRobo: PerguntaSobreRobo;
  perguntas: PerguntaFrequente[];
}

export interface BaseDeTreinamento extends CamposDaBase {
  id: string;
  /** A base usada por todo chip que não tem base própria. */
  padrao: boolean;
  arquivos: ArquivoDeConhecimento[];
  atualizadaEm: string | null;
  /**
   * Sobe a cada gravação dos campos ou das perguntas (pela tela ou por uma correção feita na Inbox).
   * A tela devolve este número ao salvar; se a base já estiver em outra revisão, o banco recusa em vez
   * de apagar a mudança mais nova. `0` = o banco não informou (aí a gravação vai sem a conferência).
   */
  revisao: number;
  podeEditar: boolean;
}

export interface ResumoDaBase {
  id: string;
  rotulo: string;
  padrao: boolean;
  nomeDoNegocio: string;
  perguntas: number;
  arquivos: number;
  /** Os chips que usam esta base (os sem base própria aparecem na padrão). */
  chips: Array<{ id: string; nome: string }>;
  atualizadaEm: string | null;
}

export interface ListaDeBases {
  bases: ResumoDaBase[];
  /** Só o dono da conta altera o treinamento. */
  podeEditar: boolean;
}

/** Os mesmos limites que o banco confere. */
export const LIMITES_DO_TREINAMENTO = {
  rotulo: 60,
  nomeDoNegocio: 120,
  nicho: 120,
  nomeDoAtendente: 60,
  resumo: 4000,
  condicoes: 4000,
  regras: 8000,
  instrucoesExtras: 4000,
  pergunta: 500,
  resposta: 2000,
  /** Uma regra ensinada pela conversa (uma linha das regras de ouro). */
  regraEnsinada: 1000,
  perguntasPorBase: 100,
  bases: 10,
  arquivosPorBase: 10,
  letrasPorArquivo: 30_000,
  letrasPorBase: 120_000,
  tituloDoArquivo: 160,
} as const;

export const BASE_EM_BRANCO: CamposDaBase = {
  rotulo: 'Principal',
  nomeDoNegocio: '',
  nicho: '',
  nomeDoAtendente: '',
  tom: 'consultivo',
  primeiraPessoa: false,
  resumo: '',
  condicoes: '',
  regras: '',
  instrucoesExtras: '',
  travaAteRetomar: false,
  blindagem: true,
  perguntaSobreRobo: 'handoff',
  perguntas: [],
};

type Json = Record<string, unknown>;
const objeto = (valor: unknown): Json => (valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Json) : {});
const lista = (valor: unknown): unknown[] => (Array.isArray(valor) ? valor : []);
const texto = (valor: unknown): string => (typeof valor === 'string' ? valor : '');
const textoOuNulo = (valor: unknown): string | null => (typeof valor === 'string' && valor ? valor : null);
const numero = (valor: unknown): number => (typeof valor === 'number' && Number.isFinite(valor) ? valor : 0);

/** O tamanho de um texto do jeito que o banco conta: em caracteres de verdade (um emoji conta um). */
export const letras = (valor: string): number => Array.from(valor).length;

/** Tira espaços, tabulações e quebras de linha das pontas (o banco faz o mesmo antes de medir). */
export const aparar = (valor: string): string => valor.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');

const ORIGENS: readonly OrigemDaPergunta[] = ['manual', 'correction', 'template'];

/** Transforma o que o banco devolve em read_my_ai_agents no formato usado pela tela. Tolera campos faltando. */
export function lerListaDeBases(resposta: unknown): ListaDeBases {
  const dados = objeto(resposta);
  return {
    podeEditar: dados.can_edit === true,
    bases: lista(dados.agents)
      .map((item) => objeto(item))
      .filter((item) => typeof item.id === 'string' && item.id !== '')
      .map((item) => ({
        id: texto(item.id),
        rotulo: texto(item.label) || 'Sem nome',
        padrao: item.is_default === true,
        nomeDoNegocio: texto(item.business_name),
        perguntas: numero(item.faq_count),
        arquivos: numero(item.document_count),
        chips: lista(item.instances)
          .map((chip) => objeto(chip))
          .filter((chip) => typeof chip.id === 'string' && chip.id !== '')
          .map((chip) => ({ id: texto(chip.id), nome: texto(chip.display_name) || 'Chip sem apelido' })),
        atualizadaEm: textoOuNulo(item.updated_at),
      })),
  };
}

/** Transforma o que o banco devolve em read_my_ai_agent (ou save_my_ai_agent) numa base. `null` quando não é uma base. */
export function lerBase(resposta: unknown): BaseDeTreinamento | null {
  const dados = objeto(resposta);
  if (typeof dados.id !== 'string' || !dados.id) return null;
  return {
    id: dados.id,
    rotulo: texto(dados.label) || 'Sem nome',
    padrao: dados.is_default === true,
    nomeDoNegocio: texto(dados.business_name),
    nicho: texto(dados.niche),
    nomeDoAtendente: texto(dados.assistant_name),
    tom: ehTom(dados.tone) ? dados.tone : 'consultivo',
    primeiraPessoa: dados.solo_identity === true,
    resumo: texto(dados.company_summary),
    condicoes: texto(dados.commercial_terms),
    regras: texto(dados.golden_rules),
    instrucoesExtras: texto(dados.extra_instructions),
    travaAteRetomar: dados.lock_until_manual_resume === true,
    // A blindagem só fica desligada quando o banco diz, com todas as letras, que está desligada.
    blindagem: dados.prompt_shield_enabled !== false,
    perguntaSobreRobo: dados.robot_question_policy === 'disclose' ? 'disclose' : 'handoff',
    perguntas: lista(dados.faqs)
      .map((item) => objeto(item))
      .filter((item) => texto(item.question) !== '' && texto(item.answer) !== '')
      .map((item) => ({
        pergunta: texto(item.question),
        resposta: texto(item.answer),
        origem: ORIGENS.includes(item.source as OrigemDaPergunta) ? (item.source as OrigemDaPergunta) : 'manual',
      })),
    arquivos: lista(dados.documents)
      .map((item) => objeto(item))
      .filter((item) => typeof item.id === 'string' && item.id !== '')
      .map((item) => ({
        id: texto(item.id),
        titulo: texto(item.title) || 'Arquivo sem nome',
        letras: numero(item.char_count),
        criadoEm: textoOuNulo(item.created_at),
        ...(typeof item.content === 'string' ? { conteudo: item.content } : {}),
      })),
    atualizadaEm: textoOuNulo(dados.updated_at),
    revisao: Number.isInteger(dados.revision) && numero(dados.revision) >= 1 ? numero(dados.revision) : 0,
    podeEditar: dados.can_edit === true,
  };
}

/** Só os campos editáveis de uma base (o que a tela guarda como rascunho). */
export function camposDaBase(base: BaseDeTreinamento): CamposDaBase {
  return {
    rotulo: base.rotulo,
    nomeDoNegocio: base.nomeDoNegocio,
    nicho: base.nicho,
    nomeDoAtendente: base.nomeDoAtendente,
    tom: base.tom,
    primeiraPessoa: base.primeiraPessoa,
    resumo: base.resumo,
    condicoes: base.condicoes,
    regras: base.regras,
    instrucoesExtras: base.instrucoesExtras,
    travaAteRetomar: base.travaAteRetomar,
    blindagem: base.blindagem,
    perguntaSobreRobo: base.perguntaSobreRobo,
    perguntas: base.perguntas.map((item) => ({ ...item })),
  };
}

const CAMPOS_DE_TEXTO: ReadonlyArray<{ campo: keyof CamposDaBase & keyof typeof LIMITES_DO_TREINAMENTO; noBanco: string; nome: string }> = [
  { campo: 'rotulo', noBanco: 'label', nome: 'O nome da base' },
  { campo: 'nomeDoNegocio', noBanco: 'business_name', nome: 'O nome da empresa ou do profissional' },
  { campo: 'nicho', noBanco: 'niche', nome: 'O nicho ou área de atuação' },
  { campo: 'nomeDoAtendente', noBanco: 'assistant_name', nome: 'O nome de quem atende' },
  { campo: 'resumo', noBanco: 'company_summary', nome: 'O texto "Sobre o trabalho e diferenciais"' },
  { campo: 'condicoes', noBanco: 'commercial_terms', nome: 'O texto "Pagamentos, entrega, endereço e horários"' },
  { campo: 'regras', noBanco: 'golden_rules', nome: 'O texto das regras de ouro' },
  { campo: 'instrucoesExtras', noBanco: 'extra_instructions', nome: 'O texto das instruções extras' },
];

const milhar = (valor: number) => valor.toLocaleString('pt-BR');

export type ConferenciaDaBase = { ok: true; paraOBanco: Json } | { ok: false; erro: string; aba: 'identidade' | 'regras' | 'perguntas' };

/**
 * Confere o que veio da tela (nunca confie no navegador) e devolve a base no formato que o banco espera
 * em save_my_ai_agent. Perguntas com os dois campos vazios são ignoradas; pela metade, são recusadas.
 */
export function conferirBase(entrada: unknown): ConferenciaDaBase {
  const dados = objeto(entrada);
  const paraOBanco: Json = {};

  for (const { campo, noBanco, nome } of CAMPOS_DE_TEXTO) {
    const aba = campo === 'regras' || campo === 'instrucoesExtras' ? 'regras' : 'identidade';
    if (typeof dados[campo] !== 'string') return { ok: false, erro: 'Não foi possível ler o formulário. Atualize a página.', aba };
    const valor = aparar(dados[campo]);
    const limite = LIMITES_DO_TREINAMENTO[campo];
    if (letras(valor) > limite) {
      return { ok: false, erro: `${nome} passou do limite: tem ${milhar(letras(valor))} caracteres e cabem ${milhar(limite)}.`, aba };
    }
    paraOBanco[noBanco] = valor;
  }
  if (paraOBanco.label === '') return { ok: false, erro: 'Dê um nome para esta base de treinamento.', aba: 'identidade' };

  if (!ehTom(dados.tom)) return { ok: false, erro: 'Escolha o tom de voz.', aba: 'identidade' };
  paraOBanco.tone = dados.tom;

  if (dados.perguntaSobreRobo !== 'handoff' && dados.perguntaSobreRobo !== 'disclose') {
    return { ok: false, erro: 'Escolha o que a IA faz quando perguntam se é um robô.', aba: 'regras' };
  }
  paraOBanco.robot_question_policy = dados.perguntaSobreRobo;

  for (const [campo, noBanco] of [
    ['primeiraPessoa', 'solo_identity'],
    ['travaAteRetomar', 'lock_until_manual_resume'],
    ['blindagem', 'prompt_shield_enabled'],
  ] as const) {
    if (typeof dados[campo] !== 'boolean') return { ok: false, erro: 'Não foi possível ler o formulário. Atualize a página.', aba: campo === 'primeiraPessoa' ? 'identidade' : 'regras' };
    paraOBanco[noBanco] = dados[campo];
  }

  if (!Array.isArray(dados.perguntas)) return { ok: false, erro: 'Não foi possível ler as perguntas frequentes. Atualize a página.', aba: 'perguntas' };
  const perguntas: Json[] = [];
  for (const [indice, item] of dados.perguntas.entries()) {
    const linha = objeto(item);
    const pergunta = aparar(texto(linha.pergunta));
    const resposta = aparar(texto(linha.resposta));
    if (!pergunta && !resposta) continue;
    const qual = `A pergunta ${indice + 1}`;
    if (!pergunta) return { ok: false, erro: `${qual} está sem a pergunta.`, aba: 'perguntas' };
    if (!resposta) return { ok: false, erro: `${qual} está sem a resposta.`, aba: 'perguntas' };
    if (letras(pergunta) > LIMITES_DO_TREINAMENTO.pergunta) {
      return { ok: false, erro: `${qual} é comprida demais: cabem ${milhar(LIMITES_DO_TREINAMENTO.pergunta)} caracteres.`, aba: 'perguntas' };
    }
    if (letras(resposta) > LIMITES_DO_TREINAMENTO.resposta) {
      return { ok: false, erro: `A resposta da pergunta ${indice + 1} é comprida demais: cabem ${milhar(LIMITES_DO_TREINAMENTO.resposta)} caracteres.`, aba: 'perguntas' };
    }
    perguntas.push({ question: pergunta, answer: resposta, source: ORIGENS.includes(linha.origem as OrigemDaPergunta) ? linha.origem : 'manual' });
  }
  if (perguntas.length > LIMITES_DO_TREINAMENTO.perguntasPorBase) {
    return { ok: false, erro: `Cabem até ${LIMITES_DO_TREINAMENTO.perguntasPorBase} perguntas frequentes por base.`, aba: 'perguntas' };
  }
  paraOBanco.faqs = perguntas;

  return { ok: true, paraOBanco };
}

/** Confere só o nome de uma base nova. Devolve o nome pronto ou a mensagem do problema. */
export function conferirRotulo(valor: unknown): { ok: true; rotulo: string } | { ok: false; erro: string } {
  const rotulo = aparar(texto(valor));
  if (!rotulo) return { ok: false, erro: 'Dê um nome para a base (por exemplo: Suporte).' };
  if (letras(rotulo) > LIMITES_DO_TREINAMENTO.rotulo) return { ok: false, erro: `O nome da base tem no máximo ${LIMITES_DO_TREINAMENTO.rotulo} caracteres.` };
  return { ok: true, rotulo };
}

// ---------------------------------------------------------------------------------------------
// Arquivos de conhecimento
// ---------------------------------------------------------------------------------------------

export const EXTENSOES_DE_CONHECIMENTO = ['.txt', '.csv', '.md', '.json'] as const;
/** Um arquivo de 30 mil caracteres ocupa no máximo 4 bytes por caractere. Acima disso, nem vale abrir. */
const BYTES_NO_MAXIMO = LIMITES_DO_TREINAMENTO.letrasPorArquivo * 4;

export type ConferenciaDoArquivo = { ok: true; titulo: string; conteudo: string; letras: number } | { ok: false; erro: string };

/**
 * Confere um arquivo de conhecimento antes de guardar: tem de ser texto de verdade (.txt, .csv, .md ou .json,
 * em UTF-8), e tem de caber INTEIRO. Um arquivo grande demais é recusado; nunca é cortado, porque a IA
 * passaria a responder com base em uma tabela pela metade sem ninguém saber.
 */
export function conferirArquivo(nome: string, bytes: Uint8Array): ConferenciaDoArquivo {
  const titulo = aparar(nome.replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, LIMITES_DO_TREINAMENTO.tituloDoArquivo);
  if (!titulo) return { ok: false, erro: 'O arquivo está sem nome.' };
  const extensao = /\.[a-z0-9]+$/i.exec(titulo)?.[0].toLowerCase() ?? '';
  if (!(EXTENSOES_DE_CONHECIMENTO as readonly string[]).includes(extensao)) {
    return { ok: false, erro: 'Só servem arquivos de texto: .txt, .csv, .md ou .json. Para PDF, Word ou planilha, copie o texto para um arquivo .txt.' };
  }
  if (bytes.length === 0) return { ok: false, erro: 'O arquivo está vazio.' };
  if (bytes.length > BYTES_NO_MAXIMO) {
    return { ok: false, erro: `O arquivo é grande demais. Cabem até ${milhar(LIMITES_DO_TREINAMENTO.letrasPorArquivo)} caracteres por arquivo; divida em arquivos menores.` };
  }

  let conteudo: string;
  try {
    conteudo = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, erro: 'O arquivo não está no formato de texto UTF-8. Abra no Bloco de Notas, use "Salvar como" e escolha a codificação UTF-8.' };
  }
  // Byte zero é sinal de arquivo que não é texto (imagem, planilha, PDF renomeado).
  if (conteudo.includes('\u0000')) return { ok: false, erro: 'Este arquivo não é de texto (parece ser uma imagem, planilha ou PDF renomeado).' };

  conteudo = aparar(conteudo.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n'));
  if (!conteudo) return { ok: false, erro: 'O arquivo está vazio.' };
  const tamanho = letras(conteudo);
  if (tamanho > LIMITES_DO_TREINAMENTO.letrasPorArquivo) {
    return {
      ok: false,
      erro: `O arquivo tem ${milhar(tamanho)} caracteres e cabem ${milhar(LIMITES_DO_TREINAMENTO.letrasPorArquivo)} por arquivo. Ele não foi cortado: divida em arquivos menores.`,
    };
  }
  return { ok: true, titulo, conteudo, letras: tamanho };
}

/** Os erros com nome que o banco devolve no Treinamento, em palavras para a tela. `null` quando não é um deles. */
export function explicarErroDoTreinamento(mensagem: string | undefined): string | null {
  switch (mensagem) {
    case 'agent_label_taken':
      return 'Já existe uma base com este nome. Escolha outro.';
    case 'agent_limit_reached':
      return `Cada conta pode ter até ${LIMITES_DO_TREINAMENTO.bases} bases de treinamento.`;
    case 'default_agent_required':
      return 'A base padrão não pode ser apagada. Escolha outra base como padrão antes.';
    case 'document_empty':
      return 'O arquivo está vazio.';
    case 'document_too_large':
      return `O arquivo passa de ${milhar(LIMITES_DO_TREINAMENTO.letrasPorArquivo)} caracteres. Divida em arquivos menores.`;
    case 'document_limit_reached':
      return `Cada base guarda até ${LIMITES_DO_TREINAMENTO.arquivosPorBase} arquivos. Apague um para anexar outro.`;
    case 'document_space_exceeded':
      return `Os arquivos desta base, somados, passariam de ${milhar(LIMITES_DO_TREINAMENTO.letrasPorBase)} caracteres. Apague ou reduza um arquivo.`;
    case 'Agent not found':
      return 'Esta base de treinamento não existe mais. Atualize a página.';
    case 'Document not found':
      return 'Este arquivo não existe mais. Atualize a página.';
    case 'Instance not found':
      return 'Este chip não existe mais. Atualize a página.';
    case 'agent_changed':
      return 'Esta base foi alterada em outro lugar depois que você abriu esta tela (por exemplo, por uma correção feita na Inbox). Para não apagar essa alteração, nada foi salvo. Recarregue a página e refaça o que você mudou aqui.';
    case 'faq_limit_reached':
      return `Esta base já tem ${LIMITES_DO_TREINAMENTO.perguntasPorBase} perguntas frequentes. Remova alguma no Treinamento para guardar outra.`;
    case 'rules_limit_reached':
      return `As regras de ouro desta base estão cheias (cabem ${milhar(LIMITES_DO_TREINAMENTO.regras)} caracteres). Resuma alguma regra no Treinamento para guardar outra.`;
    case 'ai_training_missing':
      return 'Esta conta ainda não tem uma base de treinamento. Crie a primeira na aba Treinamento.';
    case 'Message not found':
      return 'Esta mensagem não existe mais. Atualize a página.';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Modelos prontos ("começar do zero com um modelo pronto")
// ---------------------------------------------------------------------------------------------

export interface ModeloPronto {
  id: string;
  /** Um emoji que identifica o ramo. */
  icone: string;
  nome: string;
  descricao: string;
  base: Omit<CamposDaBase, 'rotulo' | 'blindagem' | 'perguntaSobreRobo' | 'perguntas'> & { perguntas: Array<{ pergunta: string; resposta: string }> };
}

/** Os modelos por ramo de negócio, trazidos do painel antigo (os textos são os mesmos). */
export const MODELOS_PRONTOS: readonly ModeloPronto[] = MODELOS_PRONTOS_DADOS as unknown as readonly ModeloPronto[];

/**
 * Aplica um modelo pronto sobre os campos de uma base: troca os textos e as perguntas frequentes.
 * O nome da base, a blindagem e a resposta para "é um robô?" ficam como estavam.
 */
export function aplicarModelo(atual: CamposDaBase, modelo: ModeloPronto): CamposDaBase {
  return {
    ...atual,
    ...modelo.base,
    perguntas: modelo.base.perguntas.map((item) => ({ pergunta: item.pergunta, resposta: item.resposta, origem: 'template' as const })),
  };
}
