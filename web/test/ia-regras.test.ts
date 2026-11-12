/** Regras do Motor de IA: o que vale, o que é recusado e o que a tela diz. */
import { describe, expect, test } from 'vitest';
import {
  CAMPO_DO_MODELO,
  NOME_DO_PROVEDOR,
  PADRAO_DO_MOTOR,
  PROVEDORES,
  arrumarOrdem,
  conferirChave,
  conferirConfiguracao,
  configuracaoParaOBanco,
  doProvedor,
  duracaoLegivel,
  ehProvedor,
  explicarErroDeIa,
  lerMotor,
  modeloDoProvedor,
  ordemDeUso,
  provedorRecebe,
  provedoresNecessarios,
  rotaDoPedido,
  situacaoDoMotor,
  tipoDoAnexo,
  type ConfiguracaoDoMotor,
  type MotivoDoErroDeIa,
} from '@/lib/ia/regras';

/** O que o banco devolve para quem nunca gravou nada (os padrões da tabela). */
const DO_BANCO = {
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
  updated_at: null,
  keys: {},
  can_edit: true,
};

const semChave = { cadastrada: false, final: null, atualizadaEm: null };
const comChave = { cadastrada: true, final: 'x9Zk', atualizadaEm: '2026-11-11T12:00:00Z' };
const SEM_CHAVES = { gemini: semChave, openrouter: semChave, nvidia: semChave };
const com = (mudancas: Partial<ConfiguracaoDoMotor>) => ({ ...PADRAO_DO_MOTOR, ...mudancas });

describe('os provedores', () => {
  test('são três: Gemini, OpenRouter e NVIDIA', () => {
    expect(PROVEDORES).toEqual(['gemini', 'openrouter', 'nvidia']);
    for (const provedor of PROVEDORES) expect(ehProvedor(provedor)).toBe(true);
    for (const outro of ['chatgpt', 'none', '', null, undefined, 7]) expect(ehProvedor(outro), String(outro)).toBe(false);
    expect(NOME_DO_PROVEDOR).toEqual({ gemini: 'Google Gemini', openrouter: 'OpenRouter', nvidia: 'NVIDIA' });
    // O português pede "do" ou "da" conforme o nome.
    expect(PROVEDORES.map(doProvedor)).toEqual(['do Google Gemini', 'do OpenRouter', 'da NVIDIA']);
  });
});

describe('ler o que o banco devolve', () => {
  test('os padrões do painel são os mesmos do banco', () => {
    expect(lerMotor(DO_BANCO)).toEqual({ configuracao: PADRAO_DO_MOTOR, chaves: SEM_CHAVES, podeEditar: true, atualizadoEm: null });
    // E o caminho de volta dá exatamente o que o banco espera receber.
    const configuracoes: Record<string, unknown> = { ...DO_BANCO };
    for (const campo of ['updated_at', 'keys', 'can_edit']) delete configuracoes[campo];
    expect(configuracaoParaOBanco(PADRAO_DO_MOTOR)).toEqual(configuracoes);
  });

  test('lê uma configuração gravada, com a ordem de uso, as chaves e quem pode editar', () => {
    const motor = lerMotor({
      ...DO_BANCO,
      provider: 'nvidia',
      fallback_provider: 'openrouter',
      second_fallback_provider: 'gemini',
      openrouter_model: 'google/gemma-4-26b-a4b-it:free',
      nvidia_model: 'z-ai/glm-5.3-flash',
      temperature: 0.6,
      simulate_typing: false,
      updated_at: '2026-11-11T12:00:00Z',
      keys: {
        gemini: { configured: true, hint: 'x9Zk', updated_at: '2026-11-11T12:00:00Z' },
        nvidia: { configured: true, hint: null, updated_at: null },
      },
      can_edit: false,
    });
    expect(motor.configuracao).toMatchObject({
      provedor: 'nvidia',
      reserva: 'openrouter',
      segundaReserva: 'gemini',
      modeloOpenRouter: 'google/gemma-4-26b-a4b-it:free',
      modeloNvidia: 'z-ai/glm-5.3-flash',
      criatividade: 0.6,
      simularDigitando: false,
    });
    expect(motor.chaves).toEqual({ gemini: comChave, openrouter: semChave, nvidia: { cadastrada: true, final: null, atualizadaEm: null } });
    expect(motor.podeEditar).toBe(false);
    expect(motor.atualizadoEm).toBe('2026-11-11T12:00:00Z');
  });

  test('resposta estranha ou incompleta cai nos padrões, sem quebrar a tela', () => {
    for (const valor of [null, undefined, 'texto', 42, [], {}]) {
      expect(lerMotor(valor), String(valor)).toEqual({ configuracao: PADRAO_DO_MOTOR, chaves: SEM_CHAVES, podeEditar: false, atualizadoEm: null });
    }
    expect(lerMotor({ provider: 'chatgpt', temperature: 'alta', gemini_model: 'tem espaço', nvidia_model: 9, keys: 'x' }).configuracao).toEqual(PADRAO_DO_MOTOR);
    // Uma ordem incoerente vinda de fora é arrumada na leitura.
    expect(lerMotor({ provider: 'nvidia', fallback_provider: 'nvidia', second_fallback_provider: 'gemini' }).configuracao).toMatchObject({
      provedor: 'nvidia',
      reserva: 'gemini',
      segundaReserva: 'none',
    });
  });
});

