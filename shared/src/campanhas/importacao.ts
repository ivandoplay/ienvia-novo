/**
 * Importação segura de destinatários de Campanhas e da Fila Segura:
 *   - texto colado (um por linha: telefone;nome ou apenas números);
 *   - arquivos CSV / TXT (, ; ou tab);
 *   - planilhas Excel (.xlsx) lidas em TypeScript puro com travas contra ZIP bomb, Zip Slip e XXE.
 */
import { mioloDoTelefone, normalizarDigitosTelefone } from '../seguranca/regras';
import { normalizarChaveCampo } from './regras';

export interface DestinatarioImportado {
  telefone: string;
  miolo: string;
  nome: string;
  campos: Record<string, string>;
}

export interface LinhaRejeitada {
  linha: number;
  bruto: string;
  motivo: 'telefone_invalido' | 'duplicado';
}

export interface ResultadoImportacaoDestinatarios {
  validos: DestinatarioImportado[];
  rejeitados: LinhaRejeitada[];
  colunasExtras: string[];
  totalLinhasLidas: number;
}

export const LIMITES_IMPORTACAO = {
  maxLinhas: 10_000,
  maxArquivoBytes: 10 * 1024 * 1024,
  maxXmlBytes: 15 * 1024 * 1024,
  maxEntradasZip: 256,
  maxExpandidoZipBytes: 32 * 1024 * 1024,
  maxRazaoCompressao: 200,
} as const;

const COLUNAS_TELEFONE = new Set([
  'telefone',
  'celular',
  'whatsapp',
  'fone',
  'numero',
  'tel',
  'cel',
  'phone',
  'mobile',
  'contato_telefone',
  'whatsapp_numero',
]);

const COLUNAS_NOME = new Set(['nome', 'cliente', 'lead', 'contato', 'name', 'full_name', 'nome_completo', 'primeiro_nome']);

function limparCelula(valor: unknown): string {
  return String(valor ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 500);
}

function pareceTelefone(texto: string): boolean {
  return normalizarDigitosTelefone(texto) !== null;
}

function detectarDelimitador(linhas: string[]): string {
  const amostra = linhas.slice(0, 10).join('\n');
  const contagens: Array<[string, number]> = [
    [';', (amostra.match(/;/g) ?? []).length],
    ['\t', (amostra.match(/\t/g) ?? []).length],
    [',', (amostra.match(/,/g) ?? []).length],
  ];
  contagens.sort((a, b) => b[1] - a[1]);
  return (contagens[0]?.[1] ?? 0) > 0 ? contagens[0]![0] : ';';
}

function dividirLinhaCsv(linha: string, separador: string): string[] {
  const saida: string[] = [];
  let atual = '';
  let emAspas = false;
  for (let i = 0; i < linha.length; i += 1) {
    const ch = linha[i]!;
    if (ch === '"') {
      if (emAspas && linha[i + 1] === '"') {
        atual += '"';
        i += 1;
      } else {
        emAspas = !emAspas;
      }
      continue;
    }
    if (ch === separador && !emAspas) {
      saida.push(atual.trim());
      atual = '';
      continue;
    }
    atual += ch;
  }
  saida.push(atual.trim());
  return saida;
}

function ehCabecalho(primeiraLinha: string[]): boolean {
  const norm = primeiraLinha.map((c) => normalizarChaveCampo(c));
  if (norm.some((c) => COLUNAS_TELEFONE.has(c) || COLUNAS_NOME.has(c))) return true;
  // Se nenhuma célula da primeira linha é telefone válido e há texto alfabético, assume cabeçalho.
  return primeiraLinha.length > 0 && !primeiraLinha.some((c) => pareceTelefone(c)) && primeiraLinha.some((c) => /[a-zA-ZÀ-ÿ]/.test(c));
}

