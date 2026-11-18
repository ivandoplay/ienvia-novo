import {saudeDoChip} from '@/lib/instancias/saude';
export function SaudeDoChip({chip}:{chip:{estado:string;motor:string;executorOnline:boolean}}){
 const s=saudeDoChip(chip);
 return <div className={`chip-saude chip-saude--${s.tom}`} role={s.tom==='aviso'?'status':undefined}><span className="chip-saude-ponto" aria-hidden="true"/><div><strong>{s.titulo}</strong><p>{s.descricao}</p></div></div>;
}