describe('a ordem de uso', () => {
  test('principal, reserva e segunda reserva, sem repetir ninguém', () => {
    expect(ordemDeUso(com({}))).toEqual(['gemini']);
    expect(ordemDeUso(com({ provedor: 'nvidia', reserva: 'gemini' }))).toEqual(['nvidia', 'gemini']);
    expect(ordemDeUso(com({ provedor: 'nvidia', reserva: 'gemini', segundaReserva: 'openrouter' }))).toEqual(['nvidia', 'gemini', 'openrouter']);
    expect(provedoresNecessarios(com({ provedor: 'openrouter', reserva: 'nvidia' }))).toEqual(['openrouter', 'nvidia']);
  });

  test('uma ordem incoerente é arrumada: repetição some e a segunda reserva sobe de posto', () => {
    // Reserva igual ao principal: fica sem reserva.
    expect(arrumarOrdem({ provedor: 'gemini', reserva: 'gemini', segundaReserva: 'none' })).toEqual({ provedor: 'gemini', reserva: 'none', segundaReserva: 'none' });
    // Segunda reserva sem a primeira: sobe de posto.
    expect(arrumarOrdem({ provedor: 'gemini', reserva: 'none', segundaReserva: 'nvidia' })).toEqual({ provedor: 'gemini', reserva: 'nvidia', segundaReserva: 'none' });
    // As duas reservas iguais: fica uma só.
    expect(arrumarOrdem({ provedor: 'gemini', reserva: 'nvidia', segundaReserva: 'nvidia' })).toEqual({ provedor: 'gemini', reserva: 'nvidia', segundaReserva: 'none' });
    // Quem virou principal sai das reservas, e a outra reserva sobe.
    expect(arrumarOrdem({ provedor: 'openrouter', reserva: 'openrouter', segundaReserva: 'nvidia' })).toEqual({ provedor: 'openrouter', reserva: 'nvidia', segundaReserva: 'none' });
    // Uma ordem boa não muda.
    const boa = { provedor: 'nvidia', reserva: 'openrouter', segundaReserva: 'gemini' } as const;
    expect(arrumarOrdem(boa)).toEqual(boa);
  });

  test('cada provedor usa o modelo escolhido para ele', () => {
    const configuracao = com({ modeloGemini: 'gemini-3.8-flash', modeloOpenRouter: 'deepseek/deepseek-chat', modeloNvidia: 'z-ai/glm-5.3-flash' });
    expect(modeloDoProvedor(configuracao, 'gemini')).toBe('gemini-3.8-flash');
    expect(modeloDoProvedor(configuracao, 'openrouter')).toBe('deepseek/deepseek-chat');
    expect(modeloDoProvedor(configuracao, 'nvidia')).toBe('z-ai/glm-5.3-flash');
    for (const provedor of PROVEDORES) expect(configuracao[CAMPO_DO_MODELO[provedor]]).toBe(modeloDoProvedor(configuracao, provedor));
  });
});

