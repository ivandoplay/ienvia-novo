'use server';

import { revalidatePath } from 'next/cache';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';
import { contextoDaChaveDeIa, decifrar, lerChaveDoCofre } from '@/lib/ia/cofre';
import { gerarResposta, ErroDeIa } from '@/lib/ia/provedores';
import { PROVEDORES, lerMotor, modeloDoProvedor, explicarErroDeIa, type Provedor } from '@/lib/ia/regras';
import { lerBase, lerListaDeBases, type BaseDeTreinamento, type ListaDeBases } from '@/lib/ia/treinamento';
import { ErroDeFormatoDoEditor, contextoParaPedidoDoEditor, instrucoesDoEditor, lerPropostaDoEditor, type ContextoDoEditor, type EstadoDoEditor } from '@/lib/ia/editor-assistido';

type ResultadoChat<T> = {ok:true;dados:T}|{ok:false;erro:string};
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function contexto() {
 const sessao=await obterSessao();
 if (!sessao?.workspaceAtivo || sessao.workspaceAtivo.papel!=='owner')return null;
 return {workspaceId:sessao.workspaceAtivo.id,supabase:await criarClienteServidor()};
}
function erroSeguro(message?:string) {
 if(message?.includes('editor_conflict'))return 'O conteúdo mudou depois que a proposta foi preparada. Nada foi sobrescrito. Gere uma nova proposta com os dados atuais.';
 if(message?.includes('editor_busy'))return 'Já existe uma resposta sendo preparada nesta conversa. Aguarde.';
 if(message?.includes('editor_rate_limit'))return 'Limite de uso do editor atingido. Aguarde antes de enviar outra mensagem.';
 if(message?.includes('editor_request_already_used'))return 'Este pedido já foi recebido. Reabra a conversa para conferir o resultado antes de tentar novamente.';
 if(message?.includes('editor_turn_changed'))return 'Esta proposta já mudou de estado. Atualize a conversa antes de continuar.';
 return 'Não foi possível concluir. Confira sua conexão e atualize a conversa. Nenhuma alteração foi aplicada parcialmente.';
}
export async function carregarChatDoTreinamento(baseId:string,conversaId:string|null):Promise<ResultadoChat<EstadoDoEditor & {provedores:Provedor[]}>> {
 const ctx=await contexto();if(!ctx)return {ok:false,erro:'Só o proprietário pode usar o editor com IA.'};
 if(!ID.test(baseId)||(conversaId!==null&&!ID.test(conversaId)))return {ok:false,erro:'Conversa ou base inválida.'};
 const [chat,motor]=await Promise.all([
  ctx.supabase.rpc('read_my_training_ai_chat',{p_workspace_id:ctx.workspaceId,p_agent_id:baseId,p_thread_id:conversaId}),
  ctx.supabase.rpc('read_my_ai_settings',{p_workspace_id:ctx.workspaceId}),
 ]);
 if(chat.error||motor.error)return {ok:false,erro:'Não foi possível carregar o editor com IA. Tente novamente; o editor manual continua disponível.'};
 const cfg=lerMotor(motor.data);
 return {ok:true,dados:{...chat.data as EstadoDoEditor,provedores:PROVEDORES.filter(p=>cfg.chaves[p].cadastrada)}};
}
export async function enviarMensagemAoEditor(entrada:{baseId:string;conversaId:string|null;pedidoId:string;provedor:Provedor;texto:string;referencia?:{nome:string;texto:string}}):Promise<ResultadoChat<{conversaId:string}>> {
 const ctx=await contexto();if(!ctx)return {ok:false,erro:'Só o proprietário pode usar o editor com IA.'};
 if(!entrada || !ID.test(entrada.baseId)||!ID.test(entrada.pedidoId)||(entrada.conversaId!==null&&!ID.test(entrada.conversaId))||!PROVEDORES.includes(entrada.provedor)||typeof entrada.texto!=='string'||entrada.texto.trim().length<1||entrada.texto.length>6000)return {ok:false,erro:'Escreva de 1 a 6.000 caracteres e escolha um provedor disponível.'};
 const ref=entrada.referencia;
 if(ref && (typeof ref.nome!=='string'||ref.nome.length>200||typeof ref.texto!=='string'||ref.texto.length>64000))return {ok:false,erro:'A referência deve ser texto com até 64.000 caracteres.'};
 const [chaveResp,motorResp]=await Promise.all([
  ctx.supabase.rpc('read_my_ai_key_ciphertext',{p_workspace_id:ctx.workspaceId,p_provider:entrada.provedor}),
  ctx.supabase.rpc('read_my_ai_settings',{p_workspace_id:ctx.workspaceId}),
 ]);
 const cofre=lerChaveDoCofre();
 if(!cofre||chaveResp.error||motorResp.error||typeof chaveResp.data!=='string')return {ok:false,erro:'Cadastre uma chave válida deste provedor no Motor de IA. Nenhum outro provedor será usado automaticamente.'};
 const chave=decifrar(chaveResp.data,contextoDaChaveDeIa(ctx.workspaceId,entrada.provedor),cofre);
 if(!chave)return {ok:false,erro:'Não foi possível abrir a chave deste provedor. Confira o cadastro no Motor de IA.'};
 const motor=lerMotor(motorResp.data);const modelo=modeloDoProvedor(motor.configuracao,entrada.provedor);
 const inicio=await ctx.supabase.rpc('begin_my_training_ai_turn',{p_workspace_id:ctx.workspaceId,p_agent_id:entrada.baseId,p_thread_id:entrada.conversaId,p_request_id:entrada.pedidoId,p_provider:entrada.provedor,p_text:entrada.texto});
 if(inicio.error)return {ok:false,erro:erroSeguro(inicio.error.message)};
 const pacote=inicio.data as {thread_id:string;context:ContextoDoEditor;history:Array<{user_text:string;reply_text:string;status:string;mutations:unknown[]}>};
 let proposta:ReturnType<typeof lerPropostaDoEditor>;
 try {
  const falas=pacote.history.flatMap(t=>[
   {de:'cliente' as const,texto:t.user_text},
   {de:'atendente' as const,texto:JSON.stringify({resposta:`${t.reply_text||'O pedido anterior não foi concluído.'}\nEstado deste pedido no histórico: ${t.status}.`,alteracoes:t.status==='proposed'?t.mutations.map(m=>{const c=m as {resource:string;id:string;field:string;after:unknown};return {resource:c.resource,id:c.id,field:c.field,value:c.after};}):[]})},
  ]);
  falas.push({de:'cliente',texto:entrada.texto+(ref?`\nReferência fornecida pelo dono (${ref.nome}):\n<referencia>${ref.texto.replace(/</g,'‹')}</referencia>`:'')});
  const contextoVisivel=ref?pacote.context:contextoParaPedidoDoEditor(pacote.context,entrada.texto);
  const pedido={provedor:entrada.provedor,chave,modelo,sistema:instrucoesDoEditor(contextoVisivel),conversa:falas,temperatura:0.1,formatoJson:true,limiteDeSaida:8192};
  const resposta=await gerarResposta({...pedido,tempoLimiteMs:30000});
  try {proposta=lerPropostaDoEditor(resposta.texto,contextoVisivel);}
  catch(erroDeFormato){
   if(!(erroDeFormato instanceof ErroDeFormatoDoEditor))throw erroDeFormato;
   // Uma única recuperação no MESMO provedor/modelo, sem relaxar a validação ou aplicar nada.
   const corrigida=await gerarResposta({...pedido,tempoLimiteMs:20000,sistema:pedido.sistema+'\nA tentativa anterior não respeitou o formato. Refaça a resposta ao pedido do dono como um único objeto JSON válido com resposta e alteracoes. Se for saudação ou conversa, alteracoes deve ser []. Não acrescente mudanças que o dono não solicitou.'});
   proposta=lerPropostaDoEditor(corrigida.texto,contextoVisivel);
  }
 } catch(error) {
  const detalhe=error instanceof ErroDeIa?explicarErroDeIa(error.motivo,entrada.provedor,modelo):error instanceof Error?error.message:'Não foi possível preparar a proposta.';
  // Nunca registrar texto bruto do provedor, chaves ou respostas HTTP nos logs.
  const seguro=detalhe.replaceAll(chave,'[chave protegida]').slice(0,500);
  await ctx.supabase.rpc('finish_my_training_ai_turn',{p_workspace_id:ctx.workspaceId,p_turn_id:entrada.pedidoId,p_reply:'',p_changes:[],p_error:seguro});
  return {ok:false,erro:seguro};
 }
 const fim=await ctx.supabase.rpc('finish_my_training_ai_turn',{p_workspace_id:ctx.workspaceId,p_turn_id:entrada.pedidoId,p_reply:proposta.resposta,p_changes:proposta.alteracoes,p_error:null});
 if(fim.error){
  await ctx.supabase.rpc('finish_my_training_ai_turn',{p_workspace_id:ctx.workspaceId,p_turn_id:entrada.pedidoId,p_reply:'',p_changes:[],p_error:'A proposta foi recusada pela validação. Peça uma alteração menor.'});
  return {ok:false,erro:'A proposta foi recusada pela validação. Nada foi alterado.'};
 }
 return {ok:true,dados:{conversaId:pacote.thread_id}};
}
export async function mudarPropostaDoEditor(turnoId:string,acao:'apply'|'undo'|'discard'):Promise<ResultadoChat<{base:BaseDeTreinamento|null;lista:ListaDeBases|null}>> {
 const ctx=await contexto();if(!ctx)return {ok:false,erro:'Só o proprietário pode aprovar alterações.'};
 if(!ID.test(turnoId)||!['apply','undo','discard'].includes(acao))return {ok:false,erro:'Proposta inválida.'};
 const {error}=await ctx.supabase.rpc('transition_my_training_ai_proposal',{p_workspace_id:ctx.workspaceId,p_turn_id:turnoId,p_action:acao});
 if(error)return {ok:false,erro:erroSeguro(error.message)};
 for(const path of ['/treinamento','/catalogo','/audios','/simulador'])revalidatePath(path);
 const {data:turnData}=await ctx.supabase.rpc('read_my_training_ai_proposal_agent',{p_workspace_id:ctx.workspaceId,p_turn_id:turnoId});
 const baseId=typeof turnData==='string'?turnData:null;
 if(!baseId)return {ok:true,dados:{base:null,lista:null}};
 const [baseResp,listaResp]=await Promise.all([ctx.supabase.rpc('read_my_ai_agent',{p_workspace_id:ctx.workspaceId,p_agent_id:baseId,p_include_content:false}),ctx.supabase.rpc('read_my_ai_agents',{p_workspace_id:ctx.workspaceId})]);
 return {ok:true,dados:{base:baseResp.error?null:lerBase(baseResp.data),lista:listaResp.error?null:lerListaDeBases(listaResp.data)}};
}
