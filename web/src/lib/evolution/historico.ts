import 'server-only';
import { interpretarAviso } from '@/lib/evolution/aviso';
import { buscarPaginaHistorico } from '@/lib/evolution/cliente';
import { criarClienteDeServico } from '@/lib/supabase/servico';
export function normalizarHistorico(instancia:string,itens:unknown[]) {
 return itens.map(item=>interpretarAviso({event:'MESSAGES_UPSERT',instance:instancia,data:item},new Date(),true)).flatMap(a=>a.tipo==='mensagem'?[{event_id:a.idDoEvento,sender_jid:a.remetente,push_name:a.nome,body_text:a.texto,occurred_at:a.quando,from_me:a.deMim,media:a.arquivo?{kind:a.arquivo.tipo,mime:a.arquivo.conteudo,size:a.arquivo.tamanho,file_name:a.arquivo.nome,duration:a.arquivo.duracao,voice:a.arquivo.voz}:null}]:[]);
}
export async function recuperarHistoricoEvolution() {
 const db=criarClienteDeServico();if(!db)return;
 const {data:jobs,error}=await db.from('evolution_history_recovery').select('*').eq('status','pending').order('updated_at').limit(2);
 if(error)throw new Error('Não foi possível ler fila de recuperação.');
 for(const job of jobs||[]) {
  // Lock otimista: duas execuções não avançam o mesmo cursor.
  const stamp=new Date().toISOString();
  const {data:lock}=await db.from('evolution_history_recovery').update({updated_at:stamp}).eq('instance_id',job.instance_id).eq('updated_at',job.updated_at).select('instance_id');
  if(!lock?.length)continue;
  try {
   const {data:inst}=await db.from('instances').select('status,provider_instance_name').eq('id',job.instance_id).maybeSingle();
   if(!inst||inst.status==='revoked'||inst.provider_instance_name!==job.instance_name){await db.from('evolution_history_recovery').update({status:'failed',last_error:'instance_unavailable'}).eq('instance_id',job.instance_id).eq('updated_at',stamp);continue;}
   const pagina=await buscarPaginaHistorico(job.instance_name,job.next_page);
   if(!pagina.registros.length && job.next_page===1){
    await db.from('evolution_history_recovery').update({attempts:job.attempts+1,status:job.attempts>=11?'failed':'pending',last_error:'waiting_provider_history'}).eq('instance_id',job.instance_id).eq('updated_at',stamp);
    if(job.attempts<11)await new Promise(resolve=>setTimeout(resolve,20000));
    continue;
   }
   const mensagens=normalizarHistorico(job.instance_name,pagina.registros);
   const {error:erroNomes}=await db.rpc('refresh_evolution_history_names',{p_instance_name:job.instance_name,p_token_sha256:job.token_sha256,p_messages:mensagens});
   if(erroNomes)throw new Error('Falha ao atualizar nomes.');
   const pendentes=(job.pending_identity_count || 0)+mensagens.filter(m=>m.sender_jid.endsWith('@lid')).length;
   const {data:enfileirado,error:falha}=await db.rpc('enqueue_evolution_history',{p_instance_name:job.instance_name,p_token_sha256:job.token_sha256,p_messages:mensagens});
   if(falha||enfileirado?.result==='unauthorized')throw new Error('Falha ao preservar página.');
   await db.from('evolution_history_recovery').update({next_page:job.next_page+1,status:pagina.ultima?(pendentes?'partial':'done'):'pending',pending_identity_count:pendentes,last_synced_at:pagina.ultima?stamp:job.last_synced_at,attempts:0,last_error:null}).eq('instance_id',job.instance_id).eq('updated_at',stamp);
  } catch {
   await db.from('evolution_history_recovery').update({attempts:job.attempts+1,status:job.attempts>=4?'failed':'pending',last_error:'provider_or_storage_error'}).eq('instance_id',job.instance_id).eq('updated_at',stamp);
  }
 }
 await db.rpc('process_evolution_history_queue',{p_limit:100});
}

/** Worker exclusivo de histórico: não executa campanhas nem atendimento ao vivo. */
export async function continuarHistoricoEvolution() {
 const db=criarClienteDeServico();if(!db)return;
 const inicio=Date.now();
 for(let volta=0;volta<20 && Date.now()-inicio<30000;volta++) {
  await recuperarHistoricoEvolution();
  const [{count:a},{count:b}]=await Promise.all([
   db.from('evolution_history_recovery').select('instance_id',{head:true,count:'exact'}).eq('status','pending'),
   db.from('evolution_history_queue').select('id',{head:true,count:'exact'}).eq('status','pending')
  ]);
  if(!a&&!b)return;
 }
 const segredo=process.env.CRON_SECRET?.trim();
 const base=(process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL)?.trim();
 if(!segredo||!base)throw new Error('Continuação de histórico sem configuração.');
 const resposta=await fetch(`${base}/functions/v1/evolution-webhook`,{method:'POST',headers:{'x-ienvia-history':segredo},signal:AbortSignal.timeout(10000)});
 if(!resposta.ok)throw new Error('Não foi possível continuar a recuperação; cursor preservado.');
}
