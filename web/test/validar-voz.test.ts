import { test, expect } from 'vitest';
import { ehOggOpus } from '@/lib/audio/validar-voz';
const ogg = () => {
  const b = new Uint8Array(47);
  b.set(new TextEncoder().encode('OggS')); b[5]=2; b[26]=1; b[27]=19;
  b.set(new TextEncoder().encode('OpusHead'),28); b[36]=1; b[37]=1;
  return b;
};
test('aceita cabeçalho Ogg com pacote OpusHead mono ou estéreo',()=>{
  expect(ehOggOpus(ogg())).toBe(true); const b=ogg();b[37]=2;expect(ehOggOpus(b)).toBe(true);
});
test('rejeita WebM, MP3, vazio, truncado e Ogg de outro codec',()=>{
  for(const b of [new Uint8Array(),new Uint8Array([26,69,223,163]),new TextEncoder().encode('ID3'),ogg().slice(0,40)]) expect(ehOggOpus(b)).toBe(false);
  const b=ogg();b[28]=0;expect(ehOggOpus(b)).toBe(false);
});
test('rejeita cabeçalho sem início de stream, pacote incompleto ou canais inválidos',()=>{
  for(const [pos,val] of [[5,0],[27,255],[37,0],[37,8],[4,1]]) {
    const b=ogg();b[pos!]=val!;expect(ehOggOpus(b)).toBe(false);
  }
});
