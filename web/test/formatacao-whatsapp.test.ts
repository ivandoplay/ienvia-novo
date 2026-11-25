import { describe, expect, test } from 'vitest';
import { lerResposta, normalizarTextoGeradoParaWhatsApp } from '@/lib/ia/instrucoes';

describe('texto gerado para WhatsApp: escapes literais e moeda', () => {
  test('reproduz o caso do print com nome e dois parágrafos', () => {
    expect(lerResposta(String.raw`Boa tarde, Jota Alisson!\n\nVocê lembra qual foi o modelo?`).texto)
      .toBe('Boa tarde, Jota Alisson!\n\nVocê lembra qual foi o modelo?');
  });
  test('reproduz o preço duplicado e as quebras do outro print', () => {
    expect(lerResposta(String.raw`O *Bot* custa R$ $10.490.\n\nEle tem autonomia de 70 km.\n\nFicou alguma dúvida?`).texto)
      .toBe('O *Bot* custa R$ 10.490.\n\nEle tem autonomia de 70 km.\n\nFicou alguma dúvida?');
  });
  test('escapes duplicados também são normalizados', () => {
    expect(lerResposta(String.raw`Oi!\\n\\nTudo bem?`).texto).toBe('Oi!\n\nTudo bem?');
  });
  test('quebra seguida de palavra minúscula ou número', () => {
    expect(lerResposta(String.raw`Primeiro\nsegundo\n123`).texto).toBe('Primeiro\nsegundo\n123');
  });
  test('CRLF escapado vira uma quebra', () => {
    expect(lerResposta(String.raw`Oi\r\nTudo bem`).texto).toBe('Oi\nTudo bem');
  });
  test('texto e quebras reais já corretos não mudam', () => {
    expect(lerResposta('Olá!\n\nTudo bem?').texto).toBe('Olá!\n\nTudo bem?');
  });
  test('mantém símbolo único e valores de formas diferentes', () => {
    for (const value of ['R$ 10.490,00', 'R$10.490', '$ 10.490', '10.490 reais']) expect(lerResposta(value).texto).toBe(value);
  });
  test('normalização não é uma decodificação JSON arbitrária', () => {
    expect(normalizarTextoGeradoParaWhatsApp(String.raw`aspas: \" | unicode: \u0041 | tab: \t`)).toBe(String.raw`aspas: \" | unicode: \u0041 | tab: \t`);
  });
  test('protege código inline contendo a representação literal', () => {
    const s = 'Exemplo: `\\n` e `R$ $10.490`.';
    expect(lerResposta(s).texto).toBe(s);
  });
  test('protege blocos de código', () => {
    const s = '```js\nconst texto = "\\n";\n```';
    expect(lerResposta(s).texto).toBe(s);
  });
  test('protege caminhos Windows e UNC', () => {
    for (const s of [String.raw`C:\novo\relatorio.txt`, String.raw`\\servidor\novo\relatorio.txt`]) expect(lerResposta(s).texto).toBe(s);
  });
  test('protege conteúdo de URLs', () => {
    const s=String.raw`https://example.invalid/file\nome?value=\n`;
    expect(lerResposta(s).texto).toBe(s);
  });
  test('comando de áudio continua interno, texto é normalizado', () => {
    expect(lerResposta(String.raw`[[ENVIAR_AUDIO:apresentacao]] Olá!\n\nTudo bem?`)).toMatchObject({ audiosParaEnviar:['apresentacao'],texto:'Olá!\n\nTudo bem?' });
  });
  test('pausa silenciosa nunca vaza texto normalizado', () => {
    expect(lerResposta(String.raw`Oi\nTudo bem [[PAUSA_SILENCIOSA:duvida]]`).texto).toBe('');
  });
  test('repasse continua estruturado sem expor o comando', () => {
    expect(lerResposta(String.raw`Certo.\n\n[[CHAMAR_HUMANO:preco]]`)).toMatchObject({texto:'Certo.',chamarHumano:'preco'});
  });
  test('resultado é idempotente', () => {
    const s=String.raw`Preço R$ $10.490.\n\nMais detalhes.`;
    const first=normalizarTextoGeradoParaWhatsApp(s);
    expect(normalizarTextoGeradoParaWhatsApp(first)).toBe(first);
  });
});
