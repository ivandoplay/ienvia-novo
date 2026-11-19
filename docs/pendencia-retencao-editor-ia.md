# Retenção do editor IA — implementada

Regra confirmada pelo usuário: somente as duas conversas completas mais recentes por base. As anteriores são apagadas com suas mensagens/propostas; mudanças já aplicadas ao treinamento não são revertidas. As duas preservadas mantêm o mecanismo de desfazer, sujeito às verificações de conflito já existentes.

## Implementação
- A leitura do histórico limpa o excedente legado da base acessada. A criação de nova conversa limpa o excedente na mesma transação do primeiro pedido.
- Ordenação por última atividade, criação e ID para desempate determinístico.
- Geração ativa candidata à remoção bloqueia a operação de limpeza/nova conversa, em vez de apagar seu contexto. Gerações interrompidas há mais de dois minutos seguem a expiração já usada pelo editor.
- Lock por workspace serializa criação/limpeza entre abas concorrentes.
- Registro privado e mínimo de solicitações (ID, empresa, instante; sem mensagens ou propostas) preserva os limites de uso e impede repetir um pedido cujo chat já foi apagado.
- UI informa a retenção e trata uma conversa que desapareceu quando outra aba criou uma mais recente.
- Acesso continua restrito ao proprietário; tabelas privadas sem leitura direta por authenticated/anon.

## Validação
21 testes de banco aprovados (oito novos de retenção e treze existentes do editor). Cobrem cascata, preservação das edições, desfazer na penúltima conversa, isolamento entre bases/empresas, geração ativa, dados legados, limites e idempotência. Outros 33 testes de ações/protocolo aprovados. TypeScript produção/testes e lint dos fontes alterados aprovados.

A ativação na conta autorizada preserva as duas conversas mais recentes e confere hashes completos de suas mensagens/propostas e do treinamento antes/depois. Não exige chamadas aos provedores nem envio de WhatsApp.
