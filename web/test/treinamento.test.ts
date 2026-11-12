/** Regras do Treinamento: o que a tela aceita, o que recusa, e os arquivos de conhecimento. */
import { describe, expect, test } from 'vitest';
import {
  BASE_EM_BRANCO,
  LIMITES_DO_TREINAMENTO,
  MODELOS_PRONTOS,
  TONS,
  aplicarModelo,
  camposDaBase,
  conferirArquivo,
  conferirBase,
  conferirRotulo,
  explicarErroDoTreinamento,
  lerBase,
  lerListaDeBases,
  letras,
  type CamposDaBase,
} from '@/lib/ia/treinamento';

const em = (texto: string) => new TextEncoder().encode(texto);
const com = (mudancas: Partial<CamposDaBase>): CamposDaBase => ({ ...BASE_EM_BRANCO, ...mudancas });

/** O que o banco devolve em read_my_ai_agent para uma base preenchida. */
const DO_BANCO = {
  id: 'e1000000-0000-4000-8000-000000000001',
  label: 'Principal',
  is_default: true,
  business_name: 'Flor de Sal Moda',
  niche: 'Moda feminina',
  assistant_name: 'Lia',
  tone: 'acolhedor',
  solo_identity: false,
  company_summary: 'Loja de moda feminina.',
  commercial_terms: 'PIX e cartão.',
  golden_rules: '- Nunca invente preço.',
  extra_instructions: '',
  lock_until_manual_resume: true,
  prompt_shield_enabled: false,
  robot_question_policy: 'disclose',
  updated_at: '2026-11-11T12:00:00Z',
  faqs: [
    { id: 'f1', question: 'Entregam?', answer: 'Sim.', source: 'manual' },
    { id: 'f2', question: 'Tem provador?', answer: 'Temos dois.', source: 'correction' },
  ],
  documents: [{ id: 'd1', title: 'precos.csv', char_count: 25, created_at: '2026-11-10T10:00:00Z' }],
  can_edit: true,
};

describe('ler o que o banco devolve', () => {
  test('uma base inteira vira os campos da tela', () => {
    const base = lerBase(DO_BANCO);
    expect(base).toMatchObject({
      id: DO_BANCO.id,
      rotulo: 'Principal',
      padrao: true,
      nomeDoNegocio: 'Flor de Sal Moda',
      nomeDoAtendente: 'Lia',
      tom: 'acolhedor',
      primeiraPessoa: false,
      travaAteRetomar: true,
      blindagem: false,
      perguntaSobreRobo: 'disclose',
      podeEditar: true,
      atualizadaEm: '2026-11-11T12:00:00Z',
    });
    expect(base?.perguntas).toEqual([
      { pergunta: 'Entregam?', resposta: 'Sim.', origem: 'manual' },
      { pergunta: 'Tem provador?', resposta: 'Temos dois.', origem: 'correction' },
    ]);
    // Sem pedir, o conteúdo dos arquivos não vem.
    expect(base?.arquivos).toEqual([{ id: 'd1', titulo: 'precos.csv', letras: 25, criadoEm: '2026-11-10T10:00:00Z' }]);
    expect(lerBase({ ...DO_BANCO, documents: [{ id: 'd1', title: 'a.txt', char_count: 3, content: 'abc' }] })?.arquivos[0]).toMatchObject({ conteudo: 'abc' });
  });

  test('resposta estranha não vira base; campo faltando cai no padrão seguro', () => {
    for (const valor of [null, undefined, 'texto', 7, [], {}, { id: '' }]) expect(lerBase(valor), String(valor)).toBeNull();
    const minima = lerBase({ id: 'x' });
    expect(minima).toMatchObject({ rotulo: 'Sem nome', tom: 'consultivo', perguntaSobreRobo: 'handoff', padrao: false, podeEditar: false, perguntas: [], arquivos: [] });
    // A blindagem só fica desligada quando o banco diz que está desligada.
    expect(minima?.blindagem).toBe(true);
    expect(lerBase({ id: 'x', tone: 'agressivo', robot_question_policy: 'negar' })).toMatchObject({ tom: 'consultivo', perguntaSobreRobo: 'handoff' });
  });

  test('a lista das bases, com os chips de cada uma', () => {
    const lista = lerListaDeBases({
      can_edit: true,
      agents: [
        { id: 'a1', label: 'Principal', is_default: true, business_name: 'Flor de Sal', faq_count: 3, document_count: 1, updated_at: '2026-11-11T12:00:00Z', instances: [{ id: 'c1', display_name: 'Vendas' }] },
        { id: 'a2', label: 'Suporte', is_default: false, business_name: '', faq_count: 0, document_count: 0, instances: [{ id: 'c2', display_name: '' }, { nada: true }] },
        { semId: true },
      ],
    });
    expect(lista.podeEditar).toBe(true);
    expect(lista.bases).toEqual([
      { id: 'a1', rotulo: 'Principal', padrao: true, nomeDoNegocio: 'Flor de Sal', perguntas: 3, arquivos: 1, chips: [{ id: 'c1', nome: 'Vendas' }], atualizadaEm: '2026-11-11T12:00:00Z' },
      { id: 'a2', rotulo: 'Suporte', padrao: false, nomeDoNegocio: '', perguntas: 0, arquivos: 0, chips: [{ id: 'c2', nome: 'Chip sem apelido' }], atualizadaEm: null },
    ]);
    for (const valor of [null, 'x', {}, { agents: 'nada' }]) expect(lerListaDeBases(valor)).toEqual({ bases: [], podeEditar: false });
  });
});