describe('quem atende cada pedido', () => {
  const todos = com({ provedor: 'nvidia', reserva: 'gemini', segundaReserva: 'openrouter' });

  test('só texto: a ordem de uso inteira', () => {
    expect(rotaDoPedido(todos)).toEqual(['nvidia', 'gemini', 'openrouter']);
    expect(rotaDoPedido(todos, null)).toEqual(['nvidia', 'gemini', 'openrouter']);
    expect(rotaDoPedido(com({}))).toEqual(['gemini']);
  });

  test('foto: os três recebem (se o modelo escolhido enxerga, só o provedor diz na hora)', () => {
    expect(rotaDoPedido(todos, 'foto')).toEqual(['nvidia', 'gemini', 'openrouter']);
  });

  test('áudio e documento: só o Gemini; sem ele na ordem, ninguém atende', () => {
    expect(rotaDoPedido(todos, 'audio')).toEqual(['gemini']);
    expect(rotaDoPedido(todos, 'documento')).toEqual(['gemini']);
    expect(rotaDoPedido(com({ provedor: 'nvidia', reserva: 'openrouter' }), 'audio')).toEqual([]);
    expect(rotaDoPedido(com({ provedor: 'nvidia' }), 'documento')).toEqual([]);
    // A NVIDIA e o OpenRouter NUNCA recebem áudio: nos testes de verdade, os modelos descartaram o áudio calados.
    for (const provedor of ['nvidia', 'openrouter'] as const) {
      expect(provedorRecebe(provedor, 'audio')).toBe(false);
      expect(provedorRecebe(provedor, 'documento')).toBe(false);
      expect(provedorRecebe(provedor, 'foto')).toBe(true);
    }
    for (const tipo of ['foto', 'audio', 'documento'] as const) expect(provedorRecebe('gemini', tipo)).toBe(true);
  });

  test('o tipo do arquivo sai do tipo de conteúdo', () => {
    expect(tipoDoAnexo('image/jpeg')).toBe('foto');
    expect(tipoDoAnexo('IMAGE/WEBP')).toBe('foto');
    expect(tipoDoAnexo('audio/ogg; codecs=opus')).toBe('audio');
    expect(tipoDoAnexo(' audio/mpeg ')).toBe('audio');
    expect(tipoDoAnexo('application/pdf')).toBe('documento');
    expect(tipoDoAnexo('video/mp4')).toBe('documento');
    expect(tipoDoAnexo('')).toBe('documento');
  });
});

