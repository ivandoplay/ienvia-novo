// Consulta a identidade registrada pelo WhatsApp. Nunca inventa outro telefone.
const caches = new WeakMap();
export function nucleoTelefone(jid) {
  const digits=String(jid).split('@')[0];
  return /^55\d{2}9\d{8}$/.test(digits) ? digits.slice(0,4)+digits.slice(5) : digits;
}
export async function resolverDestinatario(sock, jid, { timeoutMs = 8000, exato = false, onResolution = () => {} } = {}) {
  if(typeof jid!=='string'||!/^\d{6,20}@s\.whatsapp\.net$/.test(jid))throw Error('destinatario_invalido');
  let cache=caches.get(sock);if(!cache){cache=new Map();caches.set(sock,cache);}
  const hit=cache.get(jid);if(hit&&hit.until>Date.now()){onResolution({solicitado:jid,registrado:hit.jid});if(exato&&hit.jid!==jid)throw Error('destinatario_divergente');return hit.jid;}
  if(typeof sock.onWhatsApp!=='function')throw Error('consulta_destinatario_indisponivel');
  let timer;
  try {
    const rows=await Promise.race([sock.onWhatsApp(jid),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('consulta_destinatario_timeout')),timeoutMs);})]);
    if(!Array.isArray(rows))throw Error('consulta_destinatario_sem_resposta');
    const candidates=[...new Set(rows.filter(r=>r?.exists===true&&typeof r.jid==='string'&&/^\d{6,20}@s\.whatsapp\.net$/.test(r.jid)&&nucleoTelefone(r.jid)===nucleoTelefone(jid)).map(r=>r.jid))];
    if(candidates.length!==1)throw Error(candidates.length?'destinatario_ambiguo':'destinatario_nao_confirmado');
    onResolution({solicitado:jid,registrado:candidates[0]});
    if(exato&&candidates[0]!==jid)throw Error('destinatario_divergente');
    if(cache.size>=1000)cache.delete(cache.keys().next().value);
    cache.set(jid,{jid:candidates[0],until:Date.now()+300000});return candidates[0];
  } finally {clearTimeout(timer);}
}
