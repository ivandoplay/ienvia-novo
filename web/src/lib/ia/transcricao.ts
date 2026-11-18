import 'server-only';
import { criarClienteDeServico } from '@/lib/supabase/servico';
import { contextoDaChaveDeIa, decifrar, lerChaveDoCofre } from '@/lib/ia/cofre';
import { transcreverAudio } from '@/lib/ia/provedores';
export async function configuracaoTranscricao(workspaceId: string) {
 const db=criarClienteDeServico();
 if(!db) throw new Error('Serviço de transcrição indisponível.');
 const {data,error}=await db.from('workspace_transcription_settings').select('groq_ciphertext,gemini_fallback').eq('workspace_id',workspaceId).maybeSingle();
 if(error) throw new Error('Não foi possível ler a configuração de transcrição.');
 return data as {groq_ciphertext:string|null;gemini_fallback:boolean}|null;
}
export async function transcreverDaEmpresa(workspaceId:string,audio:Uint8Array,contentType:string) {
 const cfg=await configuracaoTranscricao(workspaceId);
 const cofre=lerChaveDoCofre(); if(!cofre)throw new Error('Cofre de chaves indisponível.');
 let falha='Cadastre sua chave Groq em Motor de IA.';
 if(cfg?.groq_ciphertext){
  const chave=decifrar(cfg.groq_ciphertext,contextoDaChaveDeIa(workspaceId,'groq'),cofre);
  if(!chave)throw new Error('A chave Groq não pode ser aberta. Cadastre novamente.');
  if(!audio.length || audio.length>24*1024*1024)throw new Error('Use um áudio não vazio de até 24 MB.');
  try {
   const mime=(contentType.split(';')[0] || 'audio/ogg').trim();
   const extensoes:Record<string,string>={'audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','audio/webm':'webm','audio/flac':'flac','audio/aac':'aac'};
   const form=new FormData();form.append('file',new Blob([new Uint8Array(audio)],{type:mime}),`audio.${extensoes[mime] || 'ogg'}`);form.append('model','whisper-large-v3-turbo');form.append('language','pt');form.append('response_format','json');form.append('temperature','0');
   const r=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${chave}`},body:form,signal:AbortSignal.timeout(45000),cache:'no-store'});
   if(!r.ok)throw new Error(r.status===401?'Chave Groq inválida.':r.status===429?'Limite de uso da Groq atingido.':`Groq indisponível (HTTP ${r.status}).`);
   const body=await r.json();if(typeof body.text!=='string'||!body.text.trim())throw new Error('A Groq não retornou texto.');
   return {texto:body.text.trim(),modelo:'whisper-large-v3-turbo'};
  } catch(e){falha=e instanceof Error?e.message:'Falha na Groq.';}
 }
 // Sem configuração preserva o comportamento Gemini das empresas já existentes.
 if(!cfg || cfg.gemini_fallback){
  const db=criarClienteDeServico()!;const {data,error}=await db.rpc('read_workspace_ai_keys_for_simulator',{p_workspace_id:workspaceId});
  if(error)throw new Error('Não foi possível ler a chave de reserva.');
  const cifra=data?.gemini;const chave=typeof cifra==='string'?decifrar(cifra,contextoDaChaveDeIa(workspaceId,'gemini'),cofre):null;
  if(chave)return transcreverAudio({chave,audio,contentType});
 }
 throw new Error(falha);
}
