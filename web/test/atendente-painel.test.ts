/**
 * A IA nas telas: o resumo da empresa (topo, Visão geral, Instâncias) e a faixa de cada conversa da Inbox.
 * Código puro: o que cada situação mostra e quais botões aparecem.
 */
import { describe, expect, test } from 'vitest';
import {
  IA_FORA_DA_CONVERSA,
  descreverIaNaConversa,
  explicarFalta,
  explicarRecusaDoChip,
  lerIaDaConversa,
  lerResumoDaIa,
  quandoVolta,
  situacaoDaIa,
  type IaDaConversa,
  type ResumoDaIa,
} from '@/lib/atendente/painel';

const AGORA = new Date('2026-11-12T17:00:00Z'); // 14:00 em Fortaleza
const DAQUI_A_POUCO = '2026-11-12T17:35:00Z'; // 14:35

const resumo = (mudancas: Partial<ResumoDaIa> = {}): ResumoDaIa => ({
  pausada: false,
  podeRetomar: true,
  podeLigarNosChips: true,
  falta: null,
  chipsComIa: 1,
  chipsRespondendo: 1,
  ...mudancas,
});

describe('o resumo da IA da empresa', () => {
  test('lê o que o banco devolve; campo faltando cai para o lado mais seguro', () => {
    expect(lerResumoDaIa({ paused: true, paused_at: '2026-11-12T17:00:00Z', can_resume: true, can_switch_chips: true, missing: 'ai_key_missing', chips_enabled: 2, chips_answering: 1 })).toEqual({
      pausada: true,
      podeRetomar: true,
      podeLigarNosChips: true,
      falta: 'chave',
      chipsComIa: 2,
      chipsRespondendo: 1,
    });
    expect(lerResumoDaIa({ missing: 'ai_training_missing' }).falta).toBe('treinamento');
    expect(lerResumoDaIa({ missing: 'outra_coisa' }).falta).toBeNull();
    expect(lerResumoDaIa(null)).toEqual({ pausada: false, podeRetomar: false, podeLigarNosChips: false, falta: null, chipsComIa: 0, chipsRespondendo: 0 });
    expect(lerResumoDaIa({ chips_enabled: '3', chips_answering: -1 })).toMatchObject({ chipsComIa: 0, chipsRespondendo: 0 });
  });

  test('em poucas palavras, para o cartão da Visão geral', () => {
    expect(situacaoDaIa(resumo({ pausada: true }))).toEqual({ rotulo: 'Pausada', detalhe: 'em todos os chips', respondendo: false });
    expect(situacaoDaIa(resumo({ chipsComIa: 0, chipsRespondendo: 0 }))).toEqual({ rotulo: 'Desligada', detalhe: 'atendimento automático', respondendo: false });
    expect(situacaoDaIa(resumo({ chipsComIa: 2, chipsRespondendo: 0 }))).toEqual({ rotulo: 'Ligada', detalhe: 'nenhum chip conectado', respondendo: false });
    expect(situacaoDaIa(resumo())).toEqual({ rotulo: 'Ligada', detalhe: 'em 1 chip', respondendo: true });
    expect(situacaoDaIa(resumo({ chipsComIa: 3, chipsRespondendo: 3 })).detalhe).toBe('em 3 chips');
    expect(situacaoDaIa(resumo({ chipsComIa: 3, chipsRespondendo: 1 })).detalhe).toBe('em 1 de 3 chips');
  });

  test('explica o que falta para ligar a IA num chip e as recusas do banco', () => {
    expect(explicarFalta('chave')).toMatch(/cadastre a chave do provedor principal na aba Motor de IA/);
    expect(explicarFalta('treinamento')).toMatch(/preencha a aba Treinamento/);
    expect(explicarRecusaDoChip('ai_key_missing')).toBe(explicarFalta('chave'));
    expect(explicarRecusaDoChip('ai_training_missing')).toBe(explicarFalta('treinamento'));
    expect(explicarRecusaDoChip('instance_unavailable')).toMatch(/ainda não responde por chips do motor local/);
    expect(explicarRecusaDoChip('Instance not found')).toMatch(/não existe mais/);
    expect(explicarRecusaDoChip('Workspace owner required')).toMatch(/Só o dono da conta/);
    expect(explicarRecusaDoChip('connection reset')).toBeNull();
    expect(explicarRecusaDoChip(undefined)).toBeNull();
  });
});

