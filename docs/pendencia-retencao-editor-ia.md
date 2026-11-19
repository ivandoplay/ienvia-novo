# Próxima entrega — retenção do editor IA

Pedido confirmado pelo usuário: manter somente as DUAS conversas completas mais recentes POR BASE de treinamento na lista Conversas. Não se trata de limitar a duas mensagens por conversa. As conversas antigas devem ser apagadas automaticamente, com suas mensagens/propostas, sem desfazer alterações já aplicadas ao treinamento.

Publicação: NÃO fazer commit agora. Incluir implementação e testes no próximo commit/entrega. Não executar limpeza em produção neste momento.

Critérios de implementação:
- Ordenação determinística por última atividade e ID; escopo workspace + base.
- Remover excedentes existentes quando a regra entrar em vigor e manter o limite nas novas conversas.
- Exclusão das conversas remove a possibilidade de consultar/desfazer propostas dessas conversas; comunicar isso na interface.
- Preservar treinamento, catálogo, áudios e auditoria já aplicados. Não enviar mensagens ao WhatsApp.
- Preservar autorização owner/RLS e limites de uso: o contador atual usa training_ai_turns; excluir conversas não pode permitir burlar rate limit. Projetar contador independente antes da limpeza.
- Tratar concorrência e gerações em andamento para não apagar uma resposta ativa inadvertidamente.
- Testar isolamento de bases/workspaces, retenção de duas conversas, cascata de mensagens, persistência de edições já aplicadas e limites de uso.

Estado: regra registrada; implementação, migration, testes e ativação ainda pendentes para a próxima entrega. Nenhum histórico excluído.

## Atualização de autorização
O usuário autorizou o commit das alterações pendentes de frontend. Esta funcionalidade segue pendente de implementação e não é ativada pelo commit; este documento apenas registra o pedido. Nenhuma limpeza de conversas ou envio administrativo é executado nesta entrega.