describe('conferir a base antes de gravar', () => {
  test('uma base boa vira o formato do banco, com os textos aparados', () => {
    const conferida = conferirBase(
      com({
        rotulo: '  Principal ',
        nomeDoNegocio: ' Flor de Sal Moda\n',
        tom: 'acolhedor',
        regras: '\n- Nunca invente preço.\n\n',
        primeiraPessoa: true,
        perguntaSobreRobo: 'disclose',
        perguntas: [
          { pergunta: ' Entregam? ', resposta: ' Sim, em Piracuruca. ', origem: 'manual' },
          { pergunta: '', resposta: '   ', origem: 'manual' },
          { pergunta: 'Tem provador?', resposta: 'Temos dois.', origem: 'template' },
        ],
      }),
    );
    expect(conferida).toEqual({
      ok: true,
      paraOBanco: {
        label: 'Principal',
        business_name: 'Flor de Sal Moda',
        niche: '',
        assistant_name: '',
        company_summary: '',
        commercial_terms: '',
        golden_rules: '- Nunca invente preço.',
        extra_instructions: '',
        tone: 'acolhedor',
        robot_question_policy: 'disclose',
        solo_identity: true,
        lock_until_manual_resume: false,
        prompt_shield_enabled: true,
        // A linha em branco some; as outras ficam na ordem.
        faqs: [
          { question: 'Entregam?', answer: 'Sim, em Piracuruca.', source: 'manual' },
          { question: 'Tem provador?', answer: 'Temos dois.', source: 'template' },
        ],
      },
    });
  });

  test('cada problema é recusado com uma frase clara e diz em qual aba está', () => {
    const casos: Array<[unknown, RegExp, string]> = [
      [null, /Atualize a página/, 'identidade'],
      [com({ rotulo: '   ' }), /Dê um nome para esta base/, 'identidade'],
      [com({ rotulo: 'x'.repeat(61) }), /O nome da base passou do limite: tem 61 caracteres e cabem 60/, 'identidade'],
      [com({ nomeDoNegocio: 'x'.repeat(121) }), /nome da empresa ou do profissional passou do limite/, 'identidade'],
      [com({ resumo: 'x'.repeat(4001) }), /tem 4\.001 caracteres e cabem 4\.000/, 'identidade'],
      [com({ regras: 'x'.repeat(8001) }), /regras de ouro passou do limite/, 'regras'],
      [com({ instrucoesExtras: 'x'.repeat(4001) }), /instruções extras passou do limite/, 'regras'],
      [com({ tom: 'agressivo' as never }), /tom de voz/, 'identidade'],
      [com({ perguntaSobreRobo: 'negar' as never }), /quando perguntam se é um robô/, 'regras'],
      [com({ blindagem: 'sim' as never }), /Atualize a página/, 'regras'],
      [com({ primeiraPessoa: undefined as never }), /Atualize a página/, 'identidade'],
      [com({ perguntas: 'nenhuma' as never }), /perguntas frequentes/, 'perguntas'],
      [com({ perguntas: [{ pergunta: 'Entregam?', resposta: '', origem: 'manual' }] }), /A pergunta 1 está sem a resposta/, 'perguntas'],
      [com({ perguntas: [{ pergunta: 'A?', resposta: 'B', origem: 'manual' }, { pergunta: ' ', resposta: 'Sim', origem: 'manual' }] }), /A pergunta 2 está sem a pergunta/, 'perguntas'],
      [com({ perguntas: [{ pergunta: 'x'.repeat(501), resposta: 'ok', origem: 'manual' }] }), /A pergunta 1 é comprida demais: cabem 500/, 'perguntas'],
      [com({ perguntas: [{ pergunta: 'ok?', resposta: 'x'.repeat(2001), origem: 'manual' }] }), /A resposta da pergunta 1 é comprida demais: cabem 2\.000/, 'perguntas'],
      [com({ perguntas: Array.from({ length: 101 }, (_, i) => ({ pergunta: `P${i}`, resposta: 'R', origem: 'manual' as const })) }), /até 100 perguntas/, 'perguntas'],
    ];
    for (const [entrada, mensagem, aba] of casos) {
      const resultado = conferirBase(entrada);
      expect(resultado.ok, mensagem.source).toBe(false);
      if (!resultado.ok) {
        expect(resultado.erro).toMatch(mensagem);
        expect(resultado.aba, mensagem.source).toBe(aba);
      }
    }
  });

  test('os limites exatos passam, e o tamanho é contado como o banco conta (um emoji = um caractere)', () => {
    expect(letras('abc')).toBe(3);
    expect(letras('😀😀')).toBe(2);
    expect(conferirBase(com({ rotulo: '😀'.repeat(60), regras: 'x'.repeat(8000), resumo: 'é'.repeat(4000) })).ok).toBe(true);
    expect(conferirBase(com({ perguntas: Array.from({ length: 100 }, (_, i) => ({ pergunta: `P${i}`, resposta: 'x'.repeat(2000), origem: 'manual' as const })) })).ok).toBe(true);
    // Os limites da tela são os mesmos do banco (supabase/tests/ia.test.ts confere o lado de lá).
    expect(LIMITES_DO_TREINAMENTO).toMatchObject({ rotulo: 60, regras: 8000, pergunta: 500, resposta: 2000, perguntasPorBase: 100, bases: 10, arquivosPorBase: 10, letrasPorArquivo: 30000, letrasPorBase: 120000 });
  });

  test('o nome de uma base nova', () => {
    expect(conferirRotulo('  Suporte ')).toEqual({ ok: true, rotulo: 'Suporte' });
    expect(conferirRotulo('')).toMatchObject({ ok: false });
    expect(conferirRotulo(undefined)).toMatchObject({ ok: false });
    expect(conferirRotulo('x'.repeat(61))).toMatchObject({ ok: false, erro: expect.stringMatching(/no máximo 60/) });
  });

  test('ler do banco e conferir de volta dá a mesma base (nada se perde no caminho)', () => {
    const base = lerBase(DO_BANCO)!;
    const conferida = conferirBase(camposDaBase(base));
    expect(conferida).toMatchObject({
      ok: true,
      paraOBanco: {
        label: DO_BANCO.label,
        business_name: DO_BANCO.business_name,
        tone: DO_BANCO.tone,
        golden_rules: DO_BANCO.golden_rules,
        lock_until_manual_resume: true,
        prompt_shield_enabled: false,
        robot_question_policy: 'disclose',
        faqs: [
          { question: 'Entregam?', answer: 'Sim.', source: 'manual' },
          { question: 'Tem provador?', answer: 'Temos dois.', source: 'correction' },
        ],
      },
    });
  });
});

