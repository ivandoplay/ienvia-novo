'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { carregarChatDoTreinamento, enviarMensagemAoEditor, mudarPropostaDoEditor } from './acoes-do-chat';
import { ROTULOS_DOS_CAMPOS, valorLegivel, type EstadoDoEditor, type TurnoDoEditor } from '@/lib/ia/editor-assistido';
import { NOME_DO_PROVEDOR, type Provedor } from '@/lib/ia/regras';
import type { BaseDeTreinamento, ListaDeBases } from '@/lib/ia/treinamento';

interface Props { baseId:string; bloqueado:boolean; aoAtualizar:(base:BaseDeTreinamento|null,lista:ListaDeBases|null)=>void }
const STATUS:Record<TurnoDoEditor['status'],string>={generating:'Preparando…',proposed:'Para revisar',discussed:'Respondido',applied:'Aplicado',discarded:'Descartado',undone:'Desfeito',failed:'Não concluído'};

export function ChatDoTreinamento({baseId,bloqueado,aoAtualizar}:Props) {
 const [estado,setEstado]=useState<EstadoDoEditor>({threads:[],turns:[]});
 const [conversaId,setConversaId]=useState<string|null>(null);
 const [provedores,setProvedores]=useState<Provedor[]>([]);
 const [provedor,setProvedor]=useState<Provedor|' '>(' ');
 const [texto,setTexto]=useState('');
 const [referencia,setReferencia]=useState<{nome:string;texto:string}|null>(null);
 const [ocupado,setOcupado]=useState(false);
 const [carregando,setCarregando]=useState(true);
 const [erro,setErro]=useState('');
 const [aviso,setAviso]=useState('');
 const [historico,setHistorico]=useState(false);
 const vivo=useRef(true);const pedidoEmCurso=useRef(false);const sequencia=useRef(0);
 const mensagem=useRef<HTMLTextAreaElement>(null);const arquivo=useRef<HTMLInputElement>(null);const fim=useRef<HTMLDivElement>(null);
 const id=useId();
 const recarregar=useCallback(async(thread:string|null)=>{
  const seq=++sequencia.current;setCarregando(true);
  try {
   const r=await carregarChatDoTreinamento(baseId,thread);
   if(!vivo.current||seq!==sequencia.current)return;
   if(!r.ok){setErro(r.erro);return;}
   setEstado(r.dados);setProvedores(r.dados.provedores);setProvedor(p=>r.dados.provedores.includes(p as Provedor)?p:r.dados.provedores[0]??' ');
  } catch {if(vivo.current)setErro('A conexão foi interrompida. Atualize a conversa antes de tentar novamente.');}
  finally {if(vivo.current&&seq===sequencia.current)setCarregando(false);}
 },[baseId]);
 useEffect(()=>{vivo.current=true;const timer=window.setTimeout(()=>{void recarregar(null);},0);return()=>{vivo.current=false;window.clearTimeout(timer);};},[recarregar]);
 async function abrir(thread:string|null){if(ocupado||carregando)return;if(texto.trim()&&!window.confirm('Há uma mensagem ainda não enviada. Descartar esse rascunho para trocar de conversa?'))return;setErro('');setAviso('');setTexto('');setReferencia(null);setHistorico(false);setConversaId(thread);await recarregar(thread);}
 async function enviar(){
  if(pedidoEmCurso.current||ocupado||bloqueado||carregando||!texto.trim()||provedor===' ')return;
  pedidoEmCurso.current=true;setOcupado(true);setErro('');setAviso('');const enviado=texto.trim();
  try {
   const r=await enviarMensagemAoEditor({baseId,conversaId,pedidoId:crypto.randomUUID(),provedor,texto:enviado,...(referencia?{referencia}:{})});
   if(!vivo.current)return;
   if(!r.ok){setErro(r.erro);await recarregar(conversaId);return;}
   setTexto('');setReferencia(null);if(arquivo.current)arquivo.current.value='';setConversaId(r.dados.conversaId);await recarregar(r.dados.conversaId);
   if(vivo.current)fim.current?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'nearest'});
  }catch{if(vivo.current)setErro('Não foi possível confirmar o resultado. Reabra a conversa antes de reenviar para evitar cobranças repetidas.');}
  finally{pedidoEmCurso.current=false;if(vivo.current)setOcupado(false);}
 }
 async function transicionar(turno:TurnoDoEditor,acao:'apply'|'undo'|'discard'){
  if(ocupado||pedidoEmCurso.current||bloqueado)return;
  pedidoEmCurso.current=true;setOcupado(true);setErro('');setAviso('');
  try{
   const r=await mudarPropostaDoEditor(turno.id,acao);if(!vivo.current)return;
   if(!r.ok){setErro(r.erro);return;}
   aoAtualizar(r.dados.base,r.dados.lista);
   setAviso(acao==='apply'?'Alterações aprovadas e salvas. Já valem no atendimento.':acao==='undo'?'Alterações desfeitas. A revisão anterior foi restaurada.':'Proposta descartada. O conteúdo salvo não mudou.');
   await recarregar(conversaId);
  }catch{if(vivo.current)setErro('Não foi possível confirmar a operação. Atualize a conversa para conferir o estado antes de tentar novamente.');}
  finally{pedidoEmCurso.current=false;if(vivo.current)setOcupado(false);}
 }
 const desativado=ocupado||carregando||bloqueado;
 return <section className="panel treino-chat" aria-labelledby={`${id}-titulo`}>
  <div className="treino-chat-topo"><h2 className="panel-title" id={`${id}-titulo`}>Editar com IA</h2><div><button type="button" className="btn btn-secondary btn-sm" disabled={desativado} aria-expanded={historico} aria-controls={`${id}-historico`} onClick={()=>setHistorico(!historico)}>Conversas</button><button type="button" className="btn btn-secondary btn-sm" disabled={desativado} onClick={()=>void abrir(null)}>Nova conversa</button></div></div>
  {historico?<div className="treino-chat-historico" id={`${id}-historico`}><div><strong>Conversas desta base</strong><button type="button" className="btn btn-secondary btn-sm" aria-label="Fechar conversas" onClick={()=>setHistorico(false)}>Fechar</button></div>{estado.threads.length?estado.threads.map(t=><button key={t.id} type="button" aria-current={t.id===conversaId?'true':undefined} disabled={desativado} onClick={()=>void abrir(t.id)}>{t.title}<small>{new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(t.updated_at))}</small></button>):<p className="campo-dica">Nenhuma conversa nesta base.</p>}</div>:null}
  <div className="treino-chat-conversa" aria-busy={ocupado||carregando}>
   {bloqueado?<p className="aviso aviso--atencao">Salve ou desfaça as alterações do editor manual antes de usar o chat. Se a base ficou desatualizada, recarregue a página.</p>:null}
   {carregando?<p className="campo-dica" role="status">Carregando conversa…</p>:null}
   {!carregando&&!estado.turns.length?<div className="treino-chat-vazio"><strong>O que você quer melhorar no atendimento?</strong><p>Peça ajustes no treinamento, no catálogo ou nas regras dos áudios. Você revisa antes de salvar.</p><div>{['Deixe as respostas mais diretas, sem perder informações importantes.','Revise quando usar os áudios cadastrados e sugira melhorias.'].map(s=><button className="btn btn-secondary btn-sm" type="button" key={s} disabled={desativado} onClick={()=>{setTexto(s);mensagem.current?.focus();}}>{s.startsWith('Deixe')?'Melhorar o tom':'Revisar os áudios'}</button>)}</div></div>:null}
   {estado.turns.map(t=><article className="treino-chat-turno" key={t.id}><div className="treino-chat-pergunta"><strong>Você</strong><p>{t.user_text}</p></div><div className="treino-chat-resposta"><div className="treino-chat-autor"><strong>✧ Assistente Ienvia</strong><span>{NOME_DO_PROVEDOR[t.provider]}</span></div>{t.reply_text?<p>{t.reply_text}</p>:null}{t.status==='failed'?<p className="aviso aviso--erro">{t.error_detail??'Não foi possível concluir este pedido.'}</p>:null}{t.status==='generating'?<p className="campo-dica">Este pedido está em processamento. Atualize a conversa para conferir o resultado.</p>:null}
    {t.mutations.length>0?<div className="treino-chat-proposta"><div className="treino-chat-proposta-topo"><strong>{t.mutations.length} {t.mutations.length===1?'alteração':'alterações'}</strong><span className={`estado ${t.status==='applied'?'estado--ok':''}`}>{STATUS[t.status]}</span></div>{t.mutations.map(m=><details key={`${m.resource}-${m.id}-${m.field}`}><summary><span>{ROTULOS_DOS_CAMPOS[m.field]??m.field}</span><small>{m.label}</small></summary><div className="treino-chat-comparacao"><div><strong>Antes</strong><pre>{valorLegivel(m.before)}</pre></div><div><strong>Depois</strong><pre>{valorLegivel(m.after)}</pre></div></div></details>)}<div className="treino-chat-proposta-acoes">{t.status==='proposed'?<><button type="button" className="btn btn-primary btn-sm" disabled={desativado} onClick={()=>void transicionar(t,'apply')}>{ocupado?'Aguarde…':'Aplicar alterações'}</button><button type="button" className="btn btn-secondary btn-sm" disabled={desativado} onClick={()=>{setTexto(`Quero ajustar a proposta anterior: `);mensagem.current?.focus();}}>Pedir ajuste</button><button type="button" className="btn btn-secondary btn-sm" disabled={desativado} onClick={()=>void transicionar(t,'discard')}>Descartar</button></>:t.status==='applied'?<button type="button" className="btn btn-secondary btn-sm" disabled={desativado} onClick={()=>void transicionar(t,'undo')}>Desfazer alterações</button>:<span className="campo-dica">{STATUS[t.status]}</span>}</div></div>:null}</div></article>)}
   {ocupado?<p className="campo-dica" role="status">Processando com segurança. Aguarde…</p>:null}<div ref={fim}/>
  </div>
  <div className="treino-chat-recados" aria-live="polite">{erro?<div className="aviso aviso--erro" role="alert">{erro}<button type="button" className="btn btn-secondary btn-sm" disabled={ocupado} onClick={()=>void recarregar(conversaId)}>Atualizar conversa</button></div>:null}{aviso?<p className="aviso aviso--ok">{aviso}</p>:null}</div>
  <div className="treino-chat-composer"><div className="treino-chat-campo"><label className="so-leitor-de-tela" htmlFor={`${id}-mensagem`}>Mensagem para o editor</label><textarea ref={mensagem} id={`${id}-mensagem`} name="mensagem_editor" autoComplete="off" className="campo" rows={2} maxLength={6000} value={texto} disabled={desativado||!provedores.length} placeholder="O que você quer mudar no atendimento?" onChange={e=>setTexto(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();void enviar();}}}/><div className="treino-chat-campo-acoes"><div><button type="button" className="btn btn-secondary btn-sm" aria-label="Anexar referência em texto" disabled={desativado} onClick={()=>arquivo.current?.click()}>＋</button><label htmlFor={`${id}-provedor`} className="so-leitor-de-tela">Provedor deste chat</label><select id={`${id}-provedor`} name="provedor_editor" className="campo" value={provedor} disabled={desativado||!provedores.length} onChange={e=>{setProvedor(e.target.value as Provedor);setAviso('O provedor escolhido vale só para as próximas mensagens do chat. A IA do WhatsApp não mudou.');}}>{!provedores.length?<option value=" ">Sem chave cadastrada</option>:provedores.map(p=><option key={p} value={p}>{NOME_DO_PROVEDOR[p]}</option>)}</select></div><button type="button" className="btn btn-primary btn-sm" disabled={desativado||!texto.trim()||!provedores.length} onClick={()=>void enviar()}>{ocupado?'Aguarde…':'Enviar ↑'}</button></div></div>
  <input type="file" ref={arquivo} hidden accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json" onChange={async e=>{const f=e.target.files?.[0];if(!f)return;if(!/\.(txt|md|csv|json)$/i.test(f.name)||f.size>64000){setErro('Anexe TXT, MD, CSV ou JSON de até 64 kB.');e.target.value='';return;}const text=await f.text();if(vivo.current){setReferencia({nome:f.name.slice(0,200),texto:text});setErro('');}}}/>
  <div className="treino-chat-rodape">{referencia?<span>{referencia.nome}<button type="button" aria-label="Remover referência" disabled={desativado} onClick={()=>{setReferencia(null);if(arquivo.current)arquivo.current.value='';}}>Remover</button></span>:<span>Usa a chave da sua conta · aprovação obrigatória</span>}<span>{texto.length.toLocaleString('pt-BR')}/6.000</span></div>{!carregando&&!provedores.length?<p className="campo-dica">Cadastre uma chave no Motor de IA para começar. O chat não troca de provedor automaticamente.</p>:null}</div>
 </section>;
}