export function normalizarTabelaDeDestinatarios(linhasBrutas: ReadonlyArray<ReadonlyArray<string>>): ResultadoImportacaoDestinatarios {
  const linhas = linhasBrutas
    .map((linha) => linha.map(limparCelula))
    .filter((linha) => linha.some((c) => c !== ''))
    .slice(0, LIMITES_IMPORTACAO.maxLinhas);

  if (linhas.length === 0) {
    return { validos: [], rejeitados: [], colunasExtras: [], totalLinhasLidas: 0 };
  }

  const comCabecalho = ehCabecalho(linhas[0]!);
  const inicioDados = comCabecalho ? 1 : 0;
  const cabecalhos = comCabecalho
    ? linhas[0]!.map((c, idx) => normalizarChaveCampo(c) || `coluna_${idx + 1}`)
    : [];

  let colTel = cabecalhos.findIndex((c) => COLUNAS_TELEFONE.has(c));
  let colNome = cabecalhos.findIndex((c) => COLUNAS_NOME.has(c));

  if (colTel < 0) {
    // Auto-detecta a primeira coluna que contém maioria de telefones válidos nas primeiras 20 linhas.
    const maxCols = Math.max(...linhas.slice(inicioDados, inicioDados + 20).map((l) => l.length), 0);
    let melhorCol = -1;
    let melhorAcertos = 0;
    for (let col = 0; col < maxCols; col += 1) {
      let acertos = 0;
      for (const l of linhas.slice(inicioDados, inicioDados + 20)) {
        if (pareceTelefone(l[col] ?? '')) acertos += 1;
      }
      if (acertos > melhorAcertos) {
        melhorAcertos = acertos;
        melhorCol = col;
      }
    }
    colTel = melhorCol >= 0 ? melhorCol : 0;
  }

  if (colNome < 0) {
    // Se não havia cabeçalho explícito de nome e existe coluna de texto adjacente, usa ela como nome.
    const maxCols = Math.max(...linhas.slice(inicioDados, inicioDados + 10).map((l) => l.length), 0);
    for (let col = 0; col < maxCols; col += 1) {
      if (col === colTel) continue;
      if (!comCabecalho || cabecalhos[col] === `coluna_${col + 1}`) {
        colNome = col;
        break;
      }
    }
  }

  const extrasIndices: Array<{ indice: number; chave: string }> = [];
  const nomesExtras = new Set<string>();
  if (comCabecalho) {
    for (let idx = 0; idx < cabecalhos.length; idx += 1) {
      if (idx === colTel || idx === colNome) continue;
      const chave = cabecalhos[idx]!;
      if (!chave || chave === 'telefone' || chave === 'nome') continue;
      if (!nomesExtras.has(chave)) {
        nomesExtras.add(chave);
        extrasIndices.push({ indice: idx, chave });
      }
    }
  } else {
    const maxCols = Math.max(...linhas.slice(inicioDados).map((l) => l.length), 0);
    for (let idx = 0; idx < maxCols; idx += 1) {
      if (idx === colTel || idx === colNome) continue;
      const chave = `campo_${idx + 1}`;
      nomesExtras.add(chave);
      extrasIndices.push({ indice: idx, chave });
    }
  }

  const validos: DestinatarioImportado[] = [];
  const rejeitados: LinhaRejeitada[] = [];
  const vistos = new Set<string>();

  for (let i = inicioDados; i < linhas.length; i += 1) {
    const linha = linhas[i]!;
    const numeroBruto = linha[colTel] ?? '';
    const telefone = normalizarDigitosTelefone(numeroBruto);
    if (!telefone) {
      rejeitados.push({ linha: i + 1, bruto: linha.join(' | ').slice(0, 120), motivo: 'telefone_invalido' });
      continue;
    }
    const miolo = mioloDoTelefone(telefone);
    if (vistos.has(miolo)) {
      rejeitados.push({ linha: i + 1, bruto: linha.join(' | ').slice(0, 120), motivo: 'duplicado' });
      continue;
    }
    vistos.add(miolo);

    const nome = (colNome >= 0 ? linha[colNome] ?? '' : '').slice(0, 160);
    const campos: Record<string, string> = {};
    for (const extra of extrasIndices) {
      const valor = (linha[extra.indice] ?? '').trim();
      if (valor) campos[extra.chave] = valor.slice(0, 400);
    }
    validos.push({ telefone, miolo, nome, campos });
  }

  return {
    validos,
    rejeitados,
    colunasExtras: Array.from(nomesExtras),
    totalLinhasLidas: linhas.length - inicioDados,
  };
}

/** Interpreta texto colado ou arquivo CSV/TXT com cabeçalho opcional. */
export function importarDestinatariosDeTexto(bruto: string): ResultadoImportacaoDestinatarios {
  const texto = String(bruto ?? '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const linhas = texto
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (linhas.length === 0) {
    return { validos: [], rejeitados: [], colunasExtras: [], totalLinhasLidas: 0 };
  }
  const separador = detectarDelimitador(linhas);
  const tabela = linhas.map((linha) => {
    const celulas = dividirLinhaCsv(linha, separador);
    // Suporta também "86999887766 - João" em listas coladas rapidamente
    if (celulas.length === 1 && /\s+[-|]\s+/.test(celulas[0]!)) {
      const partes = celulas[0]!.split(/\s+[-|]\s+/);
      if (partes.length >= 2 && pareceTelefone(partes[0]!)) {
        return [partes[0]!.trim(), partes.slice(1).join(' - ').trim()];
      }
    }
    return celulas;
  });
  return normalizarTabelaDeDestinatarios(tabela);
}

// ============================================================================================
// Leitor puro e protegido de .xlsx (OOXML ZIP) — sem dependências externas
// ============================================================================================

interface StreamInflateGlobal {
  DecompressionStream?: new (format: 'deflate-raw') => {
    readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void } };
    writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> } };
  };
  TextDecoder: new (label?: string) => { decode(input?: Uint8Array): string };
}