describe('arquivos de conhecimento', () => {
  test('texto de verdade entra inteiro, com as quebras de linha arrumadas', () => {
    expect(conferirArquivo('Tabela de preços.csv', em('\ufeffproduto;preço\r\nvestido;120\r\n\r\n'))).toEqual({
      ok: true,
      titulo: 'Tabela de preços.csv',
      conteudo: 'produto;preço\nvestido;120',
      letras: 25,
    });
    for (const nome of ['a.txt', 'A.TXT', 'manual.md', 'dados.json', 'lista.csv']) expect(conferirArquivo(nome, em('conteúdo')).ok, nome).toBe(true);
    // Um .json que não é JSON válido continua sendo texto que a IA consegue ler.
    expect(conferirArquivo('dados.json', em('{ quase json')).ok).toBe(true);
  });

  test('o que não é texto é recusado com a explicação do que fazer', () => {
    for (const nome of ['foto.png', 'contrato.pdf', 'planilha.xlsx', 'documento.docx', 'sem-extensao', 'arquivo.txt.exe']) {
      expect(conferirArquivo(nome, em('abc')), nome).toMatchObject({ ok: false, erro: expect.stringMatching(/\.txt, \.csv, \.md ou \.json/) });
    }
    expect(conferirArquivo('   ', em('abc'))).toMatchObject({ ok: false, erro: 'O arquivo está sem nome.' });
    expect(conferirArquivo('vazio.txt', new Uint8Array())).toMatchObject({ ok: false, erro: 'O arquivo está vazio.' });
    expect(conferirArquivo('so-espacos.txt', em(' \n\t\r\n '))).toMatchObject({ ok: false, erro: 'O arquivo está vazio.' });
    // Uma planilha antiga salva em "ANSI" (Latin-1) não é UTF-8: o "ç" vira um byte solto.
    expect(conferirArquivo('precos.csv', new Uint8Array([0x70, 0x72, 0x65, 0xe7, 0x6f]))).toMatchObject({ ok: false, erro: expect.stringMatching(/UTF-8/) });
    // Um PDF renomeado para .txt.
    expect(conferirArquivo('contrato.txt', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]))).toMatchObject({ ok: false, erro: expect.stringMatching(/não é de texto/) });
  });

  test('arquivo grande demais é recusado inteiro: nunca é cortado', () => {
    const noLimite = conferirArquivo('grande.txt', em('é'.repeat(30_000)));
    expect(noLimite).toMatchObject({ ok: true, letras: 30_000 });
    if (noLimite.ok) expect(noLimite.conteudo).toHaveLength(30_000);

    const passou = conferirArquivo('grande.txt', em('a'.repeat(30_001)));
    expect(passou).toEqual({ ok: false, erro: 'O arquivo tem 30.001 caracteres e cabem 30.000 por arquivo. Ele não foi cortado: divida em arquivos menores.' });
    expect(conferirArquivo('enorme.txt', new Uint8Array(120_001).fill(97))).toMatchObject({ ok: false, erro: expect.stringMatching(/grande demais/) });
  });

  test('o nome do arquivo vira o título, limpo e sem passar do limite', () => {
    expect(conferirArquivo(`  nome\tcom\ncontrole.txt `, em('abc'))).toMatchObject({ ok: true, titulo: 'nome com controle.txt' });
    const longo = conferirArquivo(`${'n'.repeat(200)}.txt`, em('abc'));
    // Cortado no limite, o nome perde a extensão: o arquivo é recusado em vez de entrar com um título enganoso.
    expect(longo.ok).toBe(false);
    expect(conferirArquivo(`${'n'.repeat(156)}.txt`, em('abc'))).toMatchObject({ ok: true, titulo: `${'n'.repeat(156)}.txt` });
  });
});

