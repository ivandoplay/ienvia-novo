import { describe, expect, test } from 'vitest';
import { apelidoDoLogin, emailParaUsuario, iniciais, normalizarUsuario, usuarioParaEmail } from '../src/index';

describe('normalizarUsuario', () => {
  test('tira espaços, maiúsculas e acentos', () => {
    expect(normalizarUsuario('  João.Silva ')).toBe('joao.silva');
  });

  test('descarta caracteres que não podem fazer parte de um usuário', () => {
    expect(normalizarUsuario('loja do zé!#$')).toBe('lojadoze');
    expect(normalizarUsuario('a_b-c.d')).toBe('a_b-c.d');
  });

  test('limita o tamanho', () => {
    expect(normalizarUsuario('a'.repeat(200))).toHaveLength(64);
  });
});

describe('usuarioParaEmail', () => {
  test('usuário simples vira e-mail interno no domínio do sistema antigo', () => {
    expect(usuarioParaEmail('Joao')).toBe('joao@zapia.local');
  });

  test('e-mail completo é usado como está (só em minúsculas)', () => {
    expect(usuarioParaEmail(' Maria@Empresa.com.br ')).toBe('maria@empresa.com.br');
  });

  test('aceita outro domínio interno quando configurado', () => {
    expect(usuarioParaEmail('ana', 'ienvia.local')).toBe('ana@ienvia.local');
  });

  test('entrada vazia ou inválida devolve null', () => {
    expect(usuarioParaEmail('')).toBeNull();
    expect(usuarioParaEmail('   ')).toBeNull();
    expect(usuarioParaEmail('!!!')).toBeNull();
    expect(usuarioParaEmail('...')).toBeNull();
    expect(usuarioParaEmail('sem-dominio@')).toBeNull();
    expect(usuarioParaEmail('a@b')).toBeNull();
    expect(usuarioParaEmail('dois @arroba.com')).toBeNull();
  });

  test('não deixa injetar outro domínio pelo campo de usuário', () => {
    // Sem "@" a entrada é sempre tratada como usuário e limpa.
    expect(usuarioParaEmail('admin/../x')).toBe('admin..x@zapia.local');
  });
});

describe('emailParaUsuario', () => {
  test('esconde o domínio interno', () => {
    expect(emailParaUsuario('joao@zapia.local')).toBe('joao');
  });

  test('mantém e-mails de verdade', () => {
    expect(emailParaUsuario('maria@empresa.com.br')).toBe('maria@empresa.com.br');
  });

  test('aguenta vazio', () => {
    expect(emailParaUsuario(null)).toBe('');
    expect(emailParaUsuario(undefined)).toBe('');
  });
});

describe('iniciais', () => {
  test('duas palavras: primeira letra de cada', () => {
    expect(iniciais('Maria Souza')).toBe('MS');
  });

  test('uma palavra: duas primeiras letras', () => {
    expect(iniciais('joao')).toBe('JO');
  });

  test('separa por ponto, hífen e arroba', () => {
    expect(iniciais('ana.paula')).toBe('AP');
    expect(iniciais('loja@empresa.com')).toBe('LE');
  });

  test('vazio vira interrogação', () => {
    expect(iniciais('')).toBe('?');
    expect(iniciais(null)).toBe('?');
  });
});

describe('apelidoDoLogin', () => {
  test('usuário simples ganha um @ na frente', () => {
    expect(apelidoDoLogin('joao')).toBe('@joao');
    expect(apelidoDoLogin('@joao')).toBe('@joao');
  });

  test('e-mail mostra só a parte antes do @', () => {
    expect(apelidoDoLogin('maria@empresa.com')).toBe('maria');
  });

  test('vazio continua vazio', () => {
    expect(apelidoDoLogin('')).toBe('');
    expect(apelidoDoLogin(null)).toBe('');
  });
});
