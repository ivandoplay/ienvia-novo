# Editor assistido do treinamento

## Escopo

Subaba **Editar com IA** no Treinamento, exclusiva do proprietário. Usa a chave da própria empresa e o modelo já configurado para o provedor selecionado, sem alterar o provedor do WhatsApp.

A conversa produz propostas pontuais para campos do treinamento, produtos existentes do catálogo e regras de uso dos áudios. Não cria/exclui produtos ou arquivos; não altera conexões, permissões, chaves ou modelos. Somente a aprovação explícita aplica as mudanças, em transação. O desfazer valida que não houve edição posterior nos recursos envolvidos.

## Verificações executadas antes deste commit

- 37 testes específicos aprovados: 16 do protocolo, 8 de ações com dependências simuladas e 13 SQL em PostgreSQL isolado (PGlite).
- 2 testes da página Next autenticada aprovados, desktop e celular, com serviços locais simulados. Fluxo: gerar, revisar, aprovar, conferir o editor manual atualizado, reabrir o histórico, desfazer e recarregar.
- Componente React isolado validado em 1440, 390 e 360 px, incluindo IME, conflito, histórico, texto longo, bloqueio por rascunho manual e preservação da mensagem em caso de erro.
- Build com Node 24, TypeScript da aplicação e dos testes e lint dos arquivos do editor aprovados.
- Regressão geral: **1.078 aprovados em 1.079**. A comparação com `supabase/tests/impressao-digital.remoto.json` continua divergente. A referência não foi sobrescrita para forçar aprovação.

Os testes locais não equivalem à validação da API real, do banco remoto ou do deploy.

## Dependência de banco e publicação

A migration `supabase/migrations/20261119090000_training_ai_editor.sql` acompanha o código, mas **não foi aplicada ao banco de produção durante esta entrega**.

O conector Supabase usado na validação recusou acesso ao projeto de produção com HTTP 403. É necessário restabelecer a permissão, revisar o esquema e o histórico de migrations remotos e aplicar a migration por um processo autorizado. Não utilizar outro projeto ou credencial para contornar uma recusa de acesso.

Sem as RPCs novas, o chat informa falha de carregamento; o editor manual permanece disponível. Publicar o frontend não aplica automaticamente esta migration.

Antes de considerar a funcionalidade liberada em produção:

1. Conferir o schema remoto, as migrations pendentes e a divergência da impressão digital.
2. Aplicar a migration em ambiente autorizado e validar acesso exclusivo do dono e isolamento por empresa/base.
3. Testar uma chamada real ao provedor com a chave/modelo da conta, sem aplicar propostas automaticamente.
4. Validar o build/deploy e o fluxo autenticado publicado em desktop e celular.

## Correções de regressão incluídas

- Testes alinhados ao texto existente **Retomar IA** e ao evento existente `MESSAGES_SET`.
- Constante da versão do motor alinhada ao pacote 6.2.0.
- Servidor falso de integração passou a imitar a consulta de `workspace_transcription_settings`, preservando os cenários Gemini legados quando não há linha cadastrada, sem alterar a lógica de áudio da aplicação.
- Fixture da Inbox usa uma referência temporal dentro da própria transação para manter a ordenação independente da duração total da suíte.


## Atualização de produção e robustez do protocolo

O acesso ao projeto correto foi restabelecido pelo conector. A migration do editor foi aplicada em produção e as cinco RPCs foram verificadas; as duas tabelas estão com RLS e sem SELECT direto para authenticated/anon. A leitura autenticada do dono passou.

A conta autorizou testes reais em uma base temporária, sem chip e não padrão: Gemini, OpenRouter e NVIDIA geraram, aplicaram e desfizeram edições, confirmadas após recarregar a página. A base e suas conversas temporárias foram removidas; três aplicações e três desfazimentos foram confirmados na auditoria. Nenhuma mensagem foi enviada ao WhatsApp e a base principal não foi editada.

Uma ocorrência posterior de falha de JSON no OpenRouter com a mensagem “Ola” motivou a correção do protocolo:

- Formato JSON solicitado ao transporte dos provedores apenas nas chamadas opt-in do editor. O padrão de chamadas do WhatsApp não mudou.
- Histórico do assistente serializado no mesmo protocolo, sem exemplos de respostas livres que contradizem a instrução de JSON.
- Contexto reduzido para saudações e pedidos simples de identidade; pedidos amplos preservam o contexto completo.
- Um único objeto JSON completo pode ser extraído de uma resposta com introdução/cerca Markdown. JSON incompleto ou múltiplas propostas não são completados/escolhidos automaticamente.
- Uma única nova tentativa no mesmo provedor/modelo para corrigir formato inválido, sem relaxar campos, tipos e recursos permitidos. Não há fallback automático para outro provedor nem aplicação automática.

Validações desta correção: 63 testes direcionados aprovados; regressão completa com 1.090 aprovados de 1.091 (persiste a divergência da referência remota de schema, não sobrescrita); seis chamadas reais aprovadas, sendo saudação e pedido de nome nos três provedores com o contexto real da conta. Nas saudações não foram propostas alterações. Nas chamadas diretas de reprodução não foi aplicada nenhuma proposta.