describe('modelos prontos', () => {
  test('são os nove do painel antigo, e todos cabem nos limites do banco', () => {
    expect(MODELOS_PRONTOS.map((modelo) => modelo.id)).toEqual([
      'assessoria_lizandro_turbo',
      'loja_varejo',
      'clinica_agendamento',
      'delivery_restaurante',
      'assistencia_servicos',
      'imobiliaria_corretor',
      'infoprodutos_digital',
      'profissional_liberal_solo',
      'saas_software_recorrente',
    ]);
    for (const modelo of MODELOS_PRONTOS) {
      expect(modelo.nome, modelo.id).not.toBe('');
      expect(modelo.descricao, modelo.id).not.toBe('');
      expect(TONS.map((tom) => tom.valor), modelo.id).toContain(modelo.base.tom);
      const aplicada = aplicarModelo(BASE_EM_BRANCO, modelo);
      expect(conferirBase(aplicada), modelo.id).toMatchObject({ ok: true });
      expect(aplicada.perguntas.every((item) => item.origem === 'template')).toBe(true);
    }
    // Do painel antigo saíram só os dois trechos que mandavam a IA afirmar que era a própria pessoa digitando.
    const textos = JSON.stringify(MODELOS_PRONTOS);
    expect(textos).not.toMatch(/Sou eu mesmo|deve sempre saber que está falando diretamente/);
    expect(MODELOS_PRONTOS.find((modelo) => modelo.id === 'profissional_liberal_solo')?.base.perguntas).toEqual([]);
    expect(MODELOS_PRONTOS.filter((modelo) => modelo.base.perguntas.length === 0)).toHaveLength(1);
    // Os dois modelos de profissional sozinho falam em primeira pessoa e travam até a pessoa retomar.
    expect(MODELOS_PRONTOS.filter((modelo) => modelo.base.primeiraPessoa).map((modelo) => modelo.id)).toEqual(['assessoria_lizandro_turbo', 'profissional_liberal_solo']);
    expect(MODELOS_PRONTOS.filter((modelo) => modelo.base.travaAteRetomar).map((modelo) => modelo.id)).toEqual(['assessoria_lizandro_turbo', 'profissional_liberal_solo']);
  });

  test('aplicar um modelo troca os textos, mas não o nome da base, a blindagem nem a resposta para "é um robô?"', () => {
    const atual = com({ rotulo: 'Suporte', blindagem: false, perguntaSobreRobo: 'disclose', resumo: 'texto antigo', perguntas: [{ pergunta: 'antiga?', resposta: 'sim', origem: 'manual' }] });
    const loja = MODELOS_PRONTOS.find((modelo) => modelo.id === 'loja_varejo')!;
    const aplicada = aplicarModelo(atual, loja);
    expect(aplicada).toMatchObject({ rotulo: 'Suporte', blindagem: false, perguntaSobreRobo: 'disclose', nomeDoNegocio: 'Loja Modelo (Varejo)', nomeDoAtendente: 'Clara', tom: 'consultivo', primeiraPessoa: false });
    expect(aplicada.resumo).toBe(loja.base.resumo);
    expect(aplicada.perguntas.map((item) => item.pergunta)).toEqual(loja.base.perguntas.map((item) => item.pergunta));
    // O modelo não é alterado por quem o usa.
    aplicada.perguntas[0]!.pergunta = 'mexida';
    expect(loja.base.perguntas[0]!.pergunta).not.toBe('mexida');
  });
});

describe('erros do banco em palavras', () => {
  test('cada erro com nome tem a sua frase; o resto não é adivinhado', () => {
    const nomes = ['agent_label_taken', 'agent_limit_reached', 'default_agent_required', 'document_empty', 'document_too_large', 'document_limit_reached', 'document_space_exceeded', 'Agent not found', 'Document not found', 'Instance not found'];
    const frases = nomes.map((nome) => explicarErroDoTreinamento(nome));
    for (const frase of frases) expect(frase).toBeTruthy();
    expect(new Set(frases).size).toBe(nomes.length);
    expect(explicarErroDoTreinamento('qualquer outra coisa')).toBeNull();
    expect(explicarErroDoTreinamento(undefined)).toBeNull();
  });
});
