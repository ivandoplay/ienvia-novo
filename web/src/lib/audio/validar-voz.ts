/** Valida o contêiner e o primeiro pacote, não a extensão ou o MIME informado. */
export function ehOggOpus(bytes: Uint8Array): boolean {
  if (bytes.length < 47 || String.fromCharCode(...bytes.slice(0, 4)) !== 'OggS' || bytes[4] !== 0 || !(bytes[5]! & 2)) return false;
  const segmentos = bytes[26]!;
  if (!segmentos || bytes.length < 27 + segmentos) return false;
  let tamanho = 0;
  let completo = false;
  for (let i = 0; i < segmentos; i++) {
    const n = bytes[27 + i]!;
    tamanho += n;
    if (n < 255) { completo = true; break; }
  }
  const inicio = 27 + segmentos;
  return completo && tamanho >= 19 && bytes.length >= inicio + tamanho &&
    String.fromCharCode(...bytes.slice(inicio, inicio + 8)) === 'OpusHead' &&
    bytes[inicio + 8] === 1 && (bytes[inicio + 9] === 1 || bytes[inicio + 9] === 2);
}
