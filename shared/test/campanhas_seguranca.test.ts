import { describe, expect, test } from 'vitest';
import {
  CADENCIA_PADRAO,
  PADRAO_SEGURANCA,
  conferirCadencia,
  conferirSeguranca,
  dentroDoHorarioDeAtendimento,
  expandirSpintax,
  extrairPlaceholders,
  importarDestinatariosDeTexto,
  importarDestinatariosDeXlsx,
  mioloDoTelefone,
  normalizarDigitosTelefone,
  renderizarBlocoDeTexto,
  variacaoIaPreservaPlaceholders,
} from '../src/index';

/** Cria um arquivo ZIP STORED (método 0) mínimo para testar planilhas .xlsx sem dependências externas. */
function criarZipStored(entradas: Array<{ nome: string; conteudo: string }>): Uint8Array {
  const Encoder = (globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }).TextEncoder;
  const enc = new Encoder();
  const locais: Uint8Array[] = [];
  const centrais: Uint8Array[] = [];
  let offset = 0;

  for (const e of entradas) {
    const nome = enc.encode(e.nome);
    const dados = enc.encode(e.conteudo);

    const loc = new Uint8Array(30 + nome.length);
    const vl = new DataView(loc.buffer);
    vl.setUint32(0, 0x04034b50, true);
    vl.setUint16(4, 20, true);
    vl.setUint32(18, dados.length, true);
    vl.setUint32(22, dados.length, true);
    vl.setUint16(26, nome.length, true);
    loc.set(nome, 30);

    const cd = new Uint8Array(46 + nome.length);
    const vc = new DataView(cd.buffer);
    vc.setUint32(0, 0x02014b50, true);
    vc.setUint16(4, 20, true);
    vc.setUint16(6, 20, true);
    vc.setUint32(20, dados.length, true);
    vc.setUint32(24, dados.length, true);
    vc.setUint16(28, nome.length, true);
    vc.setUint32(42, offset, true);
    cd.set(nome, 46);

    locais.push(loc, dados);
    centrais.push(cd);
    offset += loc.length + dados.length;
  }

  const cdTamanho = centrais.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ve = new DataView(eocd.buffer);
  ve.setUint32(0, 0x06054b50, true);
  ve.setUint16(8, entradas.length, true);
  ve.setUint16(10, entradas.length, true);
  ve.setUint32(12, cdTamanho, true);
  ve.setUint32(16, offset, true);

  const partes = [...locais, ...centrais, eocd];
  const total = partes.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

describe('segurança e horário de atendimento', () => {
  test('normaliza telefones BR com DDD e gera miolo compatível com private.phone_core', () => {
    expect(normalizarDigitosTelefone('(86) 99988-7766')).toBe('5586999887766');
    expect(normalizarDigitosTelefone('+55 86 9988-7766')).toBe('558699887766');
    expect(normalizarDigitosTelefone('005586999887766@s.whatsapp.net')).toBe('5586999887766');
    expect(normalizarDigitosTelefone('123')).toBeNull();
    expect(mioloDoTelefone('5586999887766')).toBe(mioloDoTelefone('558699887766'));
  });

  test('avalia horário comercial, plantão noturno e virada de meia-noite no fuso', () => {
    // 2026-11-12 é quinta-feira (dia 4). 14:00 UTC = 11:00 em America/Fortaleza (-03:00).
    const meioDiaFortaleza = Date.parse('2026-11-12T14:00:00Z');
    const noiteFortaleza = Date.parse('2026-11-12T23:30:00Z'); // 20:30 local

    const comercial = {
      scheduleMode: 'business_hours_only' as const,
      scheduleStart: '08:00',
      scheduleEnd: '18:00',
      scheduleWorkDays: [1, 2, 3, 4, 5],
      scheduleTimezone: 'America/Fortaleza',
    };
    expect(dentroDoHorarioDeAtendimento(comercial, meioDiaFortaleza).ativo).toBe(true);
    expect(dentroDoHorarioDeAtendimento(comercial, noiteFortaleza).ativo).toBe(false);

    const plantao = { ...comercial, scheduleMode: 'outside_hours_only' as const };
    expect(dentroDoHorarioDeAtendimento(plantao, meioDiaFortaleza).ativo).toBe(false);
    expect(dentroDoHorarioDeAtendimento(plantao, noiteFortaleza).ativo).toBe(true);

    const madrugada = {
      scheduleMode: 'business_hours_only' as const,
      scheduleStart: '22:00',
      scheduleEnd: '05:00',
      scheduleWorkDays: [4, 5],
      scheduleTimezone: 'America/Fortaleza',
    };
    expect(dentroDoHorarioDeAtendimento(madrugada, Date.parse('2026-11-13T01:30:00Z')).ativo).toBe(true); // 22:30 qui
  });

  test('conferência recusa valores inválidos de segurança e cadência', () => {
    expect(conferirSeguranca(PADRAO_SEGURANCA)).toBeNull();
    expect(conferirSeguranca({ ...PADRAO_SEGURANCA, adminAlertEnabled: true, adminAlertWhatsapp: '' })).toMatch(/WhatsApp/);
    expect(conferirSeguranca({ ...PADRAO_SEGURANCA, minTypingMs: 5000, maxTypingMs: 2000 })).toMatch(/máximo de digitação/);
    expect(conferirCadencia(CADENCIA_PADRAO)).toBeNull();
    expect(conferirCadencia({ ...CADENCIA_PADRAO, intervalMinSec: 90, intervalMaxSec: 30 })).toMatch(/Intervalo máximo/);
  });
});

