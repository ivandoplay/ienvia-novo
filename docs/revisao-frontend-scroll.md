# Revisão incremental de frontend e rolagem

## Alterações incluídas
- Estrutura compartilhada do painel delimita os elementos posicionados, impede vazamento de altura para o documento externo e mantém a rolagem na área de conteúdo. Páginas de login fora do painel não são afetadas.
- Inbox desktop usa duas colunas; ficha do contato em diálogo sob demanda, busca recolhível, altura flexível dentro da janela e campo de mensagem acessível. O celular conserva seu fluxo próprio. Busca de mensagem move apenas o histórico, não a página inteira.
- Treinamento evita saltos ao trocar abas e a resposta do editor rola apenas dentro da conversa.
- Biblioteca de áudios com filtros/cartões/editor responsivos e textos de transcrição Groq. A reserva configurada é preservada.
- Simulador permite seleção local de provedor ou automático, sem alterar o WhatsApp; arquivos de áudio são transcritos pelo serviço configurado antes da resposta. Chat usa a rolagem da página, sem altura vazia ou scrollIntoView automático.

## Evidências
- 14 testes Playwright aprovados em desktop/mobile, incluindo rotas principais, conversa, diálogos, treinamento, editor IA, áudio e simulador. Auditoria da rolagem mede altura/largura externas, movimento do documento e acesso ao final do conteúdo.
- 702 testes unitários web/shared aprovados; TypeScript de produção/testes e ESLint dos arquivos alterados aprovados.
- Conversa real autorizada de Jefferson Ivan aberta localmente em 1366x768, 1440x900, 1024x768 e 390x844: campo acessível, nenhuma rolagem horizontal, altura externa igual à janela em todos os quatro casos. Em 1366x768 histórico passou de 119x386 para 366x738 (altura x largura). Nenhuma mensagem real enviada.
- Teste de envio por Enter, quebra com Shift+Enter, ficha e busca aprovados em serviços simulados.
- A tentativa de regressão completa com banco não ficou verde: divergência já existente da referência de schema e falha de fetch em um teste de concorrência do atendente. Não foram alteradas regras do banco nem enfraquecidos testes para contornar esses resultados.
- Tentativa adicional de visitar todas as páginas com dados reais localmente foi interrompida por timeout de compilação/navegação. Não é contada como auditoria real completa; a matriz integral de rotas foi validada no ambiente E2E.

## Não incluído como funcionalidade concluída
Retenção de duas conversas do editor e múltiplos números administrativos com intervalos permanecem pedidos pendentes, documentados separadamente. Não há migração de banco ou envio administrativo nesta entrega. Migration local de escopo de IA da Evolution é preexistente e não pertence a este ajuste de frontend; não é publicada aqui.
