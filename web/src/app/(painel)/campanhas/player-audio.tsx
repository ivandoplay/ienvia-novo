 'use client';
import { useState } from 'react';
import { obterPreviaAudioCampanha } from './acoes';

export function PlayerAudioCampanha({ id, nome }: { id: string; nome: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  async function abrir() {
    setCarregando(true); setErro(null);
    try {
      const res = await obterPreviaAudioCampanha(id);
      if (res.ok) setUrl(res.url); else setErro(res.erro);
    } catch { setErro('Falha ao carregar o áudio. Tente novamente.'); }
    finally { setCarregando(false); }
  }
  return <div style={{ minWidth: 0, maxWidth: '100%', marginTop: 8 }}>
    {!url ? <button type="button" className="btn btn-secondary" disabled={carregando} onClick={abrir}
      aria-label={`Ouvir ${nome}`}>{carregando ? 'Carregando áudio…' : '▶ Ouvir áudio'}</button>
      : <audio controls preload="metadata" src={url} aria-label={`Reproduzir ${nome}`}
          style={{ width: '100%', maxWidth: 360 }} onPlay={(e) => {
            document.querySelectorAll('audio').forEach((a) => { if (a !== e.currentTarget) a.pause(); });
          }} onError={() => { setUrl(null); setErro('Não foi possível reproduzir. Clique em Ouvir para tentar novamente.'); }} />}
    {erro && <p role="alert" className="f5-card-sub">{erro}</p>}
  </div>;
}