describe('conferir o formulário', () => {
  test('aceita uma configuração boa e arruma os detalhes', () => {
    expect(conferirConfiguracao(PADRAO_DO_MOTOR)).toEqual({ ok: true, configuracao: PADRAO_DO_MOTOR });
    const arrumada = conferirConfiguracao(com({ modeloGemini: '  gemini-3.8-flash ', modeloNvidia: ' z-ai/glm-5.3-flash\n', criatividade: 0.456, reserva: 'gemini' }));
    // Espaços saem do nome do modelo; a criatividade fica com duas casas; reserva igual ao principal vira "sem reserva".
    expect(arrumada).toMatchObject({ ok: true, configuracao: { modeloGemini: 'gemini-3.8-flash', modeloNvidia: 'z-ai/glm-5.3-flash', criatividade: 0.46, reserva: 'none' } });
    expect(conferirConfiguracao(com({ provedor: 'openrouter', reserva: 'gemini', segundaReserva: 'nvidia' }))).toMatchObject({
      ok: true,
      configuracao: { provedor: 'openrouter', reserva: 'gemini', segundaReserva: 'nvidia' },
    });
    // O que sai daqui é sempre uma ordem que o banco aceita.
    expect(conferirConfiguracao(com({ provedor: 'nvidia', reserva: 'none', segundaReserva: 'nvidia' }))).toMatchObject({
      ok: true,
      configuracao: { provedor: 'nvidia', reserva: 'none', segundaReserva: 'none' },
    });
  });

  test('recusa, com uma frase clara, cada valor que o banco também recusaria', () => {
    const casos: Array<[unknown, RegExp]> = [
      [null, /provedor principal/],
      [com({ provedor: 'chatgpt' as never }), /provedor principal/],
      [com({ reserva: 'outra' as never }), /reserva/],
      [com({ segundaReserva: 'outra' as never }), /segunda reserva/],
      [com({ segundaReserva: undefined as never }), /segunda reserva/],
      [com({ modeloGemini: '' }), /modelo do Gemini/],
      [com({ modeloGemini: 'tem espaço' }), /modelo do Gemini/],
      [com({ modeloOpenRouter: 'a'.repeat(121) }), /modelo do OpenRouter/],
      [com({ modeloNvidia: '' }), /modelo da NVIDIA/],
      [com({ modeloNvidia: 'nvidia/modelo com espaço' }), /modelo da NVIDIA/],
      [com({ criatividade: 1.1 }), /criatividade/],
      [com({ criatividade: -0.1 }), /criatividade/],
      [com({ criatividade: Number.NaN }), /criatividade/],
      [com({ criatividade: '0.5' as never }), /criatividade/],
      [com({ memoria: 3 }), /memória/],
      [com({ memoria: 61 }), /memória/],
      [com({ memoria: 10.5 }), /memória/],
      [com({ esperaEmSegundos: 0 }), /espera/],
      [com({ esperaEmSegundos: 21 }), /espera vai de 1 a 20 segundos/],
      [com({ esperaEmSegundos: 61 }), /espera/],
      [com({ minutosDePausa: 4 }), /pausa/],
      [com({ minutosDePausa: 1441 }), /pausa/],
      [com({ simularDigitando: 'sim' as never }), /opções de comportamento/],
      [com({ pausarQuandoHumanoResponde: undefined as never }), /opções de comportamento/],
    ];
    for (const [entrada, mensagem] of casos) {
      const resultado = conferirConfiguracao(entrada);
      expect(resultado.ok, JSON.stringify(entrada)).toBe(false);
      if (!resultado.ok) expect(resultado.erro).toMatch(mensagem);
    }
    // Os limites exatos passam.
    expect(conferirConfiguracao(com({ criatividade: 0, memoria: 4, esperaEmSegundos: 1, minutosDePausa: 5 })).ok).toBe(true);
    expect(conferirConfiguracao(com({ criatividade: 1, memoria: 60, esperaEmSegundos: 20, minutosDePausa: 1440 })).ok).toBe(true);
  });
});

describe('conferir uma chave colada', () => {
  const GEMINI = 'AIzaSyD-exemplo_de_chave_0123456789abcdEFG';
  const OPENROUTER = 'sk-or-v1-0123456789abcdef0123456789abcdef';
  const NVIDIA = 'nvapi-0123456789abcdefghij_KLMNOPQRSTUVWXYZ-0123456789';

  test('aceita chaves com cara de chave', () => {
    expect(conferirChave('gemini', GEMINI)).toBeNull();
    expect(conferirChave('gemini', `  ${GEMINI} \n`)).toBeNull();
    expect(conferirChave('openrouter', OPENROUTER)).toBeNull();
    expect(conferirChave('nvidia', NVIDIA)).toBeNull();
    // Formato desconhecido não é barrado: os provedores mudam o formato das chaves de tempos em tempos.
    for (const provedor of PROVEDORES) expect(conferirChave(provedor, 'chave-de-formato-novo-0123456789')).toBeNull();
  });

  test('pega os enganos comuns antes de gravar', () => {
    expect(conferirChave('gemini', '')).toMatch(/Cole a chave/);
    expect(conferirChave('gemini', '   ')).toMatch(/Cole a chave/);
    expect(conferirChave('gemini', undefined)).toMatch(/Cole a chave/);
    expect(conferirChave('gemini', 'AIzaSy curta com espaço dentro 0123456789')).toMatch(/espaços/);
    expect(conferirChave('gemini', 'AIzaSyD-chave-com-acentuação-0123456789')).toMatch(/caracteres/);
    expect(conferirChave('gemini', 'AIzaSy123')).toMatch(/curta/);
    expect(conferirChave('nvidia', 'k'.repeat(401))).toMatch(/comprido/);
  });

  test('avisa quando a chave foi colada no cartão do provedor errado', () => {
    expect(conferirChave('gemini', OPENROUTER)).toBe('Esta parece ser uma chave do OpenRouter. Cole no cartão do OpenRouter.');
    expect(conferirChave('gemini', NVIDIA)).toBe('Esta parece ser uma chave da NVIDIA. Cole no cartão da NVIDIA.');
    expect(conferirChave('openrouter', GEMINI)).toBe('Esta parece ser uma chave do Google Gemini. Cole no cartão do Google Gemini.');
    expect(conferirChave('openrouter', NVIDIA)).toMatch(/chave da NVIDIA/);
    expect(conferirChave('nvidia', GEMINI)).toMatch(/chave do Google Gemini/);
    expect(conferirChave('nvidia', OPENROUTER)).toMatch(/chave do OpenRouter/);
  });
});

