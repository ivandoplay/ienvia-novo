'use client';
import {useEffect,useState} from 'react';
import {Dialogo} from '@/components/ui/dialogo';
import {Icone} from '@/components/ui/icone';
import {lerTranscricao,salvarTranscricao} from './acoes';
export function ConfiguracaoTranscricao({podeEditar=true}:{podeEditar?:boolean}){
 const [chave,setChave]=useState(''),[reserva,setReserva]=useState(false),[cadastrada,setCadastrada]=useState(false),[ocupado,setOcupado]=useState(true),[recado,setRecado]=useState('');
 const [final,setFinal]=useState<string|null>(null),[atualizadaEm,setAtualizadaEm]=useState<string|null>(null);
 const [janela,setJanela]=useState<'chave'|'remover'|null>(null);
 useEffect(()=>{lerTranscricao().then(r=>{if(r.ok){setCadastrada(r.cadastrada);setReserva(r.reserva);setFinal(r.final);setAtualizadaEm(r.atualizadaEm);}else setRecado(r.erro);}).catch(()=>setRecado('Não foi possível carregar.')).finally(()=>setOcupado(false));},[]);
 async function salvar(remover=false){setOcupado(true);setRecado('');try{const r=await salvarTranscricao(chave,reserva,remover);if(r.ok){setCadastrada(!remover);if(remover){setFinal(null);setAtualizadaEm(null);}else if(chave.trim()){setFinal(chave.trim().slice(-4));setAtualizadaEm(new Date().toISOString());}setChave('');setRecado('Configuração salva.');setJanela(null);}else setRecado(r.erro);}catch{setRecado('Falha ao salvar.');}finally{setOcupado(false);}}
 return <>
 <article className="motor-provedor" aria-label="Groq">
  <div className="motor-provedor-topo"><h3>Groq</h3><span className={cadastrada?'estado estado--ok':'estado'}>{cadastrada?'Chave cadastrada':'Sem chave'}</span></div>
  <p className="motor-provedor-resumo">Transcreve áudios da biblioteca e mensagens de voz recebidas no WhatsApp. Não altera a IA que responde às conversas.</p>
  <p className="motor-provedor-chave"><Icone nome="chave" className="icon-15"/><span>{cadastrada?<>{final?<>Termina em <code>…{final}</code></>:'Guardada e protegida'}{atualizadaEm?` · atualizada em ${new Date(atualizadaEm).toLocaleDateString('pt-BR')}`:''}</>:<>Nenhuma chave cadastrada. <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Criar uma chave no site da Groq</a></>}</span></p>
  {podeEditar&&<div className="motor-provedor-acoes">
   <button type="button" className="btn btn-secondary btn-sm" disabled={ocupado} onClick={()=>{setChave('');setRecado('');setJanela('chave');}}>{cadastrada?'Trocar chave':'Cadastrar chave'}<span className="so-leitor-de-tela"> da Groq</span></button>
   {cadastrada&&<button type="button" className="btn btn-danger btn-sm" disabled={ocupado} onClick={()=>setJanela('remover')}>Remover chave<span className="so-leitor-de-tela"> da Groq</span></button>}
  </div>}
  <div className="form-group motor-provedor-modelo"><label className="form-label" htmlFor="groq-modelo">Modelo da Groq</label><input id="groq-modelo" className="campo" readOnly value="whisper-large-v3-turbo"/><p className="panel-desc">Especializado em transcrição. O áudio inteiro é priorizado.</p></div>
  <div className="form-group"><label className="form-label">Provedor de reserva</label><p className="panel-desc">{reserva?'Gemini autorizado como reserva.':'Gemini desativado. Apenas a Groq será usada.'}</p>{podeEditar&&cadastrada&&<button type="button" className="btn btn-secondary btn-sm" disabled={ocupado} onClick={()=>{setRecado('');setJanela('chave');}}>Configurar reserva</button>}</div>
  {!janela&&recado&&<p className="aviso" role="status">{recado}</p>}
 </article>
 {janela==='chave'&&<Dialogo titulo="Chave da Groq" aoFechar={()=>{if(!ocupado){setChave('');setJanela(null);}}}>
  <form onSubmit={e=>{e.preventDefault();void salvar();}}>
   <p className="dialogo-texto">Cole a chave criada na sua conta da Groq. Ela fica cifrada no cofre e não aparece inteira novamente. <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Abrir o site da Groq para criar uma chave</a></p>
   <div className="form-group"><label className="form-label" htmlFor="groq-chave-nova">Chave da Groq</label><input id="groq-chave-nova" className="campo" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={204} value={chave} onChange={e=>setChave(e.target.value)} placeholder={cadastrada?'Deixe vazio para manter a chave atual':'gsk_…'} disabled={ocupado}/></div>
   <div className="form-group"><label><input type="checkbox" checked={reserva} onChange={e=>setReserva(e.target.checked)} disabled={ocupado}/> Autorizar Gemini como reserva</label><p className="panel-desc">Se a Groq falhar, o áudio será enviado ao Google usando a chave Gemini desta empresa e consumindo a cota correspondente.</p></div>
   {recado&&<p className="aviso aviso--erro" role="alert">{recado}</p>}
   <div className="dialogo-acoes"><button type="button" className="btn btn-secondary" disabled={ocupado} onClick={()=>{setChave('');setJanela(null);}}>Cancelar</button><button type="submit" className="btn btn-primary" disabled={ocupado}>{ocupado?'Guardando…':'Guardar configuração'}</button></div>
  </form>
 </Dialogo>}
 {janela==='remover'&&<Dialogo titulo="Remover chave da Groq" aoFechar={()=>{if(!ocupado)setJanela(null);}}><p className="dialogo-texto">A chave será removida do Ienvia, mas continuará existindo na sua conta da Groq. A reserva Gemini continuará conforme a autorização configurada.</p>{recado&&<p className="aviso aviso--erro" role="alert">{recado}</p>}<div className="dialogo-acoes"><button type="button" className="btn btn-secondary" disabled={ocupado} onClick={()=>setJanela(null)}>Cancelar</button><button type="button" className="btn btn-danger" disabled={ocupado} onClick={()=>void salvar(true)}>{ocupado?'Removendo…':'Remover chave'}</button></div></Dialogo>}
 </>;
}
