/**
 * As regras dos arquivos da Inbox (fotos, áudios, vídeos, documentos e figurinhas) que não
 * dependem de banco nem de rede.
 */
import { describe, expect, test } from 'vitest';
import {
  LIMITE_DE_DOCUMENTO,
  LIMITE_DE_MIDIA,
  avaliarArquivo,
  caminhoDoEnvio,
  depositoDizQueEhGrandeDemais,
  depositoDizQueJaExiste,
  duracaoLegivel,
  ehCaminhoDeArquivo,
  ehCaminhoDoEnvio,
  ehTipoDeEnvio,
  enderecoDoArquivo,
  limparTipoDeConteudo,
  nomeDoTipo,
  nomeNoDeposito,
  nomeParaBaixar,
  situacaoDoArquivo,
  tamanhoLegivel,
  tamanhoNoBalao,
  tipoDeConteudoDoArquivo,
  tipoParaEnvio,
} from '@/lib/inbox/arquivos';

const MB = 1024 * 1024;
const EMPRESA = 'a0000000-0000-4000-8000-000000000004';
const CONVERSA = 'f0000000-0000-4000-8000-000000000009';
const MENSAGEM = 'f1000000-0000-4000-8000-000000000013';
const CHAVE = '9487cc58-ebea-4c3a-9998-fa583056f4a5';

