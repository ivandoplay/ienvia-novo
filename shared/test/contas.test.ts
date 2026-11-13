import { describe, expect, test } from 'vitest';
import {
  MARCA_PADRAO,
  sanitizarObjetoParaExportacao,
  validarAlteracaoDeSenha,
  validarAtualizacaoDeCliente,
  validarConfiguracaoDaMarca,
  validarCriacaoDeCliente,
  validarMotivoSuporte,
  validarPoliticaDeDados,
} from '../src/contas/regras';

describe('regras da fase 7 — configurações, contas SaaS e exportação', () => {
  test('valida configuração da marca e perfil', () => {
    expect(
      validarConfiguracaoDaMarca({
        nomeWorkspace: '  Loja da Maria ',
        nomeDaMarca: 'Maria Zap',
        subtituloDaMarca: 'Atendimento VIP',
        nomeDoUsuario: 'Maria',
      }),
    ).toEqual({
      ok: true,
      dados: {
        nomeWorkspace: 'Loja da Maria',
        nomeDaMarca: 'Maria Zap',
        subtituloDaMarca: 'Atendimento VIP',
        nomeDoUsuario: 'Maria',
      },
    });

    expect(
      validarConfiguracaoDaMarca({
        nomeWorkspace: 'A',
        nomeDaMarca: MARCA_PADRAO.nomeDaMarca,
        subtituloDaMarca: '',
        nomeDoUsuario: 'Maria',
      }),
    ).toMatchObject({ ok: false });

    expect(
      validarConfiguracaoDaMarca({
        nomeWorkspace: 'Loja',
        nomeDaMarca: 'X',
        subtituloDaMarca: '',
        nomeDoUsuario: 'Maria',
      }),
    ).toMatchObject({ ok: false });
  });

  test('valida troca de senha com confirmação e diferença da senha atual', () => {
    expect(validarAlteracaoDeSenha({ senhaAtual: '', novaSenha: 'nova-senha-123', confirmarSenha: 'nova-senha-123' })).toMatchObject({
      ok: false,
    });
    expect(validarAlteracaoDeSenha({ senhaAtual: 'atual-1234', novaSenha: 'curta', confirmarSenha: 'curta' })).toMatchObject({ ok: false });
    expect(validarAlteracaoDeSenha({ senhaAtual: 'mesma-1234', novaSenha: 'mesma-1234', confirmarSenha: 'mesma-1234' })).toMatchObject({
      ok: false,
    });
    expect(validarAlteracaoDeSenha({ senhaAtual: 'atual-1234', novaSenha: 'nova-senha-123', confirmarSenha: 'outra' })).toMatchObject({
      ok: false,
    });
    expect(validarAlteracaoDeSenha({ senhaAtual: 'atual-1234', novaSenha: 'nova-senha-123', confirmarSenha: 'nova-senha-123' })).toEqual({
      ok: true,
      dados: { senhaAtual: 'atual-1234', novaSenha: 'nova-senha-123' },
    });
  });

  test('valida política de retenção LGPD dentro dos limites do banco', () => {
    expect(
      validarPoliticaDeDados({
        messageRetentionDays: 60,
        mediaRetentionDays: 30,
        recoveryWindowDays: 30,
        activeDataPurgeSlaDays: 7,
        backupExpiryTargetDays: 7,
      }),
    ).toEqual({
      ok: true,
      dados: {
        messageRetentionDays: 60,
        mediaRetentionDays: 30,
        recoveryWindowDays: 30,
        activeDataPurgeSlaDays: 7,
        backupExpiryTargetDays: 7,
      },
    });
    expect(validarPoliticaDeDados({ messageRetentionDays: 0, mediaRetentionDays: 30, recoveryWindowDays: 30, activeDataPurgeSlaDays: 7, backupExpiryTargetDays: 7 })).toMatchObject({ ok: false });
    expect(validarPoliticaDeDados({ messageRetentionDays: 60, mediaRetentionDays: 9999, recoveryWindowDays: 30, activeDataPurgeSlaDays: 7, backupExpiryTargetDays: 7 })).toMatchObject({ ok: false });
  });

  test('valida criação e edição de cliente SaaS', () => {
    const criado = validarCriacaoDeCliente({
      workspaceNome: 'Clínica Sorriso',
      loginOuEmail: 'Sorriso VIP',
      nomeUsuario: 'Dr. Pedro',
      senha: 'segredo-forte-123',
      limiteDeChips: 3,
      plano: 'Pro',
      notasAdmin: 'Cliente pagante mensal.',
    });
    expect(criado).toEqual({
      ok: true,
      dados: {
        workspaceNome: 'Clínica Sorriso',
        email: 'sorrisovip@zapia.local',
        nomeUsuario: 'Dr. Pedro',
        senha: 'segredo-forte-123',
        limiteDeChips: 3,
        plano: 'Pro',
        notasAdmin: 'Cliente pagante mensal.',
        nomeDaMarca: 'Ienvia',
        subtituloDaMarca: 'Atendente Universal',
      },
    });

    expect(
      validarCriacaoDeCliente({
        workspaceNome: 'Teste',
        loginOuEmail: '@@@',
        senha: 'segredo-forte-123',
        limiteDeChips: 1,
      }),
    ).toMatchObject({ ok: false });

    expect(
      validarAtualizacaoDeCliente({
        workspaceNome: 'Clínica Sorriso 2',
        status: 'closed',
        limiteDeChips: 5,
        plano: 'Enterprise',
        notasAdmin: 'Pausada a pedido.',
      }),
    ).toEqual({
      ok: true,
      dados: {
        workspaceNome: 'Clínica Sorriso 2',
        status: 'closed',
        limiteDeChips: 5,
        plano: 'Enterprise',
        notasAdmin: 'Pausada a pedido.',
      },
    });

    expect(validarMotivoSuporte('Ajuste de webhook')).toEqual({ ok: true, dados: 'Ajuste de webhook' });
  });

  test('remove campos sensíveis recursivamente na exportação', () => {
    const limpo = sanitizarObjetoParaExportacao({
      workspace: { id: 'w1', name: 'Loja' },
      keys: [{ provider: 'gemini', encrypted_api_key: 'segredo', last4: '1234' }],
      nested: { token_sha256: 'abc', ok: true },
    });
    expect(limpo).toEqual({
      workspace: { id: 'w1', name: 'Loja' },
      keys: [{ provider: 'gemini', last4: '1234' }],
      nested: { ok: true },
    });
  });
});