describe('quando a IA volta', () => {
  test('hoje, amanhã ou em outro dia, no fuso da operação', () => {
    expect(quandoVolta(DAQUI_A_POUCO, AGORA)).toBe('às 14:35');
    expect(quandoVolta('2026-11-13T12:10:00Z', AGORA)).toBe('amanhã às 09:10');
    expect(quandoVolta('2026-11-14T02:59:00Z', AGORA)).toBe('amanhã às 23:59');
    expect(quandoVolta('2026-11-15T12:10:00Z', AGORA)).toBe('em 15/11 às 09:10');
    expect(quandoVolta('não é data', AGORA)).toBe('');
  });
});

describe('a IA numa conversa: ler o que o banco devolve', () => {
  test('lê os campos e separa o recado em três partes', () => {
    expect(
      lerIaDaConversa({
        chip_enabled: true,
        workspace_paused: false,
        locked: false,
        paused_until: DAQUI_A_POUCO,
        pause_reason: 'handoff',
        handoff_at: '2026-11-12T16:55:00Z',
        handoff_note: 'Cenário: cliente novo | Gatilho: quer fechar | Próxima jogada: confirmar endereço',
        working: false,
      }),
    ).toEqual({
      ligadaNoChip: true,
      pausadaNaEmpresa: false,
      travada: false,
      pausadaAte: DAQUI_A_POUCO,
      motivo: 'handoff',
      recado: { cenario: 'cliente novo', gatilho: 'quer fechar', proximaJogada: 'confirmar endereço', livre: null },
      recadoEm: '2026-11-12T16:55:00Z',
      trabalhando: false,
    });
    // Sem nada (banco antigo, leitura que falhou): a IA fica de fora da conversa.
    expect(lerIaDaConversa(undefined)).toEqual(IA_FORA_DA_CONVERSA);
    expect(lerIaDaConversa({ pause_reason: 'inventado' }).motivo).toBeNull();
  });
});

