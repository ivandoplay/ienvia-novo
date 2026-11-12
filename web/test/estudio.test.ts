import { describe, expect, test } from 'vitest';
import {
  ESTUDIO_VAZIO,
  caminhoSeguroNoZip,
  conferirEstudio,
  exportarTreinamentoZip,
  extrairEstudioDeDocumentos,
  gerarProximoCodigo,
  gerarZipDoTreinamento,
  importarPacoteDoTreinamento,
  lerEstudioDoBanco,
  lerZipDoTreinamento,
  selecionarContextoDoTurno,
} from '@/lib/ia/estudio';
import { BASE_EM_BRANCO } from '@/lib/ia/treinamento';

const enc = (t: string) => new TextEncoder().encode(t);

describe('Estúdio: leitura, validação e códigos', () => {
  test('lê do banco em snake_case e devolve validado para gravar de volta', () => {
    const doBanco = {
      approved_messages: [{ id: 'M01', title: 'Abertura', category: 'Abertura', text: 'Oi, tudo bem?', enabled: true }],
      operational_skills: [{ id: 'S01', name: 'Abertura leve', when: 'Primeiro contato', example_response: 'Oi!', body_md: '# S01', enabled: true }],
      humanization_skills: [{ id: 'H01', name: 'Tom curto', trigger: 'Sempre', goal: 'Soar humano', avoid: 'Textão', bad_response: 'Prezados...', better_response: 'Oi!', enabled: true }],
      objections: [{ id: 'O001', input_pattern: 'Está caro', nature: 'Preço', skill_id: 'S15', response_strategy: 'Entender momento', avoid: 'Desconto', enabled: true }],
      brain_pack: { id: 'p1', name: 'Pacote A', version: '2.0', context_mode: 'smart', playbook_central: 'Seja direto.', canonical_rules: 'Sem travessão.' },
    };

    const lido = lerEstudioDoBanco(doBanco);
    expect(lido.mensagensAprovadas).toHaveLength(1);
    expect(lido.habilidadesOperacionais[0]?.id).toBe('S01');
    expect(lido.habilidadesDeHumanizacao[0]?.respostaMelhor).toBe('Oi!');
    expect(lido.objecoes[0]?.padraoDeEntrada).toBe('Está caro');
    expect(lido.cerebroCompleto?.modoDeContexto).toBe('inteligente');

    const conferido = conferirEstudio(lido);
    expect(conferido.ok).toBe(true);
    if (conferido.ok) {
      expect(lerEstudioDoBanco(conferido.paraOBanco)).toMatchObject({
        mensagensAprovadas: lido.mensagensAprovadas,
        habilidadesOperacionais: lido.habilidadesOperacionais,
        objecoes: lido.objecoes,
      });
    }
  });

  test('recusa códigos duplicados e campos inválidos com aba certa', () => {
    const dup = conferirEstudio({
      mensagensAprovadas: [
        { id: 'M01', titulo: 'Um', categoria: '', texto: 'A', ativa: true },
        { id: 'm01', titulo: 'Dois', categoria: '', texto: 'B', ativa: true },
      ],
    });
    expect(dup).toEqual({ ok: false, erro: 'Código duplicado nas mensagens prontas: m01.', aba: 'mensagens' });

    const skillDup = conferirEstudio({
      habilidadesOperacionais: [
        { id: 'S01', nome: 'A', quando: '', exemploDeResposta: '', conteudoMd: '', ativa: true },
        { id: 'S01', nome: 'B', quando: '', exemploDeResposta: '', conteudoMd: '', ativa: true },
      ],
    });
    expect(skillDup).toMatchObject({ ok: false, aba: 'skills' });

    expect(gerarProximoCodigo([{ id: 'M01' }, { id: 'M02' }], 'M', 2)).toBe('M03');
    expect(gerarProximoCodigo([{ id: 'O001' }], 'O', 3)).toBe('O002');
  });
});