describe('campanhas: spintax, variáveis e importação', () => {
  test('expande spintax aninhado sem quebrar {{placeholders}} e valida variação da IA', () => {
    const template = '{Oi|Olá} {{primeiro_nome}}, temos uma {excelente|ótima} condição na {{empresa}}!';
    const render = renderizarBlocoDeTexto(
      { mode: 'spintax', texts: [template], selection: 'sequential' },
      { nome: 'Maria Silva', telefone: '5586999887766', campos: { empresa: 'Loja Centro' } },
      0,
      () => 0,
    );
    expect(render).toBe('Oi Maria, temos uma excelente condição na Loja Centro!');
    expect(extrairPlaceholders('Olá {{Nome}}, seu plano {{Empresa}} vence hoje.')).toEqual(['nome', 'empresa']);
    expect(variacaoIaPreservaPlaceholders('Oi {{nome}} da {{empresa}}', 'Olá {{nome}}, tudo bem na {{empresa}}?')).toBe(true);
    expect(variacaoIaPreservaPlaceholders('Oi {{nome}} da {{empresa}}', 'Olá amigo!')).toBe(false);
    expect(expandirSpintax('{{nome}}', () => 0)).toBe('{{nome}}');
  });

  test('importa CSV com cabeçalho, campos extras e deduplica números equivalentes', () => {
    const csv = [
      'Nome;Telefone;Empresa;Plano',
      'Maria Souza;(86) 99988-7766;Padaria Sol;Ouro',
      'Maria Repetida;55 86 9988-7766;Padaria Sol;Ouro',
      'João Lima;5511988776655;Oficina Forte;Prata',
      'Linha Inválida;12345;Sem;Nada',
    ].join('\n');

    const res = importarDestinatariosDeTexto(csv);
    expect(res.validos).toHaveLength(2);
    expect(res.validos[0]).toMatchObject({
      telefone: '5586999887766',
      nome: 'Maria Souza',
      campos: { empresa: 'Padaria Sol', plano: 'Ouro' },
    });
    expect(res.rejeitados.map((r) => r.motivo)).toEqual(['duplicado', 'telefone_invalido']);
  });

  test('lê planilha .xlsx válida e rejeita .xlsx com Zip Slip ou XXE', async () => {
    const validXlsx = criarZipStored([
      {
        nome: 'xl/sharedStrings.xml',
        conteudo: '<sst><si><t>Nome</t></si><si><t>WhatsApp</t></si><si><t>Ana Paula</t></si><si><t>Cidade</t></si><si><t>Piracuruca</t></si></sst>',
      },
      {
        nome: 'xl/worksheets/sheet1.xml',
        conteudo: [
          '<worksheet><sheetData>',
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row>',
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>5586999112233</v></c><c r="C2" t="s"><v>4</v></c></row>',
          '</sheetData></worksheet>',
        ].join(''),
      },
    ]);

    const lido = await importarDestinatariosDeXlsx(validXlsx);
    expect(lido.validos).toEqual([
      {
        telefone: '5586999112233',
        miolo: '558699112233',
        nome: 'Ana Paula',
        campos: { cidade: 'Piracuruca' },
      },
    ]);

    const zipSlip = criarZipStored([{ nome: '../../etc/passwd', conteudo: 'nope' }]);
    await expect(importarDestinatariosDeXlsx(zipSlip)).rejects.toThrow(/inseguro/);

    const xxe = criarZipStored([
      { nome: 'xl/worksheets/sheet1.xml', conteudo: '<!DOCTYPE foo [<!ENTITY bar "baz">]><worksheet/>' },
    ]);
    await expect(importarDestinatariosDeXlsx(xxe)).rejects.toThrow(/não permitidas/);
  });
});
