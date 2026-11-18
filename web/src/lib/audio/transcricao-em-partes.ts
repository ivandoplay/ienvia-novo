/** WAV PCM mono, 8 kHz: cada bloco de 30s cabe no limite padrão das Server Actions. */
export function codificarTrechoWav(buffer: AudioBuffer, inicio: number, fim: number): Uint8Array {
  const taxa = 8000;
  const n = Math.ceil((fim - inicio) * taxa);
  const bytes = new Uint8Array(44 + n * 2);
  const v = new DataView(bytes.buffer);
  const texto = (offset: number, s: string) => { for (let i=0;i<s.length;i++) v.setUint8(offset+i,s.charCodeAt(i)); };
  texto(0,'RIFF'); v.setUint32(4,36+n*2,true); texto(8,'WAVE'); texto(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,taxa,true); v.setUint32(28,taxa*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
  texto(36,'data'); v.setUint32(40,n*2,true);
  // Média dos canais e das amostras de origem para reduzir aliasing na conversão.
  const canais = Array.from({length:buffer.numberOfChannels},(_,c)=>buffer.getChannelData(c));
  for(let i=0;i<n;i++) {
    const a=Math.floor((inicio+i/taxa)*buffer.sampleRate);
    const b=Math.min(buffer.length,Math.max(a+1,Math.floor((inicio+(i+1)/taxa)*buffer.sampleRate)));
    let soma=0, total=0;
    for(const canal of canais) for(let j=a;j<b;j++){soma+=canal[j] ?? 0;total++;}
    const x=Math.max(-1,Math.min(1,total?soma/total:0));
    v.setInt16(44+i*2,x<0?x*32768:x*32767,true);
  }
  return bytes;
}
export async function prepararTrechosDeTranscricao(url: string): Promise<string[]> {
  const resposta=await fetch(url);
  if(!resposta.ok) throw new Error('Não foi possível baixar o áudio para dividir.');
  const contexto=new AudioContext();
  try {
    const buffer=await contexto.decodeAudioData(await resposta.arrayBuffer());
    if(!buffer.duration || buffer.duration>3600) throw new Error('Use um áudio com até uma hora.');
    const trechos:string[]=[];
    for(let inicio=0;inicio<buffer.duration;inicio+=30){
      const bytes=codificarTrechoWav(buffer,inicio,Math.min(inicio+30,buffer.duration));
      let binario=''; for(let i=0;i<bytes.length;i+=8192) binario+=String.fromCharCode(...bytes.subarray(i,i+8192));
      trechos.push(btoa(binario));
    }
    return trechos;
  } finally { await contexto.close(); }
}
