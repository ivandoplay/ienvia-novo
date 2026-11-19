# Pedido autorizado: múltiplos números administrativos e intervalo aleatório

Não fazer commit, publicação, migração em produção ou envio real até nova ordem do usuário.

Comportamento solicitado: vários números administrativos; mínimo/máximo em segundos; primeiro destinatário sem atraso artificial e cada seguinte aguardando novo sorteio uniforme inclusivo entre mínimo e máximo, por exemplo 10–15s. Não disparar todos juntos. Ordem da lista preservada e duplicados normalizados removidos. Manter configuração de um número existente compatível. A mudança é no Motor de IA; não reformular suas demais opções.

## Achados do código (implementação ainda pendente)
- `ConfiguracaoDoMotor.alertaAdminWhatsapp` e workspace_ai_settings aceitam só um número.
- Caminho Evolution em `atendente.ts` envia diretamente com orçamento restante curto. NÃO inserir sleep nesse fluxo.
- Caminho local e alertas gerais usam `enqueue_workspace_admin_alert`, que lê também security_settings_json. Evitar alterar destinos/eventos da tela Segurança sem decisão explícita.
- A deduplicação do banco é UNIQUE(turn_id, kind), incompatível com uma entrega por destinatário. Precisa preservar deduplicação por evento + destinatário sem quebrar as cláusulas ON CONFLICT das RPCs legadas.
- Cron atual não garante execução a cada segundo. Uma fila apenas com due_at consultada a cada minuto não entrega o intervalo de 10–15s solicitado. Definir executor contínuo/worker com agendamento persistente e testar precisão, ou declarar intervalo mínimo sujeito à latência; não prometer precisão sem infraestrutura.
- O próximo destino deve ser liberado após término/confirmação do envio anterior + atraso sorteado, não apenas horários cumulativos desde o enqueue. Tratar uncertain sem reenviar cegamente, reinícios, deduplicação e concorrência de workers.

## Critérios de entrega
Persistência validada owner/workspace, compatibilidade com configuração atual, UI números + mínimo/máximo, validação mínimo<=máximo e limites razoáveis, fila durável, Evolution e motor local, testes de falhas/concorrência/ordem/intervalos/isolamento. Não enviar WhatsApp real nos testes sem confirmação.

## Revisão de scroll já local
Casca global: restringir rolagem externa do documento apenas no painel, min-height:0 nos filhos flex e contenção da área principal. Treinamento: retirar scroll automático da troca de aba e limitar auto-scroll da resposta ao contêiner da conversa. Simulador já foi ajustado em pedido anterior. Validação em navegador das rotas principais em desktop/mobile sendo executada. Nada publicado.

## Atualização de autorização
O usuário autorizou o commit das alterações pendentes de frontend. Esta funcionalidade segue pendente de implementação e não é ativada pelo commit; este documento apenas registra o pedido. Nenhuma limpeza de conversas ou envio administrativo é executado nesta entrega.
