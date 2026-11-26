// Decodificador WASM: nao exige FFmpeg, Python ou binarios nativos no computador do cliente.
export async function prepararMensagemDeVoz(audio, { criarDecoder } = {}) {
  if(!Buffer.isBuffer(audio)||audio.subarray(0,4).toString()!=='OggS'||!audio.subarray(0,128).includes(Buffer.from('OpusHead'))) {
    throw new Error('Mensagem de voz exige OGG/Opus. Converta o arquivo no painel ou envie como audio comum.');
  }
  if(audio.length>16*1024*1024)throw new Error('Mensagem de voz excede 16 MB.');
  // Limita expansao de arquivos Opus longos antes de reservar PCM em memoria.
  let last=0,i=0;
  for(;i+27<=audio.length;){
    if(audio.subarray(i,i+4).toString()!=='OggS')throw new Error('Arquivo OGG incompleto.');
    const n=audio[i+26];if(i+27+n>audio.length)throw new Error('Arquivo OGG incompleto.');
    const granule=audio.readBigUInt64LE(i+6);if(granule!==0xffffffffffffffffn)last=Math.max(last,Number(granule));
    let size=0;for(let j=0;j<n;j++)size+=audio[i+27+j];i+=27+n+size;if(i>audio.length)throw new Error('Arquivo OGG incompleto.');
  }
  if(i!==audio.length)throw new Error('Arquivo OGG incompleto.');
  if(last>48000*15*60)throw new Error('Mensagem de voz acima de 15 minutos. Envie como arquivo de audio.');
  const decoder=criarDecoder?criarDecoder():new (await import('ogg-opus-decoder')).OggOpusDecoderWebWorker();
  try {
    await decoder.ready;const decoded=await decoder.decodeFile(audio);
    const canais=decoded.channelData,amostras=decoded.samplesDecoded;
    if(!amostras||!canais?.length||decoded.errors?.length)throw new Error('Nao foi possivel validar o conteudo OGG/Opus.');
    const niveis=[];
    for(let b=0;b<64;b++){
      const start=Math.floor(b*amostras/64),end=Math.floor((b+1)*amostras/64);let sum=0,count=0;
      for(let i=start;i<end;i++)for(const c of canais){sum+=c[i]*c[i];count++;}
      niveis.push(Math.sqrt(sum/Math.max(1,count)));
    }
    const max=Math.max(...niveis)||1;
    return {audio,ptt:true,mimetype:'audio/ogg; codecs=opus',seconds:Math.max(1,Math.round(amostras/decoded.sampleRate)),waveform:Buffer.from(niveis.map(n=>Math.round(n/max*100)))};
  } finally { await decoder.free(); }
}
