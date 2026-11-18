export function saudeDoChip(chip:{estado:string;motor:string;executorOnline:boolean}) {
 if(chip.estado==='revoked')return {tom:'neutro',titulo:'Chip removido',descricao:'Este vínculo não está mais ativo.'};
 if(chip.motor==='baileys'&&!chip.executorOnline)return {tom:'aviso',titulo:'Motor offline',descricao:'Abra o Motor Ienvia no aparelho vinculado e confira a internet. O painel não consegue confirmar a conexão com o WhatsApp.'};
 if(chip.estado==='connected')return {tom:'ok',titulo:'Conectado',descricao:'O último estado informado indica conexão com o WhatsApp. Isso não confirma a entrega de cada mensagem.'};
 if(chip.estado==='connecting')return {tom:'neutro',titulo:'Aguardando conexão',descricao:'Conclua o pareamento no WhatsApp para liberar os envios.'};
 if(chip.estado==='error')return {tom:'aviso',titulo:'Conexão com falha',descricao:'Confira o motor ou provedor e tente reconectar. Suas conversas continuam no painel.'};
 if(chip.estado==='paused')return {tom:'neutro',titulo:'Chip pausado',descricao:'Confira a configuração deste chip antes de retomar os atendimentos.'};
 return {tom:'aviso',titulo:'WhatsApp desconectado',descricao:'Reconecte este número para voltar a enviar e receber mensagens no painel. Suas conversas continuam aqui.'};
}
