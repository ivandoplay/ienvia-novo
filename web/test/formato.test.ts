import { describe, expect, test } from 'vitest';
import { horaMinuto, plural, resumoDeConexao, saudacao } from '@/lib/formato';

describe('saudacao', () => {
  test.each([
    [0, 'Boa noite'],
    [4, 'Boa noite'],
    [5, 'Bom dia'],
    [11, 'Bom dia'],
    [12, 'Boa tarde'],
    [17, 'Boa tarde'],
    [18, 'Boa noite'],
    [23, 'Boa noite'],
  ])('às %ih diz "%s"', (hora, esperado) => {
    expect(saudacao(hora)).toBe(esperado);
  });
});

describe('horaMinuto', () => {
  test('sempre com dois dígitos', () => {
    expect(horaMinuto(new Date(2026, 0, 5, 9, 3))).toBe('09:03');
    expect(horaMinuto(new Date(2026, 0, 5, 23, 59))).toBe('23:59');
  });
});

describe('plural', () => {
  test('escolhe a palavra certa', () => {
    expect(plural(0, 'chip', 'chips')).toBe('0 chips');
    expect(plural(1, 'chip', 'chips')).toBe('1 chip');
    expect(plural(2, 'chip', 'chips')).toBe('2 chips');
  });
});

describe('resumoDeConexao (pílula do topo)', () => {
  test('sem chip cadastrado', () => {
    expect(resumoDeConexao(0, 0)).toEqual({ texto: 'Nenhum chip', conectado: false });
  });

  test('chips cadastrados, nenhum conectado', () => {
    expect(resumoDeConexao(0, 3)).toEqual({ texto: 'Desconectado', conectado: false });
  });

  test('um único chip conectado', () => {
    expect(resumoDeConexao(1, 1)).toEqual({ texto: 'Conectado', conectado: true });
  });

  test('todos conectados', () => {
    expect(resumoDeConexao(3, 3)).toEqual({ texto: '3 chips conectados', conectado: true });
  });

  test('parte conectada', () => {
    expect(resumoDeConexao(2, 3)).toEqual({ texto: '2 de 3 conectados', conectado: true });
  });
});