function criarTextDecoder(): { decode(input?: Uint8Array): string } {
  const ctor = (globalThis as unknown as StreamInflateGlobal).TextDecoder;
  return new ctor('utf-8');
}

function caminhoSeguroZip(caminho: string): boolean {
  if (!caminho || caminho.length > 300 || caminho.startsWith('/') || caminho.startsWith('\\') || /^[A-Za-z]:/.test(caminho)) {
    return false;
  }
  return !caminho.split('/').some((seg) => seg === '..' || seg === '.' || seg.includes('\0'));
}

async function inflarDeflateRaw(dados: Uint8Array, limite: number): Promise<Uint8Array> {
  const ctor = (globalThis as unknown as StreamInflateGlobal).DecompressionStream;
  if (typeof ctor !== 'function') {
    throw new Error('Este ambiente não suporta descompactação nativa de planilhas .xlsx.');
  }
  const ds = new ctor('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const copia = new Uint8Array(dados.byteLength);
  copia.set(dados);

  const gravacao = (async () => {
    try {
      await writer.write(copia);
      await writer.close();
    } catch {
      // erro tratado durante a leitura
    }
  })();

  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > limite) {
        throw new Error('Planilha expandida passou do limite de segurança.');
      }
      partes.push(value);
    }
    await gravacao;
  } finally {
    reader.releaseLock();
  }

  const saida = new Uint8Array(total);
  let pos = 0;
  for (const parte of partes) {
    saida.set(parte, pos);
    pos += parte.length;
  }
  return saida;
}

async function lerEntradasZipXlsx(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.length < 22 || bytes.length > LIMITES_IMPORTACAO.maxArquivoBytes) {
    throw new Error('Planilha vazia ou acima do limite de 10 MB.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos -= 1) {
    if (view.getUint32(pos, true) === 0x06054b50 && pos + 22 + view.getUint16(pos + 20, true) === bytes.length) {
      eocd = pos;
      break;
    }
  }
  if (eocd < 0 || view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    throw new Error('Arquivo .xlsx inválido ou corrompido.');
  }
  const totalEntradas = view.getUint16(eocd + 10, true);
  const cdTamanho = view.getUint32(eocd + 12, true);
  const cdInicio = view.getUint32(eocd + 16, true);
  if (
    totalEntradas < 1 ||
    totalEntradas > LIMITES_IMPORTACAO.maxEntradasZip ||
    totalEntradas !== view.getUint16(eocd + 8, true) ||
    cdInicio + cdTamanho !== eocd
  ) {
    throw new Error('Estrutura interna do .xlsx inválida.');
  }

  const dec = criarTextDecoder();
  let cursor = cdInicio;
  let somaExpandida = 0;
  const arquivos = new Map<string, Uint8Array>();

  for (let i = 0; i < totalEntradas; i += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('Cabeçalho do .xlsx inválido.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const metodo = view.getUint16(cursor + 10, true);
    const comprimido = view.getUint32(cursor + 20, true);
    const original = view.getUint32(cursor + 24, true);
    const tamNome = view.getUint16(cursor + 28, true);
    const tamExtra = view.getUint16(cursor + 30, true);
    const tamCom = view.getUint16(cursor + 32, true);
    const disco = view.getUint16(cursor + 34, true);
    const attr = view.getUint32(cursor + 38, true);
    const localPos = view.getUint32(cursor + 42, true);

    if (
      cursor + 46 + tamNome + tamExtra + tamCom > eocd ||
      disco !== 0 ||
      (flags & ~0x808) !== 0 ||
      (metodo !== 0 && metodo !== 8) ||
      original > LIMITES_IMPORTACAO.maxXmlBytes ||
      (somaExpandida += original) > LIMITES_IMPORTACAO.maxExpandidoZipBytes ||
      original > Math.max(4096, comprimido * LIMITES_IMPORTACAO.maxRazaoCompressao) ||
      ((attr >>> 16) & 0xf000) === 0xa000
    ) {
      throw new Error('Planilha .xlsx rejeitada pelas travas de segurança.');
    }

    const caminho = dec.decode(bytes.subarray(cursor + 46, cursor + 46 + tamNome)).replace(/\\/g, '/');
    cursor += 46 + tamNome + tamExtra + tamCom;

    if (!caminho || caminho.endsWith('/')) continue;
    if (!caminhoSeguroZip(caminho)) throw new Error('Caminho inseguro dentro da planilha .xlsx.');
    if (arquivos.has(caminho)) throw new Error('Entrada duplicada na planilha .xlsx.');

    if (localPos + 30 > cdInicio || view.getUint32(localPos, true) !== 0x04034b50) {
      throw new Error('Entrada local inválida dentro do .xlsx.');
    }
    const localNome = view.getUint16(localPos + 26, true);
    const localExtra = view.getUint16(localPos + 28, true);
    const inicioDados = localPos + 30 + localNome + localExtra;
    const fimDados = inicioDados + comprimido;
    if (fimDados > cdInicio) throw new Error('Entrada .xlsx fora dos limites.');

    const bruto = bytes.subarray(inicioDados, fimDados);
    const conteudo = metodo === 0 ? new Uint8Array(bruto) : await inflarDeflateRaw(bruto, Math.max(original + 64, 1));
    if (conteudo.length > LIMITES_IMPORTACAO.maxXmlBytes) {
      throw new Error('Conteúdo XML excede o limite permitido.');
    }
    arquivos.set(caminho, conteudo);
  }
  return arquivos;
}

function decodificarXml(texto: string): string {
  return texto
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_t, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_t, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function afirmarXmlSeguro(xml: string): void {
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error('Planilha contém declarações XML não permitidas.');
  }
}

function colunaParaIndice(ref: string): number {
  const letras = /^([A-Z]+)/i.exec(ref)?.[1]?.toUpperCase() ?? '';
  let idx = 0;
  for (let i = 0; i < letras.length; i += 1) {
    idx = idx * 26 + (letras.charCodeAt(i) - 64);
  }
  return Math.max(idx - 1, 0);
}

function extrairStringsCompartilhadas(xml: string): string[] {
  afirmarXmlSeguro(xml);
  const saida: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const trecho = m[1] ?? '';
    const partes: string[] = [];
    for (const t of trecho.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)) {
      partes.push(decodificarXml(t[1] ?? ''));
    }
    saida.push(partes.join(''));
  }
  return saida;
}