describe('a faixa da IA numa conversa aberta', () => {
  const ia = (mudancas: Partial<IaDaConversa> = {}): IaDaConversa => ({ ...IA_FORA_DA_CONVERSA, ligadaNoChip: true, ...mudancas });
  const faixa = (estado: IaDaConversa, etapa: string) => descreverIaNaConversa(estado, etapa, AGORA);
  const RECADO = { cenario: 'cliente novo', gatilho: 'quer fechar', proximaJogada: 'confirmar endereço', livre: null };

  test('IA desligada no chip e sem recado: nada aparece', () => {
    expect(faixa(IA_FORA_DA_CONVERSA, 'new')).toBeNull();
    expect(faixa({ ...IA_FORA_DA_CONVERSA, motivo: 'human_reply', pausadaAte: DAQUI_A_POUCO }, 'waiting_customer')).toBeNull();
  });

  test('a IA cuidando da conversa: dá para assumir', () => {
    expect(faixa(ia(), 'ai')).toMatchObject({ tom: 'ia', titulo: 'A IA responde esta conversa', podeAssumir: true, podeDevolver: false, recado: null });
    expect(faixa(ia({ trabalhando: true }), 'ai')).toMatchObject({ tom: 'ia', titulo: 'A IA está respondendo agora', detalhe: null });
  });

  test('a última palavra não foi da IA: ela entra na próxima mensagem do contato', () => {
    for (const etapa of ['new', 'human', 'waiting_customer', 'waiting_human']) {
      expect(faixa(ia(), etapa), etapa).toMatchObject({
        tom: 'neutro',
        titulo: 'A IA responde esta conversa a partir da próxima mensagem do contato',
        podeAssumir: true,
        podeDevolver: false,
      });
    }
  });

  test('a IA passou a conversa: o recado aparece, com a hora em que ela volta, e dá para devolver', () => {
    const repassada = faixa(ia({ motivo: 'handoff', pausadaAte: DAQUI_A_POUCO, recado: RECADO }), 'waiting_human');
    expect(repassada).toEqual({
      tom: 'atencao',
      titulo: 'A IA passou esta conversa para você',
      detalhe: 'A IA volta a responder aqui às 14:35, ou antes, se você devolver a conversa.',
      recado: RECADO,
      podeAssumir: false,
      podeDevolver: true,
    });
    // Com a trava, ela só volta quando alguém devolver.
    expect(faixa(ia({ motivo: 'handoff', travada: true, recado: RECADO }), 'waiting_human')).toMatchObject({
      detalhe: 'A IA só volta a responder aqui quando você devolver a conversa.',
      podeDevolver: true,
    });
  });

  test('a pausa do repasse venceu e ninguém respondeu: o recado continua à vista', () => {
    expect(faixa(ia({ motivo: 'handoff', recado: RECADO }), 'waiting_human')).toEqual({
      tom: 'atencao',
      titulo: 'A IA passou esta conversa para você',
      detalhe: 'A IA volta a responder aqui na próxima mensagem do contato.',
      recado: RECADO,
      podeAssumir: true,
      podeDevolver: false,
    });
    // Se uma pessoa já respondeu (a conversa não está mais esperando), o repasse velho não aparece.
    expect(faixa(ia({ motivo: 'handoff', recado: RECADO }), 'waiting_customer')).toMatchObject({ tom: 'neutro', recado: null });
  });

  test.each([
    ['silent_handoff', 'A IA não respondeu esta conversa e chamou você'],
    ['uncertain_send', 'Não deu para confirmar se a resposta da IA chegou'],
    ['error', 'A IA não conseguiu responder'],
    ['safety', 'A IA parou por segurança'],
  ] as const)('repasse por %s', (motivo, titulo) => {
    expect(faixa(ia({ motivo, pausadaAte: DAQUI_A_POUCO }), 'waiting_human')).toMatchObject({ tom: 'atencao', titulo, podeDevolver: true });
  });

  test('o recado aparece mesmo depois de a IA ser desligada no chip (sem os botões)', () => {
    expect(faixa({ ...IA_FORA_DA_CONVERSA, motivo: 'error', pausadaAte: DAQUI_A_POUCO, recado: { ...RECADO, cenario: null, gatilho: null, proximaJogada: null, livre: 'A IA não respondeu.' } }, 'waiting_human')).toMatchObject({
      tom: 'atencao',
      titulo: 'A IA não conseguiu responder',
      detalhe: null,
      podeAssumir: false,
      podeDevolver: false,
    });
  });

  test('uma pessoa respondeu ou assumiu', () => {
    expect(faixa(ia({ motivo: 'human_reply', pausadaAte: DAQUI_A_POUCO }), 'waiting_customer')).toEqual({
      tom: 'neutro',
      titulo: 'Uma pessoa respondeu, e a IA parou nesta conversa',
      detalhe: 'Ela volta a responder aqui às 14:35, ou antes, se você devolver a conversa.',
      recado: null,
      podeAssumir: true,
      podeDevolver: true,
    });
    expect(faixa(ia({ motivo: 'claimed', travada: true }), 'human')).toMatchObject({ titulo: 'Esta conversa foi assumida por uma pessoa', podeAssumir: false, podeDevolver: true });
    expect(faixa(ia({ motivo: 'human_reply', travada: true }), 'waiting_customer')).toMatchObject({ titulo: 'A IA não responde nesta conversa', podeDevolver: true });
  });

  test('IA pausada na empresa: só o aviso, sem botões', () => {
    expect(faixa(ia({ pausadaNaEmpresa: true }), 'ai')).toMatchObject({ tom: 'neutro', titulo: 'A IA está pausada em todos os chips', podeAssumir: false, podeDevolver: false });
    // Num repasse, a pausa da empresa entra como detalhe.
    expect(faixa(ia({ pausadaNaEmpresa: true, motivo: 'handoff', pausadaAte: DAQUI_A_POUCO }), 'waiting_human')).toMatchObject({
      titulo: 'A IA passou esta conversa para você',
      detalhe: 'A IA está pausada em todos os chips.',
    });
  });

  test('conversa encerrada pela IA: fica a explicação; encerrada por uma pessoa: nada', () => {
    expect(faixa(ia({ motivo: 'closed', travada: true }), 'resolved')).toMatchObject({ tom: 'neutro', titulo: 'A IA se despediu e encerrou esta conversa', podeAssumir: false, podeDevolver: false });
    expect(faixa(ia({ motivo: 'opt_out', travada: true }), 'resolved')).toMatchObject({ titulo: 'O contato pediu para parar, e a IA encerrou esta conversa' });
    expect(faixa(ia({ travada: true }), 'resolved')).toBeNull();
    expect(faixa(ia({ motivo: 'handoff', travada: true }), 'archived')).toBeNull();
  });
});