describe('ZIP puro e proteção Zip-Slip', () => {
  test('caminhos inseguros são bloqueados', () => {
    expect(caminhoSeguroNoZip('03-skills/indice.json')).toBe(true);
    for (const ruim of ['../etc/passwd', '/etc/passwd', 'a\\b', 'C:foo', 'a/../b', '']) {
      expect(caminhoSeguroNoZip(ruim), ruim).toBe(false);
    }
    expect(() => gerarZipDoTreinamento([{ caminho: '../fora.txt', conteudo: 'x' }])).toThrow(/inválido/);
  });

  test('gera e relê um ZIP de backup completo sem perda de dados', async () => {
    const zip = exportarTreinamentoZip({
      ...BASE_EM_BRANCO,
      rotulo: 'Lizandro',
      nomeDoNegocio: 'Lizandro Celestino',
      gatilhosDeRepasse: 'Pediu preço fechado',
      perguntas: [{ pergunta: 'Faz gestão?', resposta: 'Sim, de ponta a ponta.', origem: 'manual' }],
      estudio: {
        ...ESTUDIO_VAZIO,
        mensagensAprovadas: [{ id: 'M01', titulo: 'Abertura', categoria: 'Abertura', texto: 'Olá, como posso ajudar?', ativa: true }],
        habilidadesOperacionais: [{ id: 'S01', nome: 'Abertura leve', quando: 'Primeiro oi', exemploDeResposta: 'Oi!', conteudoMd: '', ativa: true }],
      },
    });
    const entradas = await lerZipDoTreinamento(zip);
    expect(entradas.some((e) => e.caminho === 'ienvia-treinamento-completo.json')).toBe(true);

    const importado = await importarPacoteDoTreinamento(zip, 'backup.zip');
    expect(importado.sugestaoIdentidade.nomeDoNegocio).toBe('Lizandro Celestino');
    expect(importado.sugestaoIdentidade.gatilhosDeRepasse).toBe('Pediu preço fechado');
    expect(importado.estudio.mensagensAprovadas[0]?.id).toBe('M01');
    expect(importado.estudio.habilidadesOperacionais[0]?.id).toBe('S01');
  });
});

describe('Importador do Pacote Turbo e extrator de documentos', () => {
  test('importa estrutura de pastas estilo PACOTE-LIZANDRO-CELESTINO.zip', async () => {
    const zip = gerarZipDoTreinamento([
      {
        caminho: 'PACOTE-TESTE/fatos-do-negocio.json',
        conteudo: JSON.stringify({ representative: 'Lizandro Celestino', commercial_name_from_approved_material: 'Gestão Estratégica', niche: 'Tráfego Pago', solo_identity: true }),
      },
      {
        caminho: 'PACOTE-TESTE/m01-a-m13-originais.json',
        conteudo: JSON.stringify({ titulos: { M01: 'Abertura', M02: 'Valor' }, textos: { M01: 'Oi, tudo bem?', M02: 'Vamos avaliar seu momento.' } }),
      },
      {
        caminho: 'PACOTE-TESTE/03-skills/indice-skills.json',
        conteudo: JSON.stringify([{ id: 'S15', name: 'Preço e orçamento', when: 'Cliente pergunta quanto custa', path: '03-skills/s15/SKILL.md' }]),
      },
      {
        caminho: 'PACOTE-TESTE/03-skills/s15/SKILL.md',
        conteudo: '# Skill S15\nValide objetivo antes de chamar humano.',
      },
      {
        caminho: 'PACOTE-TESTE/12-humanizacao/indice-skills-humanizacao.json',
        conteudo: JSON.stringify([{ id: 'H01', name: 'Escrita natural', trigger: 'Sempre', goal: 'Frases curtas', avoid: 'Travessão' }]),
      },
      {
        caminho: 'PACOTE-TESTE/04-respostas/matriz-de-duvidas-e-objecoes.json',
        conteudo: JSON.stringify([{ id: 'O001', input_pattern: 'Já perdi dinheiro com agência', nature: 'Ceticismo', skill_id: 'S09', response_strategy: 'Acolher sem prometer milagre' }]),
      },
      {
        caminho: 'PACOTE-TESTE/11-personas/indice-personas.json',
        conteudo: JSON.stringify({ voice_filters: ['Sem clichê corporativo'], interlocutor_profiles: [{ id: 'P01', name: 'Empresário cético', signals: 'agencia, ja perdi dinheiro' }] }),
      },
    ]);

    const res = await importarPacoteDoTreinamento(zip, 'PACOTE-TESTE.zip');
    expect(res.resumo).toMatchObject({ mensagens: 2, skillsOperacionais: 1, skillsHumanizacao: 1, objecoes: 1, personas: 1 });
    expect(res.sugestaoIdentidade).toMatchObject({ nomeDoNegocio: 'Lizandro Celestino', nomeDoAtendente: 'Lizandro', primeiraPessoa: true });
    expect(res.estudio.habilidadesOperacionais[0]?.conteudoMd).toContain('Skill S15');
  });

  test('extrai M/S/H/O de documentos Markdown compilados', () => {
    const ext = extrairEstudioDeDocumentos([
      { titulo: '01-playbook-M01.md', conteudo: '## Playbook\nRegras.\n\n## M01 - Boas-vindas\nOlá! Como posso te ajudar?\n\n## M02 - Áudio\nJá escuto seu áudio.' },
      { titulo: '02-skills.md', conteudo: '## S01 - Primeiro contato\n**Quando usar:** No primeiro oi\n\n## H01 - Mensagem curta\nMantenha até 3 linhas.\n\n## O001: Tá caro\nMostre retorno e qualifique.' },
    ]);
    expect(ext.mensagensAprovadas.map((m) => m.id)).toEqual(['M01', 'M02']);
    expect(ext.habilidadesOperacionais.map((s) => s.id)).toEqual(['S01']);
    expect(ext.habilidadesDeHumanizacao.map((h) => h.id)).toEqual(['H01']);
    expect(ext.objecoes.map((o) => o.id)).toEqual(['O001']);
  });

  test('rejeita arquivo inválido ou vazio', async () => {
    await expect(importarPacoteDoTreinamento(enc(''), 'vazio.json')).rejects.toThrow(/vazio/);
    await expect(importarPacoteDoTreinamento(enc('{ruim'), 'quebrado.json')).rejects.toThrow(/JSON inválido/);
  });
});

