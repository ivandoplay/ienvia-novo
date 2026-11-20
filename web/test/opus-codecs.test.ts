import { afterEach, expect, test, vi } from 'vitest';
import { codificarOpus } from '@/lib/audio/opus';
import { ehOggOpus } from '@/lib/audio/validar-voz';
afterEach(()=>vi.unstubAllGlobals());
test('usa output/error do construtor WebCodecs e produz contêiner Ogg/Opus', async()=>{
  let perfil:unknown;
  class Encoder {
    static isConfigSupported=async()=>({supported:true});
    constructor(private init:{output:(c:unknown)=>void;error:(e:unknown)=>void}) {
      expect(typeof init.output).toBe('function');expect(typeof init.error).toBe('function');
    }
    configure(c:unknown){perfil=c;}
    encode(){this.init.output({byteLength:3,timestamp:0,duration:20000,copyTo:(b:Uint8Array)=>b.set([0xf8,0xff,0xfe])});}
    async flush(){} close(){}
  }
  vi.stubGlobal('window',{AudioEncoder:Encoder,AudioData:class{close(){}}});
  const buffer={sampleRate:48000,numberOfChannels:1,length:960,getChannelData:()=>new Float32Array(960)} as unknown as AudioBuffer;
  const bytes=await codificarOpus(buffer);
  expect(perfil).toEqual({codec:'opus',sampleRate:48000,numberOfChannels:1,bitrate:32000});
  expect(ehOggOpus(bytes!)).toBe(true);
});