function extrairLinhasDaPlanilha(xml: string, compartilhadas: string[]): string[][] {
  afirmarXmlSeguro(xml);
  const linhas: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (linhas.length >= LIMITES_IMPORTACAO.maxLinhas) break;
    const linhaXml = rowMatch[1] ?? '';
    const linha: string[] = [];
    let proximoIdx = 0;

    for (const cellMatch of linhaXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] ?? '';
      const corpo = cellMatch[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1];
      const idx = ref ? colunaParaIndice(ref) : proximoIdx;
      proximoIdx = idx + 1;
      if (idx > 64) continue;

      const tipo = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? '';
      let valor = '';
      if (tipo === 'inlineStr') {
        const textos = Array.from(corpo.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)).map((t) => decodificarXml(t[1] ?? ''));
        valor = textos.join('');
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
        if (vMatch !== undefined) {
          const bruto = decodificarXml(vMatch);
          if (tipo === 's') {
            valor = compartilhadas[Number(bruto)] ?? '';
          } else if (tipo === 'str' || tipo === 'e' || tipo === 'b') {
            valor = bruto;
          } else {
            // Número no Excel (ex.: 5.586999887766E12 -> string inteira sem notação científica)
            const num = Number(bruto);
            valor = Number.isFinite(num) && Number.isInteger(num) ? num.toFixed(0) : bruto;
          }
        }
      }
      while (linha.length <= idx) linha.push('');
      linha[idx] = valor;
    }

    if (linha.some((c) => c.trim() !== '')) {
      linhas.push(linha);
    }
  }
  return linhas;
}

/** Lê e normaliza destinatários de um buffer .xlsx. */
export async function importarDestinatariosDeXlsx(bytes: Uint8Array): Promise<ResultadoImportacaoDestinatarios> {
  const entradas = await lerEntradasZipXlsx(bytes);
  const dec = criarTextDecoder();

  const ssBytes = entradas.get('xl/sharedStrings.xml');
  const compartilhadas = ssBytes ? extrairStringsCompartilhadas(dec.decode(ssBytes)) : [];

  const caminhoPlanilha =
    Array.from(entradas.keys())
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort()[0] ?? null;

  if (!caminhoPlanilha) {
    throw new Error('Nenhuma aba encontrada dentro da planilha .xlsx.');
  }

  const sheetBytes = entradas.get(caminhoPlanilha)!;
  const tabela = extrairLinhasDaPlanilha(dec.decode(sheetBytes), compartilhadas);
  return normalizarTabelaDeDestinatarios(tabela);
}
