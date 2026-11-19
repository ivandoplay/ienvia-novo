# Motor 6.2.1 — prioridade para entradas novas

## Causa e escopo
No Linux do usuário, o diagnóstico encontrou 11.316 arquivos pendentes: 11.272 históricos e 44 vivos. As seis mensagens reais do teste estavam preservadas como vivas, com LID e alternativa telefônica. A versão 6.2.0 misturava tudo em lotes ordenados por hash, no loop de comandos/heartbeat.

## Correção
- Classificação em memória de arquivos legados, sem mover/apagar/migrar a fila.
- Cursores independentes para mensagens vivas e histórico. Depois do primeiro scan, novas gravações atualizam o índice sem reler todos os JSONs por lote.
- Dois processadores independentes, consultados a cada 500 ms: lote de até dez entradas vivas e lote de até duas históricas. Rede do histórico não bloqueia mensagens vivas nem o polling de comandos/heartbeat.
- Um lote em voo por canal; falhas mantêm arquivos e avançam o cursor, permitindo progresso dos demais.
- Encerramento para de aceitar trabalho e aguarda as tarefas em voo antes de fechar as sessões. Arquivos só são confirmados após accepted/duplicate/ignored, como antes.
- Arquivos ilegíveis ficam preservados no disco e não bloqueiam o scan. Precisam de diagnóstico separado; não entram nas contagens classificadas.
- A política de classificação dos eventos notify/append e o envio de recibos não foram alterados nesta correção. Mídia e resolução de identidade ainda podem adicionar latência dentro de cada canal. Não se promete tempo máximo de entrega.

## Testes
17 testes Node aprovados, incluindo seis novos: fila legada com 11.272 históricas e 44 novas, persistência após reinício, duplicação da chave, cursores independentes, arquivo ilegível, histórico com rede bloqueada enquanto seis entradas LID/telefone são processadas, preservação após falha de rede, exclusão apenas após confirmação, limite de concorrência e parada dos processadores.

Testes usam arquivos temporários e rede simulada; nenhum WhatsApp é enviado por eles. O sucesso do teste no Linux real depende de aplicar a versão 6.2.1 e repetir a verificação das seis mensagens no banco. Não afirmar que o computador já está atualizado sem verificar.

## Instalação
Preferir atualização assinada pelo painel, que preserva data, node_modules, .runtime e .env. Não abrir uma instalação nova vazia: atualizar a pasta existente. O instalador pontual fornecido separadamente também verifica o motor parado, cria backup do código e não altera a pasta data nem dependências.
