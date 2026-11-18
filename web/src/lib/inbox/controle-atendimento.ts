/** Retomar tem prioridade numa pausa temporária: a interface sempre oferece uma só ação. */
export function controleAtendimento(faixa:{podeAssumir:boolean;podeDevolver:boolean}|null){
 if(faixa?.podeDevolver)return {acao:'devolver',rotulo:'Retomar IA',ocupado:'Retomando…'} as const;
 if(faixa?.podeAssumir)return {acao:'assumir',rotulo:'Assumir',ocupado:'Assumindo…'} as const;
 return null;
}
