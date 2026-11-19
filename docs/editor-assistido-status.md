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
