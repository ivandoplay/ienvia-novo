# Correção geral de dossiês e confirmações — Motor 6.2.2

## Diagnóstico real
O dossiê foi executado pelo motor local, não pela Evolution. A Evolution recebeu uma cópia/eco porque o número estava conectado aos dois provedores. O comando local tinha ID de WhatsApp e status succeeded, mas não havia confirmação de entrega. Seu destinatário usava o formato brasileiro com nono dígito, enquanto as respostas da conversa, confirmadas como lidas na cópia Evolution, usavam o JID sem esse dígito. Isso identifica um defeito no caminho de resolução de destinatário; não prova, isoladamente, a causa final da não entrega ao aparelho.

## Correções genéricas, sem IDs de contas
1. Texto e mídia do motor local consultam `onWhatsApp` antes do envio e usam o JID canônico retornado. Exigem telefone equivalente ao solicitado; não aceitam outra pessoa ou uma resposta ambígua. Para Brasil, a equivalência cobre o nono dígito. Não tentam telefones alternativos às cegas. Cache restrito ao socket, TTL de cinco minutos e limite de mil entradas.
2. Consulta sem resposta, timeout, destinatário inexistente/ambíguo ou inválido impede o envio. Não marca como enviado. Falha depois de iniciar o envio é incerta e não provoca tentativa em outro chip.
3. `messages.update` e `message-receipt.update` passam a alimentar uma fila durável de confirmações em `data/fila-recibos`, processada independentemente do histórico. Falha de rede e recibo recebido antes da conclusão do comando são retentados sem reenviar a mensagem. Confirmações não associadas expiram após 24 horas para não acumular indefinidamente.
4. A API encaminha a autenticação e atualização para uma única RPC transacional. Ela exige token, workspace, executor e instância correspondentes e só aceita IDs de mensagens produzidos por comandos de envio desse mesmo aparelho/chip.
5. Recibos atualizam mensagens normais e também os dossiês administrativos que não têm `message_id`. No registro de dossiês, `delivered_at` e `read_at` comprovam as confirmações recebidas; status sent continua significando envio, nunca prova de entrega. Recibos fora de ordem não fazem leitura/entrega regredir para falha.
6. Quando existe chip preferido, alertas/dossiês não escolhem outro silenciosamente se ele estiver indisponível. A exceção deliberada é alerta de chip desconectado, que precisa de outro caminho conectado. A seleção continua dentro da empresa e do executor correto.
7. Versões do pacote e do catálogo compartilhado sincronizadas em 6.2.2.

## Validação
- 22 testes do motor (incluem fila prioritária, resolução de JID, nono dígito, cache por socket, número estrangeiro, ausência/ambiguidade/timeout, envio local do dossiê, não reenvio em falha incerta, recibos e retomada).
- 14 testes de banco selecionados, incluindo ciclo de vida do motor, segurança/campanhas e cinco novos de roteamento/recibos. Dois workspaces independentes testados; testes não dependem da conta real.
- 705 testes unitários web/shared, incluindo três novos da API de recibos.
- TypeScript aplicação/testes e lint da rota alterada.

Os testes usam rede simulada para envios WhatsApp e arquivos temporários. O teste real final de entrega do dossiê exige o aparelho do usuário executando a 6.2.2. Não reenviei automaticamente o dossiê anterior, cujo resultado de entrega é desconhecido. Não removi pausas ou ampliei a IA para outros contatos.

## Publicação e limites
A proteção de rota e a RPC são publicadas no backend; a resolução e captura de recibos dependem de atualizar cada motor local para 6.2.2 ou superior. Contas novas recebem as mesmas regras, não uma exceção por e-mail/telefone.

Nenhum software pode garantir ausência absoluta de falhas externas do WhatsApp, rede ou aparelho. A proteção aqui é detectar e registrar corretamente o estado, evitar destino errado/troca de chip silenciosa/reenvio incerto e manter testes de regressão.

Esta entrega não implementa ainda a fila de múltiplos destinatários administrativos com intervalo de 10–15 segundos, que é outro pedido pendente. Não altera a implementação de envio da Evolution que já funcionava.
