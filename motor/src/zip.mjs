import zlib from 'node:zlib';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Buffer(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractZipBuffer(buffer, options = {}) {
  const maxTotalUncompressedBytes = options.maxTotalBytes || 60 * 1024 * 1024;
  const maxFiles = options.maxFiles || 2000;

  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('Arquivo ZIP inválido ou vazio.');
  }

  let eocdOffset = -1;
  const minEocdOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minEocdOffset; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Estrutura Central Directory do ZIP não encontrada.');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries > maxFiles) {
    throw new Error(`O pacote ZIP excede o limite de segurança (${totalEntries} > ${maxFiles}).`);
  }
  if (cdOffset + cdSize > buffer.length) {
    throw new Error('Central Directory do ZIP truncado ou corrompido.');
  }

  const files = [];
  let totalUncompressed = 0;
  let ptr = cdOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (ptr + 46 > cdOffset + cdSize) {
      throw new Error('Central Directory do ZIP incompleto ou corrompido.');
    }
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('Assinatura inválida no cabeçalho do Central Directory.');
    }

    const flags = buffer.readUInt16LE(ptr + 8);
    const compressionMethod = buffer.readUInt16LE(ptr + 10);
    const expectedCrc = buffer.readUInt32LE(ptr + 16);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const fileNameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const externalAttr = buffer.readUInt32LE(ptr + 38);
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42);

    const nameStart = ptr + 46;
    if (nameStart + fileNameLen + extraLen + commentLen > cdOffset + cdSize) {
      throw new Error('Entrada do Central Directory truncada ou corrompida.');
    }
    const rawName = buffer.subarray(nameStart, nameStart + fileNameLen).toString('utf8');
    ptr = nameStart + fileNameLen + extraLen + commentLen;

    if (rawName.includes('\0') || rawName.split(/[\\/]/).includes('..')) {
      throw new Error(`Caminho inseguro no pacote ZIP: ${rawName}`);
    }

    const normalizedPath = rawName
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg && seg !== '.')
      .join('/');

    if (!normalizedPath) continue;
    const isDirectory = rawName.endsWith('/') || ((externalAttr >> 16) & 0o170000) === 0o040000;
    if (isDirectory) continue;
    if (
      normalizedPath.startsWith('__MACOSX/') ||
      normalizedPath.endsWith('/.DS_Store') ||
      normalizedPath === '.DS_Store' ||
      normalizedPath.endsWith('/Thumbs.db')
    ) {
      continue;
    }

    if (uncompressedSize > maxTotalUncompressedBytes) {
      throw new Error('Arquivo individual do ZIP excede o limite de segurança (60 MB).');
    }
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Cabeçalho local inválido para ${normalizedPath}`);
    }

    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`Dados truncados em ${normalizedPath}`);
    if ((flags & 0x0001) !== 0) throw new Error(`Arquivo protegido por senha não permitido: ${normalizedPath}`);

    const remainingBudget = maxTotalUncompressedBytes - totalUncompressed;
    if (remainingBudget <= 0) throw new Error('ZIP excede o tamanho total máximo de 60 MB.');

    const compSlice = buffer.subarray(dataStart, dataEnd);
    let contentBuf;
    if (compressionMethod === 0) {
      if (compSlice.length > remainingBudget) throw new Error('ZIP excede limite de 60 MB.');
      contentBuf = Buffer.from(compSlice);
    } else if (compressionMethod === 8) {
      contentBuf = zlib.inflateRawSync(compSlice, { maxOutputLength: remainingBudget });
    } else {
      throw new Error(`Método de compressão não suportado: ${compressionMethod}`);
    }

    if (contentBuf.length !== uncompressedSize || crc32Buffer(contentBuf) !== expectedCrc) {
      throw new Error(`Falha de integridade CRC no arquivo ${normalizedPath}.`);
    }
    totalUncompressed += contentBuf.length;

    files.push({
      path: normalizedPath,
      size: contentBuf.length,
      buffer: contentBuf,
    });
  }

  let rootPrefix = '';
  if (files.length > 0) {
    const firstSlash = files[0].path.indexOf('/');
    if (firstSlash > 0) {
      const candidate = files[0].path.slice(0, firstSlash + 1);
      if (files.every((f) => f.path.startsWith(candidate))) {
        rootPrefix = candidate.slice(0, -1);
      }
    }
  }

  return {
    rootFolderName: rootPrefix || null,
    fileCount: files.length,
    totalBytes: totalUncompressed,
    files: files.map((f) => ({
      ...f,
      relPath: rootPrefix ? f.path.slice(rootPrefix.length + 1) : f.path,
    })),
  };
}
