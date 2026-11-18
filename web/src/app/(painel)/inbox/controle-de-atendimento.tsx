'use client';
import {Icone} from '@/components/ui/icone';
import {controleAtendimento} from '@/lib/inbox/controle-atendimento';
export function ControleDeAtendimento({faixa,ocupado,aoAgir}:{faixa:{podeAssumir:boolean;podeDevolver:boolean}|null;ocupado:string|null;aoAgir:(acao:'assumir'|'devolver')=>void}){
 const controle=controleAtendimento(faixa);
 if(!controle)return null;
 return <button type="button" className="btn btn-secondary btn-sm inbox-acao-extra" disabled={ocupado!==null} onClick={()=>aoAgir(controle.acao)}><Icone nome={controle.acao==='assumir'?'pessoa':'kpiIa'} className="icon-15"/><span>{ocupado===controle.acao?controle.ocupado:controle.rotulo}</span></button>;
}
