/**
 * Arquivos de exemplo (uma foto, uma figurinha, um áudio e um PDF), criados na hora, sem depender de
 * nenhum arquivo guardado no repositório. Servem para os testes e para a prévia com dados de exemplo:
 * são arquivos de verdade, que o navegador abre, toca e baixa.
 */
import zlib from 'node:zlib';

/** Monta um PNG a partir de uma função que diz a cor de cada ponto: (x, y) → [r, g, b, a]. */
function png(largura, altura, cor) {
  const linha = largura * 4 + 1;
  const pontos = Buffer.alloc(linha * altura);
  for (let y = 0; y < altura; y += 1) {
    for (let x = 0; x < largura; x += 1) {
      const [r, g, b, a = 255] = cor(x, y);
      pontos.set([r, g, b, a], y * linha + 1 + x * 4);
    }
  }
  const bloco = (tipo, dados) => {
    const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
    const tamanho = Buffer.alloc(4);
    tamanho.writeUInt32BE(dados.length);
    const conferencia = Buffer.alloc(4);
    conferencia.writeUInt32BE(zlib.crc32(corpo));
    return Buffer.concat([tamanho, corpo, conferencia]);
  };
  const cabecalho = Buffer.alloc(13);
  cabecalho.writeUInt32BE(largura, 0);
  cabecalho.writeUInt32BE(altura, 4);
  cabecalho.set([8, 6, 0, 0, 0], 8); // 8 bits por cor, com transparência
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', cabecalho),
    bloco('IDAT', zlib.deflateSync(pontos, { level: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

const mistura = (de, para, quanto) => de.map((valor, indice) => Math.round(valor + (para[indice] - valor) * quanto));

/** Uma "foto": céu, sol e a fachada de uma loja com porta, vitrine e toldo. `tom` muda as cores. */
export function fotoDeExemplo({ largura = 480, altura = 360, tom = 'dia' } = {}) {
  const ceu = tom === 'dia' ? [[96, 178, 240], [214, 236, 250]] : [[250, 150, 90], [255, 222, 170]];
  const parede = tom === 'dia' ? [236, 226, 200] : [214, 190, 170];
  const toldo = tom === 'dia' ? [[16, 150, 110], [240, 240, 240]] : [[200, 60, 60], [245, 240, 230]];
  const chao = Math.round(altura * 0.86);
  const loja = { x0: Math.round(largura * 0.14), x1: Math.round(largura * 0.86), y0: Math.round(altura * 0.34) };
  const sol = { x: largura * 0.82, y: altura * 0.17, raio: altura * 0.085 };
  return png(largura, altura, (x, y) => {
    if (y >= chao) return y % 6 < 1 ? [120, 120, 124] : [150, 150, 154];
    if (x >= loja.x0 && x < loja.x1 && y >= loja.y0) {
      const lx = (x - loja.x0) / (loja.x1 - loja.x0);
      const ly = (y - loja.y0) / (chao - loja.y0);
      if (ly < 0.2) return toldo[Math.floor(lx * 12) % 2];
      if (lx > 0.08 && lx < 0.3 && ly > 0.34) return lx > 0.26 && ly > 0.62 && ly < 0.68 ? [230, 200, 80] : [110, 72, 48];
      if (lx > 0.38 && lx < 0.92 && ly > 0.34 && ly < 0.86) {
        const vidro = mistura([150, 210, 235], [70, 130, 170], ly);
        return Math.abs(lx - 0.65) < 0.006 || Math.abs(ly - 0.6) < 0.012 ? [240, 240, 240] : vidro;
      }
      return parede;
    }
    if (Math.hypot(x - sol.x, y - sol.y) < sol.raio) return [255, 226, 110];
    return mistura(ceu[0], ceu[1], y / chao);
  });
}

/** Uma "figurinha": um rosto sorrindo num fundo transparente. */
export function figurinhaDeExemplo(lado = 192) {
  const meio = lado / 2;
  return png(lado, lado, (x, y) => {
    const distancia = Math.hypot(x - meio, y - meio);
    if (distancia > meio * 0.94) return [0, 0, 0, 0];
    if (distancia > meio * 0.86) return [190, 120, 20, 255];
    const olho = (cx) => Math.hypot(x - cx, y - meio * 0.74) < meio * 0.11;
    if (olho(meio * 0.66) || olho(meio * 1.34)) return [60, 40, 20, 255];
    const sorriso = Math.hypot(x - meio, y - meio * 1.02);
    if (y > meio * 1.16 && sorriso > meio * 0.46 && sorriso < meio * 0.58) return [60, 40, 20, 255];
    return [255, 205, 60, 255];
  });
}

/** Um áudio de verdade (WAV): três notas curtas. */
export function audioDeExemplo(segundos = 3) {
  const taxa = 8000;
  const total = taxa * segundos;
  const amostras = Buffer.alloc(total);
  const notas = [440, 554, 659];
  for (let i = 0; i < total; i += 1) {
    const tempo = i / taxa;
    const nota = notas[Math.min(notas.length - 1, Math.floor((tempo / segundos) * notas.length))];
    const dentroDaNota = (tempo % (segundos / notas.length)) / (segundos / notas.length);
    const volume = Math.min(1, dentroDaNota * 12) * (1 - dentroDaNota) * 0.6;
    amostras[i] = Math.round(128 + 127 * volume * Math.sin(2 * Math.PI * nota * tempo));
  }
  const cabecalho = Buffer.alloc(44);
  cabecalho.write('RIFF', 0, 'ascii');
  cabecalho.writeUInt32LE(36 + total, 4);
  cabecalho.write('WAVEfmt ', 8, 'ascii');
  cabecalho.writeUInt32LE(16, 16);
  cabecalho.writeUInt16LE(1, 20); // PCM
  cabecalho.writeUInt16LE(1, 22); // mono
  cabecalho.writeUInt32LE(taxa, 24);
  cabecalho.writeUInt32LE(taxa, 28);
  cabecalho.writeUInt16LE(1, 32);
  cabecalho.writeUInt16LE(8, 34);
  cabecalho.write('data', 36, 'ascii');
  cabecalho.writeUInt32LE(total, 40);
  return Buffer.concat([cabecalho, amostras]);
}

/** Um PDF de uma página, com algumas linhas de texto (sem acentos: o PDF mais simples não os entende). */
export function pdfDeExemplo(linhas = ['Tabela de precos', 'Produto A ........ R$ 10,00', 'Produto B ........ R$ 25,00']) {
  const texto = linhas
    .map((linha, indice) => `BT /F1 ${indice === 0 ? 20 : 13} Tf 60 ${760 - indice * 30} Td (${linha.replace(/[()\\]/g, '')}) Tj ET`)
    .join('\n');
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(texto)} >>\nstream\n${texto}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let corpo = '%PDF-1.4\n';
  const posicoes = [];
  objetos.forEach((objeto, indice) => {
    posicoes.push(Buffer.byteLength(corpo));
    corpo += `${indice + 1} 0 obj\n${objeto}\nendobj\n`;
  });
  const indice = Buffer.byteLength(corpo);
  corpo += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const posicao of posicoes) corpo += `${String(posicao).padStart(10, '0')} 00000 n \n`;
  corpo += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${indice}\n%%EOF\n`;
  return Buffer.from(corpo, 'latin1');
}

/**
 * Um arquivo com o começo de um vídeo MP4 (a assinatura "ftyp" e um bloco de dados vazio).
 * NÃO é um vídeo que toca: serve para conferir que o painel guarda o arquivo e mostra o tocador
 * com o link para baixar. (Gerar um vídeo de verdade em código não compensa para os testes.)
 */
export function videoDeExemplo(bytes = 2048) {
  const caixa = (tipo, conteudo) => {
    const tamanho = Buffer.alloc(4);
    tamanho.writeUInt32BE(8 + conteudo.length);
    return Buffer.concat([tamanho, Buffer.from(tipo, 'latin1'), conteudo]);
  };
  const ftyp = caixa('ftyp', Buffer.concat([Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2mp41', 'latin1')]));
  return Buffer.concat([ftyp, caixa('mdat', Buffer.alloc(Math.max(0, bytes - ftyp.length - 8)))]);
}
