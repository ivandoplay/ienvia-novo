'use client';
import {useState} from 'react';
import {transcreverAudioDaConversa} from './transcrever-audio';
export function TranscricaoDoAudio({mensagemId}:{mensagemId:string}){
 const [texto,setTexto]=useState(''),[erro,setErro]=useState(''),[ocupado,setOcupado]=useState(false);
 return <div className="audio-transcricao">{texto?<><small>Transcrição automática · pode conter erros</small><p>{texto}</p></>:<button type="button" className="btn btn-secondary btn-sm" disabled={ocupado} onClick={async()=>{setOcupado(true);setErro('');try{const r=await transcreverAudioDaConversa(mensagemId);if(r.ok)setTexto(r.texto);else setErro(r.erro);}catch{setErro('Falha de conexão. Tente novamente.');}finally{setOcupado(false);}}}>{ocupado?'Transcrevendo…':'Transcrever áudio'}</button>}{erro&&<p className="audio-transcricao-erro" role="alert">{erro}</p>}</div>;
}