describe('o Motor de IA está pronto?', () => {
  test('sem a chave do principal não está; diz exatamente o que falta', () => {
    expect(situacaoDoMotor({ configuracao: PADRAO_DO_MOTOR, chaves: SEM_CHAVES })).toEqual({
      pronta: false,
      faltas: ['Falta a chave do Google Gemini, o provedor principal.'],
      escutaAudio: false,
    });
    expect(situacaoDoMotor({ configuracao: PADRAO_DO_MOTOR, chaves: { ...SEM_CHAVES, gemini: comChave } })).toEqual({ pronta: true, faltas: [], escutaAudio: true });
    // A chave de outro provedor não ajuda quando ele não está na ordem de uso.
    expect(situacaoDoMotor({ configuracao: PADRAO_DO_MOTOR, chaves: { ...SEM_CHAVES, openrouter: comChave, nvidia: comChave } }).pronta).toBe(false);
  });

  test('com reserva sem chave, funciona, mas avisa que a reserva não vai entrar', () => {
    const configuracao = com({ provedor: 'nvidia', reserva: 'openrouter', segundaReserva: 'gemini' });
    expect(situacaoDoMotor({ configuracao, chaves: { ...SEM_CHAVES, nvidia: comChave } })).toEqual({
      pronta: true,
      faltas: ['Falta a chave do OpenRouter, a reserva.', 'Falta a chave do Google Gemini, a segunda reserva.'],
      escutaAudio: false,
    });
    expect(situacaoDoMotor({ configuracao, chaves: { gemini: comChave, openrouter: comChave, nvidia: semChave } })).toEqual({
      pronta: false,
      faltas: ['Falta a chave da NVIDIA, o provedor principal.'],
      escutaAudio: true,
    });
    expect(situacaoDoMotor({ configuracao, chaves: { gemini: comChave, openrouter: comChave, nvidia: comChave } })).toEqual({ pronta: true, faltas: [], escutaAudio: true });
  });

  test('só escuta áudio quem tem o Gemini na ordem de uso, com a chave cadastrada', () => {
    const todas = { gemini: comChave, openrouter: comChave, nvidia: comChave };
    expect(situacaoDoMotor({ configuracao: com({ provedor: 'nvidia', reserva: 'openrouter' }), chaves: todas }).escutaAudio).toBe(false);
    expect(situacaoDoMotor({ configuracao: com({ provedor: 'nvidia', reserva: 'gemini' }), chaves: todas }).escutaAudio).toBe(true);
    expect(situacaoDoMotor({ configuracao: com({ provedor: 'nvidia', reserva: 'gemini' }), chaves: { ...todas, gemini: semChave } }).escutaAudio).toBe(false);
  });
});