describe('tipo de conteúdo', () => {
  test.each([
    ['image/JPEG', 'image/jpeg'],
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    [' application/pdf ', 'application/pdf'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['', 'application/octet-stream'],
    ['isto não é um tipo', 'application/octet-stream'],
    [null, 'application/octet-stream'],
    [42, 'application/octet-stream'],
    [`image/${'x'.repeat(200)}`, 'application/octet-stream'],
  ])('%s → %s', (entrada, esperado) => {
    expect(limparTipoDeConteudo(entrada)).toBe(esperado);
  });

  test('quando o navegador não informa o tipo, vale o que a terminação do nome indica', () => {
    expect(tipoDeConteudoDoArquivo('recado.opus', '')).toBe('audio/ogg');
    expect(tipoDeConteudoDoArquivo('Recado.M4A', null)).toBe('audio/mp4');
    expect(tipoDeConteudoDoArquivo('tabela.xlsx', undefined)).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(tipoDeConteudoDoArquivo('sem-terminacao', '')).toBe('application/octet-stream');
    // Quando informa, vale o que ele informou.
    expect(tipoDeConteudoDoArquivo('foto.png', 'image/jpeg')).toBe('image/jpeg');
  });
});

describe('como o arquivo vai para o WhatsApp', () => {
  test.each([
    ['image/jpeg', 'image'],
    ['image/png', 'image'],
    ['image/webp', 'image'],
    ['video/mp4', 'video'],
    ['audio/ogg', 'audio'],
    ['audio/mpeg', 'audio'],
    ['audio/webm', 'audio'],
    // O que o WhatsApp não mostra dentro da conversa vai como documento (chega inteiro, para baixar).
    ['image/gif', 'document'],
    ['image/svg+xml', 'document'],
    ['image/heic', 'document'],
    ['video/quicktime', 'document'],
    ['application/pdf', 'document'],
    ['text/html', 'document'],
    ['application/octet-stream', 'document'],
  ])('%s vai como %s', (conteudo, esperado) => {
    expect(tipoParaEnvio(conteudo)).toBe(esperado);
  });

  test('só os quatro tipos que o painel envia são aceitos (figurinha só se recebe)', () => {
    expect(['image', 'audio', 'video', 'document'].every(ehTipoDeEnvio)).toBe(true);
    expect(ehTipoDeEnvio('sticker')).toBe(false);
    expect(ehTipoDeEnvio('')).toBe(false);
    expect(ehTipoDeEnvio(null)).toBe(false);
  });
});

describe('conferir um arquivo antes de subir', () => {
  test('foto, vídeo, áudio e documento comuns', () => {
    expect(avaliarArquivo({ nome: 'Promoção de verão.png', tipoInformado: 'image/png', tamanho: 300_000 })).toEqual({
      ok: true,
      tipo: 'image',
      conteudo: 'image/png',
      nomeNoDeposito: 'Promocao-de-verao.png',
      comoVai: 'Vai como foto',
    });
    expect(avaliarArquivo({ nome: 'inauguracao.mp4', tipoInformado: 'video/mp4', tamanho: 5 * MB })).toMatchObject({ tipo: 'video', comoVai: 'Vai como vídeo' });
    expect(avaliarArquivo({ nome: 'recado.ogg', tipoInformado: 'audio/ogg', tamanho: 40_000 })).toMatchObject({
      tipo: 'audio',
      comoVai: 'Vai como mensagem de voz, sem legenda',
    });
    expect(avaliarArquivo({ nome: 'Contrato.pdf', tipoInformado: 'application/pdf', tamanho: 90_000 })).toMatchObject({
      tipo: 'document',
      comoVai: 'Vai como documento',
    });
  });

  test('foto, vídeo ou áudio acima de 16 MB ainda vai, mas como documento', () => {
    expect(avaliarArquivo({ nome: 'filme.mp4', tipoInformado: 'video/mp4', tamanho: LIMITE_DE_MIDIA })).toMatchObject({ tipo: 'video' });
    expect(avaliarArquivo({ nome: 'filme.mp4', tipoInformado: 'video/mp4', tamanho: LIMITE_DE_MIDIA + 1 })).toMatchObject({
      tipo: 'document',
      conteudo: 'video/mp4',
      comoVai: 'Passa de 16,0 MB: vai como documento',
    });
  });

  test('formato de imagem ou vídeo que o WhatsApp não mostra na conversa vai como documento, com a explicação', () => {
    expect(avaliarArquivo({ nome: 'animacao.gif', tipoInformado: 'image/gif', tamanho: 50_000 })).toMatchObject({
      tipo: 'document',
      comoVai: 'O WhatsApp não mostra este formato na conversa: vai como documento',
    });
    expect(avaliarArquivo({ nome: 'gravacao.mov', tipoInformado: 'video/quicktime', tamanho: 50_000 })).toMatchObject({ tipo: 'document' });
  });

  test('arquivo vazio e arquivo acima de 25 MB são recusados, dizendo por quê', () => {
    expect(avaliarArquivo({ nome: 'vazio.txt', tipoInformado: 'text/plain', tamanho: 0 })).toEqual({ ok: false, erro: 'Este arquivo está vazio.' });
    expect(avaliarArquivo({ nome: 'x.bin', tipoInformado: '', tamanho: Number.NaN })).toMatchObject({ ok: false });
    expect(avaliarArquivo({ nome: 'backup.zip', tipoInformado: 'application/zip', tamanho: LIMITE_DE_DOCUMENTO })).toMatchObject({ ok: true });
    expect(avaliarArquivo({ nome: 'backup.zip', tipoInformado: 'application/zip', tamanho: 31 * MB })).toEqual({
      ok: false,
      erro: 'Este arquivo tem 31,0 MB. O painel envia arquivos de até 25,0 MB.',
    });
  });

  test('sem tipo informado pelo navegador, a terminação do nome decide', () => {
    expect(avaliarArquivo({ nome: 'recado.opus', tipoInformado: '', tamanho: 9_000 })).toMatchObject({ tipo: 'audio', conteudo: 'audio/ogg' });
    expect(avaliarArquivo({ nome: 'arquivo-misterioso', tamanho: 9_000 })).toMatchObject({ tipo: 'document', conteudo: 'application/octet-stream' });
  });
});

describe('nome do arquivo dentro do depósito', () => {
  test.each([
    ['Promoção de verão.png', 'image/png', 'Promocao-de-verao.png'],
    ['Orçamento nº 12.pdf', 'application/pdf', 'Orcamento-n-12.pdf'],
    ['FOTO.JPG', 'image/jpeg', 'FOTO.jpg'],
    ['C:\\Users\\Maria\\Desktop\\tabela final.xlsx', 'application/octet-stream', 'tabela-final.xlsx'],
    ['../../outra-empresa/segredo.pdf', 'application/pdf', 'segredo.pdf'],
    ['.oculto', 'text/plain', 'oculto'],
    ['...', 'application/pdf', 'arquivo.pdf'],
    ['', 'image/jpeg', 'arquivo.jpg'],
    ['🙂🙂🙂', 'audio/ogg', 'arquivo.ogg'],
    ['sem terminacao', 'application/octet-stream', 'sem-terminacao'],
    ['recado', 'audio/webm', 'recado.webm'],
    ['a.b.c.tar.gz', 'application/gzip', 'a.b.c.tar.gz'],
  ])('%s → %s', (nome, conteudo, esperado) => {
    const resultado = nomeNoDeposito(nome, conteudo);
    expect(resultado).toBe(esperado);
    // Sempre no formato que o depósito e o banco aceitam.
    expect(resultado).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
  });

  test('nome enorme é cortado e continua válido', () => {
    const resultado = nomeNoDeposito(`${'relatório '.repeat(40)}.pdf`, 'application/pdf');
    expect(resultado.length).toBeLessThanOrEqual(120);
    expect(resultado).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
    expect(resultado.endsWith('.pdf')).toBe(true);
  });
});

describe('caminhos no depósito', () => {
  const doEnvio = caminhoDoEnvio(EMPRESA, CONVERSA, CHAVE, 'foto.jpg');

  test('o caminho de um envio fica na pasta "envios" da conversa, dentro da empresa', () => {
    expect(doEnvio).toBe(`${EMPRESA}/${CONVERSA}/envios/${CHAVE}/foto.jpg`);
    expect(ehCaminhoDoEnvio(doEnvio, EMPRESA, CONVERSA, CHAVE)).toBe(true);
  });

  test.each([
    ['outra empresa', `a0000000-0000-4000-8000-000000000099/${CONVERSA}/envios/${CHAVE}/foto.jpg`],
    ['outra conversa', `${EMPRESA}/f0000000-0000-4000-8000-000000000001/envios/${CHAVE}/foto.jpg`],
    ['outra chave', `${EMPRESA}/${CONVERSA}/envios/outra-chave-0123456789/foto.jpg`],
    ['fora da pasta de envios', `${EMPRESA}/${CONVERSA}/${MENSAGEM}/foto.jpg`],
    ['subindo de pasta', `${EMPRESA}/${CONVERSA}/envios/${CHAVE}/../foto.jpg`],
    ['pasta a mais', `${EMPRESA}/${CONVERSA}/envios/${CHAVE}/sub/foto.jpg`],
    ['nome começando com ponto', `${EMPRESA}/${CONVERSA}/envios/${CHAVE}/.htaccess`],
    ['nome com espaço', `${EMPRESA}/${CONVERSA}/envios/${CHAVE}/fo to.jpg`],
    ['sem nome', `${EMPRESA}/${CONVERSA}/envios/${CHAVE}/`],
  ])('não é o caminho deste envio: %s', (_caso, caminho) => {
    expect(ehCaminhoDoEnvio(caminho, EMPRESA, CONVERSA, CHAVE)).toBe(false);
  });

  test('valores que nem texto são', () => {
    expect(ehCaminhoDoEnvio(null, EMPRESA, CONVERSA, CHAVE)).toBe(false);
    expect(ehCaminhoDoEnvio(undefined, EMPRESA, CONVERSA, CHAVE)).toBe(false);
    expect(ehCaminhoDoEnvio({ toString: () => doEnvio }, EMPRESA, CONVERSA, CHAVE)).toBe(false);
  });

  test('caminho de arquivo da Inbox: recebido (pasta da mensagem) ou enviado (pasta do envio)', () => {
    expect(ehCaminhoDeArquivo(`${EMPRESA}/${CONVERSA}/${MENSAGEM}/foto`)).toBe(true);
    expect(ehCaminhoDeArquivo(`${EMPRESA}/${CONVERSA}/${MENSAGEM}/relat-rio-final.pdf`)).toBe(true);
    expect(ehCaminhoDeArquivo(doEnvio)).toBe(true);
  });

  test.each([
    ['vazio', ''],
    ['só a empresa', EMPRESA],
    ['sem o nome do arquivo', `${EMPRESA}/${CONVERSA}/${MENSAGEM}`],
    ['subindo de pasta', `${EMPRESA}/${CONVERSA}/${MENSAGEM}/../../../outra/foto`],
    ['dois pontos como nome', `${EMPRESA}/${CONVERSA}/${MENSAGEM}/..`],
    ['empresa que não é um código', `empresa/${CONVERSA}/${MENSAGEM}/foto`],
    ['barra no começo', `/${EMPRESA}/${CONVERSA}/${MENSAGEM}/foto`],
    ['endereço inteiro', `https://exemplo.com/${EMPRESA}/${CONVERSA}/${MENSAGEM}/foto`],
    ['pergunta no fim', `${EMPRESA}/${CONVERSA}/${MENSAGEM}/foto?token=1`],
    ['letras maiúsculas no código', `${EMPRESA.toUpperCase()}/${CONVERSA}/${MENSAGEM}/foto`],
    ['comprido demais', `${EMPRESA}/${CONVERSA}/${MENSAGEM}/${'a'.repeat(121)}`],
  ])('não é caminho de arquivo: %s', (_caso, caminho) => {
    expect(ehCaminhoDeArquivo(caminho)).toBe(false);
  });

  test('o endereço dentro do painel, para mostrar e para baixar com o nome certo', () => {
    const caminho = `${EMPRESA}/${CONVERSA}/${MENSAGEM}/foto`;
    expect(enderecoDoArquivo(caminho)).toBe(`/api/inbox/midia/${caminho}`);
    expect(enderecoDoArquivo(caminho, 'Relatório & Cia nº 2.pdf')).toBe(`/api/inbox/midia/${caminho}?baixar=Relat%C3%B3rio%20%26%20Cia%20n%C2%BA%202.pdf`);
    expect(enderecoDoArquivo(caminho, '')).toBe(`/api/inbox/midia/${caminho}`);
  });

  test('nome para baixar: sem quebras de linha, aspas ou barras', () => {
    expect(nomeParaBaixar('Tabela de preços.pdf')).toBe('Tabela de preços.pdf');
    expect(nomeParaBaixar('a\r\nContent-Type: text/html\r\n\r\n<script>')).toBe('a Content-Type: text html <script>');
    expect(nomeParaBaixar('..\\..\\"segredo".pdf')).toBe('.. .. segredo .pdf');
    expect(nomeParaBaixar('x'.repeat(400))?.length).toBe(150);
    expect(nomeParaBaixar('   ')).toBeNull();
    expect(nomeParaBaixar(null)).toBeNull();
    expect(nomeParaBaixar(['a.pdf'])).toBeNull();
  });
});

describe('textos para a tela', () => {
  test.each([
    [0, ''],
    [null, ''],
    [-5, ''],
    [Number.NaN, ''],
    [512, '512 B'],
    [1024, '1 KB'],
    [245_000, '239 KB'],
    [MB, '1,0 MB'],
    [3_355_443, '3,2 MB'],
    [25 * MB, '25,0 MB'],
  ])('tamanho %s → "%s"', (bytes, esperado) => {
    expect(tamanhoLegivel(bytes)).toBe(esperado);
  });

  test.each([
    [9, '0:09'],
    [0, '0:00'],
    [59.6, '1:00'],
    [201, '3:21'],
    [3725, '1:02:05'],
    [null, null],
    [undefined, null],
    [-1, null],
    [Number.POSITIVE_INFINITY, null],
  ])('duração %s → %s', (segundos, esperado) => {
    expect(duracaoLegivel(segundos)).toBe(esperado);
  });

  test('como chamar cada tipo de arquivo', () => {
    expect(nomeDoTipo('image', false)).toBe('Foto');
    expect(nomeDoTipo('video', false)).toBe('Vídeo');
    expect(nomeDoTipo('audio', true)).toBe('Mensagem de voz');
    expect(nomeDoTipo('audio', false)).toBe('Áudio');
    expect(nomeDoTipo('sticker', false)).toBe('Figurinha');
    expect(nomeDoTipo('document', false)).toBe('Documento');
  });

  test('tamanho da foto no balão: cabe em 330 × 340 sem distorcer e nunca é ampliada', () => {
    expect(tamanhoNoBalao(480, 360)).toEqual({ width: 330, height: 248 });
    expect(tamanhoNoBalao(1280, 720)).toEqual({ width: 330, height: 186 });
    expect(tamanhoNoBalao(720, 1280)).toEqual({ width: 191, height: 340 });
    expect(tamanhoNoBalao(120, 80)).toEqual({ width: 120, height: 80 });
    expect(tamanhoNoBalao(20_000, 1)).toEqual({ width: 330, height: 1 });
    expect(tamanhoNoBalao(null, 360)).toBeNull();
    expect(tamanhoNoBalao(480, 0)).toBeNull();
    expect(tamanhoNoBalao(-10, 10)).toBeNull();
    expect(tamanhoNoBalao(Number.NaN, 10)).toBeNull();
  });
});

describe('situação do arquivo de uma mensagem', () => {
  const AGORA = new Date('2026-11-11T15:00:00Z');
  const haSegundos = (segundos: number) => new Date(AGORA.getTime() - segundos * 1000).toISOString();

  test('guardado, grande demais e apagado são o que são', () => {
    expect(situacaoDoArquivo('stored', haSegundos(5), AGORA)).toBe('guardado');
    expect(situacaoDoArquivo('too_large', haSegundos(5), AGORA)).toBe('grande_demais');
    expect(situacaoDoArquivo('deleted', haSegundos(5), AGORA)).toBe('apagado');
    expect(situacaoDoArquivo('failed', haSegundos(5), AGORA)).toBe('falhou');
  });

  test('pendente há pouco é "buscando"; depois de dois minutos, o painel assume que a busca se perdeu', () => {
    expect(situacaoDoArquivo('pending', haSegundos(3), AGORA)).toBe('buscando');
    expect(situacaoDoArquivo('pending', haSegundos(119), AGORA)).toBe('buscando');
    expect(situacaoDoArquivo('pending', haSegundos(121), AGORA)).toBe('falhou');
    expect(situacaoDoArquivo('pending', 'data ilegível', AGORA)).toBe('falhou');
  });

  test('situação desconhecida não finge que está tudo bem', () => {
    expect(situacaoDoArquivo('qualquer-coisa', haSegundos(5), AGORA)).toBe('falhou');
  });
});

describe('respostas do depósito', () => {
  // O depósito de verdade responde assim (conferido em 11/11/2026).
  const jaExiste: Record<string, unknown> = { statusCode: '409', error: 'Duplicate', message: 'The resource already exists', code: 'KeyAlreadyExists' };
  const grandeDemais: Record<string, unknown> = { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size', code: 'EntityTooLarge' };
  const semPermissao: Record<string, unknown> = { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' };

  test('"já existe": o mesmo envio já subiu este arquivo', () => {
    expect(depositoDizQueJaExiste(jaExiste)).toBe(true);
    expect(depositoDizQueJaExiste({ statusCode: 409 })).toBe(true);
    expect(depositoDizQueJaExiste({ message: 'The resource already exists' })).toBe(true);
    expect(depositoDizQueJaExiste(semPermissao)).toBe(false);
    expect(depositoDizQueJaExiste(grandeDemais)).toBe(false);
    expect(depositoDizQueJaExiste(null)).toBe(false);
    expect(depositoDizQueJaExiste({})).toBe(false);
  });

  test('"grande demais"', () => {
    expect(depositoDizQueEhGrandeDemais(grandeDemais)).toBe(true);
    expect(depositoDizQueEhGrandeDemais({ message: 'The object exceeded the maximum allowed size' })).toBe(true);
    expect(depositoDizQueEhGrandeDemais(jaExiste)).toBe(false);
    expect(depositoDizQueEhGrandeDemais(undefined)).toBe(false);
  });
});