describe('selecionarContextoDoTurno', () => {
  const estudioRico = {
    mensagensAprovadas: [
      { id: 'M01', titulo: 'Abertura', categoria: 'Abertura', texto: 'Oi, tudo bem?', ativa: true },
      { id: 'M09', titulo: 'Orçamento e valor', categoria: 'Comercial', texto: 'Depende do seu objetivo atual.', ativa: true },
      { id: 'M99', titulo: 'Inativa', categoria: '', texto: 'Não entra', ativa: false },
    ],
    habilidadesOperacionais: [
      { id: 'S01', nome: 'Abertura leve', quando: 'Primeiro oi', exemploDeResposta: '', conteudoMd: '', ativa: true },
      { id: 'S15', nome: 'Preço e investimento', quando: 'Quando perguntam quanto custa ou mensalidade', exemploDeResposta: '', conteudoMd: '', ativa: true },
    ],
    habilidadesDeHumanizacao: [
      { id: 'H01', nome: 'Frases curtas', gatilho: 'Sempre', objetivo: 'Sem textão', evitar: '', respostaRuim: '', respostaMelhor: '', conteudoMd: '', ativa: true },
    ],
    objecoes: [
      { id: 'O001', padraoDeEntrada: 'Já perdi dinheiro com agência antes', natureza: 'Ceticismo', skillId: 'S09', estrategiaDeResposta: 'Validar frustração', evitar: '', ativa: true },
    ],
    cerebroCompleto: {
      id: 'c1',
      nome: 'Cérebro',
      versao: '1',
      importadoEm: null,
      modoDeContexto: 'inteligente' as const,
      playbookCentral: 'Playbook',
      regrasCanonicas: 'Regras',
      fatosDoNegocio: {},
      filtrosDeVoz: [],
      personas: [],
      paresBomRuim: [],
      respostasDeReferencia: [],
    },
  };

  test('modo inteligente prioriza itens ligados ao turno atual e oculta inativos', () => {
    const sel = selecionarContextoDoTurno(estudioRico, { mensagemAtual: 'Quanto custa a mensalidade? Já perdi dinheiro com agência.' });
    expect(sel.mensagens.some((m) => m.id === 'M09')).toBe(true);
    expect(sel.mensagens.some((m) => m.id === 'M99')).toBe(false);
    expect(sel.skillsOperacionais[0]?.id).toBe('S15');
    expect(sel.objecoes[0]?.id).toBe('O001');
  });

  test('modo completo entrega todos os itens ativos', () => {
    const full = { ...estudioRico, cerebroCompleto: { ...estudioRico.cerebroCompleto, modoDeContexto: 'completo' as const } };
    const sel = selecionarContextoDoTurno(full, { mensagemAtual: 'Oi' });
    expect(sel.mensagens.map((m) => m.id)).toEqual(['M01', 'M09']);
    expect(sel.skillsOperacionais.map((s) => s.id)).toEqual(['S01', 'S15']);
  });
});
