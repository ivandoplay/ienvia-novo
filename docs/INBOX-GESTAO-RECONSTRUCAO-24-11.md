# Inbox: o que se perdeu e o que foi reconstruído (24/11/2026)

## O que aconteceu

A rodada das **15 ideias da Inbox** (silenciar, transferir, buscar dentro das mensagens, lembretes,
citar, rascunho da IA, editar agendada, automação de etapa…) foi feita **direto no banco publicado e
no workspace**, e nunca chegou ao Git: no `origin/main` (commit `ace001b`, de 14/11) não existe a
migração `20261124_*`, nem `is_muted`, nem `read_my_workspace_people`.

Quando o workspace foi reiniciado, sumiram:

- as 6 migrações `20261124_*` (aplicadas no Supabase, mas fora do Git);
- o painel da Inbox com as ideias (`painel-da-inbox.tsx` no disco e no GitHub é o de 16/11, **sem**
  "Silenciar", "Transferir", "Lembretes", "Rascunho da IA", "Responder citando");
- `web/e2e/inbox-gestao.spec.ts` e `web/e2e/apoio/inbox-gestao.ts` (46 testes de ponta a ponta);
- `docs/INBOX-IDEIAS-16-11.md` e `docs/TESTES-FALTANDO-INBOX-16-11.md`.

## O banco foi recuperado (fonte da verdade)

O banco publicado **tem** tudo. Dele saíram, um a um, `pg_get_functiondef`, as colunas, restrições,
índices, políticas e permissões. O resultado está versionado em:

- `supabase/migrations/20261123120000_openrouter_free_default.sql` (recuperada do stash);
- `supabase/migrations/20261124120000_inbox_gestao_da_conversa.sql` (reconstruída do banco).

Conferência: `supabase/tests/esquema.test.ts` compara a impressão digital das migrações com
`supabase/tests/impressao-digital.remoto.json`, que passou a ser gerado **rodando o SQL no banco
publicado** (Management API) em vez de copiado à mão. As 11 categorias batem.

## Duas correções de segurança feitas no banco publicado

1. As 9 funções novas tinham `EXECUTE` para **anon** (visitante sem login). Fechado:
   `revoke ... from anon, public`.
2. `crm_stage_automations` nasceu com a tabela inteira aberta para anon. Fechado: só `SELECT` para
   `authenticated`/`service_role`, e o resto como o Supabase entrega (a RLS não tem política de escrita).

## Problema aberto: `start_my_text_message` tem duas versões

O banco publicado tem `start_my_text_message(uuid,uuid,text,text)` **e**
`start_my_text_message(uuid,uuid,text,text,uuid)`. Chamada pelo PostgREST (com parâmetros nomeados),
sem `p_reply_to_message_id`, o Postgres responde `PGRST203`: *Could not choose the best candidate*.
Ou seja: **com o painel atual (que não manda a citação) o envio de texto falha**. Decisão pendente:
ou se remove a versão de 4 argumentos, ou o painel passa a mandar `p_reply_to_message_id: null`.
