import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sha256Hex } from './autenticacao';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Buffer(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface EntradaZip {
  path: string;
  content: Buffer | string;
  executable?: boolean;
}

/** Gerador de arquivo .ZIP puro usando apenas `node:zlib` (compatível com serverless Vercel/Netlify). */
export function montarZip(entradas: EntradaZip[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  // Data fixa determinística para que o hash SHA-256 do pacote nunca mude entre builds do mesmo código.
  const dosTime = (12 << 11) | (0 << 5) | 0;
  const dosDate = ((2026 - 1980) << 9) | (11 << 5) | 12;

  for (const entrada of [...entradas].sort((a, b) => a.path.localeCompare(b.path))) {
    const cleanPath = entrada.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath) continue;
    const nameBuf = Buffer.from(cleanPath, 'utf8');
    const rawBuf = Buffer.isBuffer(entrada.content) ? entrada.content : Buffer.from(entrada.content, 'utf8');
    const crc = crc32Buffer(rawBuf);
    const compressedBuf = zlib.deflateRawSync(rawBuf, { level: 9 });
    const useDeflate = compressedBuf.length < rawBuf.length;
    const dataBuf = useDeflate ? compressedBuf : rawBuf;
    const method = useDeflate ? 8 : 0;
    const flags = 0x0800;
    const mode = entrada.executable ? 0o100755 : 0o100644;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4); // Unix + PKZIP 2.0 (preserva permissão +x no unzip)
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const count = centralParts.length / 2;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function localizarPastaMotor(): string | null {
  const candidatos = [
    path.resolve(process.cwd(), 'motor'),
    path.resolve(process.cwd(), '..', 'motor'),
    path.resolve(__dirname, '../../../../motor'),
    path.resolve(__dirname, '../../../../../motor'),
  ];
  for (const dir of candidatos) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src', 'index.mjs'))) {
      return dir;
    }
  }
  return null;
}

function listarArquivosDoMotor(motorDir: string): EntradaZip[] {
  const entradas: EntradaZip[] = [
    {
      path: 'ienvia-motor/package.json',
      content: fs.readFileSync(path.join(motorDir, 'package.json')),
    },
  ];

  const coletar = (sub: string, executavel: boolean) => {
    const dir = path.join(motorDir, sub);
    if (!fs.existsSync(dir)) return;
    for (const nome of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, nome);
      if (!fs.statSync(full).isFile()) continue;
      entradas.push({
        path: `ienvia-motor/${sub}/${nome}`,
        content: fs.readFileSync(full),
        executable: executavel && nome.endsWith('.sh'),
      });
    }
  };

  for (const nome of ['INICIAR-WINDOWS.bat', 'INICIAR-TERMUX.sh', 'INICIAR-LINUX.sh', 'LEIA-ME.md', 'package-lock.json']) {
    const arquivo = path.join(motorDir, nome);
    if (fs.existsSync(arquivo)) entradas.push({ path: `ienvia-motor/${nome}`, content: fs.readFileSync(arquivo), executable: nome.endsWith('.sh') });
  }

  coletar('src', false);
  coletar('scripts', true);

  entradas.push({
    path: 'ienvia-motor/README.txt',
    content: [
      'IENVIA MOTOR LOCAL — INSTALACAO RAPIDA',
      '======================================',
      '',
      '1. Extraia o ZIP inteiro; nao execute dentro do compactador.',
      '2. Windows: clique duas vezes em INICIAR-WINDOWS.bat.',
      '   O instalador prepara Node.js portatil se necessario e verifica o SHA-256.',
      '3. Android: extraia a pasta dentro de $HOME no Termux.',
      '   Execute: bash INICIAR-TERMUX.sh',
      '   Na primeira preparacao, o Termux pode atualizar seus pacotes.',
      '4. Cole apenas o codigo IENV-XXXX-XXXX gerado em Conexoes / Motor.',
      '   Nas proximas aberturas, o vinculo salvo sera reaproveitado.',
      '5. No painel, vincule uma instancia ao aparelho e conecte o WhatsApp.',
      '   O codigo IENV vincula o aparelho, nao substitui a confirmacao do WhatsApp.',
      '6. Mantenha a janela aberta e desative a economia de bateria do Termux.',
      'Nunca compartilhe data/, tokens, arquivos de autenticacao ou .env.',
      'Nao copie credenciais do servidor para o motor.',
      'Nao apague data/ ao atualizar. Ctrl+C encerra sem apagar a sessao.',
      'Linux/VPS: execute bash INICIAR-LINUX.sh.',
      'Atualizacao: verificada antes de conectar e a cada 15 minutos (com pequena dispersao).',
      'A troca reinicia o processo automaticamente. Dados e sessoes sao preservados.',
      'Historico importado: ultimos 30 dias. A IA nao responde a importacoes.',
      'Inicializacao automatica opcional: veja LEIA-ME.md. Nunca ativada sem sua escolha.',
      'Mensagens de voz precisam de OGG/Opus valido; MP3 pode ser enviado como audio comum.',
      '',
    ].join('\n'),
  });

  return entradas;
}

export interface PacoteDoMotorPronto {
  version: string;
  sha256: string;
  size: number;
  buffer: Buffer;
}

let cachePacote: { version: string; result: PacoteDoMotorPronto } | null = null;

export function gerarPacoteDoMotor(): PacoteDoMotorPronto | null {
  const motorDir = localizarPastaMotor();
  if (!motorDir) return null;

  const pkg = JSON.parse(fs.readFileSync(path.join(motorDir, 'package.json'), 'utf8')) as { version?: string };
  const version = pkg.version || '6.0.0';
  if (cachePacote && cachePacote.version === version) return cachePacote.result;

  const entradas = listarArquivosDoMotor(motorDir);
  const buffer = montarZip(entradas);
  const result: PacoteDoMotorPronto = {
    version,
    sha256: sha256Hex(buffer),
    size: buffer.length,
    buffer,
  };
  cachePacote = { version, result };
  return result;
}
