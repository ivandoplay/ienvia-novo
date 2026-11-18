'use server';
import {obterSessao} from '@/lib/sessao';
import {criarClienteServidor} from '@/lib/supabase/servidor';
import {criarClienteDeServico} from '@/lib/supabase/servico';
import {transcreverDaEmpresa} from '@/lib/ia/transcricao';
import {ehIdentificador} from '@/lib/instancias/regras';
import {DEPOSITO} from '@/lib/inbox/arquivos';
export async function transcreverAudioDaConversa(id:string):Promise<{ok:true;texto:string}|{ok:false;erro:string}>{
 if(!ehIdentificador(id))return {ok:false,erro:'Mensagem inválida.'};
 const sessao=await obterSessao();const workspace=sessao?.workspaceAtivo?.id;
 if(!workspace)return {ok:false,erro:'Entre novamente para transcrever.'};
 const db=await criarClienteServidor();
 // Autoriza com RLS antes de acessar o depósito usando a chave de serviço.
 const {data:mensagem,error}=await db.from('messages').select('id').eq('workspace_id',workspace).eq('id',id).maybeSingle();
 if(error||!mensagem)return {ok:false,erro:'Mensagem não encontrada ou sem acesso.'};
 const servico=criarClienteDeServico();if(!servico)return {ok:false,erro:'Serviço indisponível.'};
 const {data:arquivo}=await db.from('message_attachments').select('object_key,content_type,storage_status,kind,byte_size').eq('workspace_id',workspace).eq('message_id',id).maybeSingle();
 if(!arquivo||arquivo.storage_status!=='stored'||!arquivo.object_key||(arquivo.kind!=='audio'||!arquivo.content_type?.startsWith('audio/')))return {ok:false,erro:'O áudio precisa estar disponível no painel para transcrever.'};
 if(arquivo.byte_size>24*1024*1024)return {ok:false,erro:'Este áudio ultrapassa o limite de 24 MB para transcrição.'};
 const {data:blob,error:falha}=await servico.storage.from(DEPOSITO).download(arquivo.object_key);
 if(falha||!blob)return {ok:false,erro:'Não foi possível abrir o áudio.'};
 if(blob.size>24*1024*1024)return {ok:false,erro:'Este áudio ultrapassa o limite de 24 MB para transcrição.'};
 try{const r=await transcreverDaEmpresa(workspace,new Uint8Array(await blob.arrayBuffer()),arquivo.content_type);return {ok:true,texto:r.texto};}
 catch(e){const texto=e instanceof Error?e.message:'';return {ok:false,erro:/Groq|24 MB|Cadastre|reserva|Cofre|configuração/.test(texto)?texto:'Não foi possível transcrever agora. Confira sua chave e tente novamente.'};}
}