describe('textos para a tela', () => {
  const MOTIVOS: MotivoDoErroDeIa[] = [
    'chave_invalida',
    'chave_vazada',
    'sem_credito',
    'limite',
    'modelo_inexistente',
    'bloqueada',
    'nao_suportado',
    'indisponivel',
    'tempo',
    'rede',
    'resposta_vazia',
    'recusada',
  ];

  test('todo motivo de erro tem uma explicação própria, com o nome do provedor', () => {
    for (const provedor of PROVEDORES) {
      const frases = MOTIVOS.map((motivo) => explicarErroDeIa(motivo, provedor, 'fabricante/modelo'));
      for (const frase of frases) expect(frase, frase).toContain(NOME_DO_PROVEDOR[provedor]);
      expect(new Set(frases).size).toBe(MOTIVOS.length);
    }
  });

  test('as frases concordam com o nome de cada provedor', () => {
    expect(explicarErroDeIa('chave_invalida', 'nvidia')).toBe('A NVIDIA recusou a chave. Confira se ela foi copiada inteira e se continua ativa.');
    expect(explicarErroDeIa('chave_invalida', 'openrouter')).toMatch(/^O OpenRouter recusou a chave/);
    expect(explicarErroDeIa('sem_credito', 'nvidia')).toBe('A conta da NVIDIA está sem crédito.');
    expect(explicarErroDeIa('rede', 'nvidia')).toMatch(/falar com a NVIDIA/);
    expect(explicarErroDeIa('rede', 'gemini')).toMatch(/falar com o Google Gemini/);
    expect(explicarErroDeIa('modelo_inexistente', 'openrouter', 'fabricante/modelo')).toBe(
      'O modelo "fabricante/modelo" não existe no OpenRouter, ou não está liberado para a sua conta. Escolha outro modelo.',
    );
    expect(explicarErroDeIa('modelo_inexistente', 'nvidia')).toBe('O modelo escolhido não existe na NVIDIA, ou não está liberado para a sua conta. Escolha outro modelo.');
    expect(explicarErroDeIa('nao_suportado', 'nvidia', 'nvidia/so-texto')).toBe('O modelo "nvidia/so-texto" da NVIDIA não recebe este tipo de arquivo.');
  });

  test('chave bloqueada por ter vazado: a frase diz que só uma chave nova resolve', () => {
    const frase = explicarErroDeIa('chave_vazada', 'gemini');
    expect(frase).toMatch(/bloqueou esta chave porque ela apareceu em algum lugar público/);
    expect(frase).toMatch(/crie uma chave nova/);
  });

  test('o tempo de resposta aparece em segundos, com vírgula', () => {
    expect(duracaoLegivel(0)).toBe('0,0 s');
    expect(duracaoLegivel(840)).toBe('0,8 s');
    expect(duracaoLegivel(9940)).toBe('9,9 s');
    expect(duracaoLegivel(12400)).toBe('12 s');
    expect(duracaoLegivel(-5)).toBe('0,0 s');
  });

  test('dossiê administrativo: valida WhatsApp (só dígitos) e lista de motivos', () => {
    expect(conferirConfiguracao(com({ alertaAdminAtivo: true, alertaAdminWhatsapp: '' }))).toEqual({
      ok: false,
      erro: 'Digite o WhatsApp administrativo antes de ativar o envio automático de dossiês.',
    });
    expect(conferirConfiguracao(com({ alertaAdminAtivo: true, alertaAdminWhatsapp: '123' }))).toEqual({
      ok: false,
      erro: 'Informe o WhatsApp administrativo completo (DDI + DDD + número, com 10 a 15 dígitos). Exemplo: 5586999999999.',
    });
    expect(conferirConfiguracao(com({ alertaAdminAtivo: true, alertaAdminWhatsapp: '5586981303979', alertaAdminEventos: [] }))).toEqual({
      ok: false,
      erro: 'Escolha ao menos um motivo para disparar o dossiê administrativo.',
    });
    const ok = conferirConfiguracao(com({ alertaAdminAtivo: true, alertaAdminWhatsapp: '+55 (86) 98130-3979' }));
    expect(ok).toMatchObject({ ok: true, configuracao: { alertaAdminAtivo: true, alertaAdminWhatsapp: '5586981303979' } });
  });
});
