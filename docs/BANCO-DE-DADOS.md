# Banco de dados — mapa, regras e como mudar com segurança

> Projeto Supabase **`IENVIA-001`** (`rhcabqlwazvjcjjdknsc`), Postgres **17.11**, região `sa-east-1` (São Paulo).
> Números conferidos em 12/11/2026. Toda mudança passa por `supabase/migrations/`.

## 1. Como o banco está montado

| Schema | Para quê | Tamanho hoje |
|---|---|---|
| `public` | tudo o que o app usa; **toda tabela tem RLS ligada** (46 tabelas, 52 políticas) | 46 tabelas |
| `private` | segredos e filas que nem o usuário logado enxerga (8 tabelas) | — |
| `auth`, `storage` | do próprio Supabase (login e arquivos) | — |

`private` guarda: `audit_events`, `platform_admins`, `local_executor_tokens` (tokens do motor),
`workspace_ai_secrets` (chaves de IA cifradas), `evolution_webhook_auth`, `workspace_realtime_channels`,
`admin_alert_deliveries`, `workspace_admin_meta`.

## 2. Tabelas por área (46 em `public`)

| Área | Tabelas |
|---|---|
| **Contas** | `workspaces`, `workspace_memberships`, `profiles`, `workspace_invites`, `support_sessions`, `workspace_lifecycle_requests`, `workspace_admin_meta`* |
| **Chips** | `instances`, `local_executors`, `local_motor_commands`, `suspension_notices`, `security_ignored_numbers` |
| **Conversa** | `contacts`, `conversations`, `messages` (+29 partições `messages_AAAA_MM_DD`), `message_attachments`, `conversation_notes`, `contact_tags`, `crm_tags`, `contact_links`, `contact_consent_state`, `contact_consent_events`, `contact_erasure_requests` |
| **Envio** | `outbox_jobs`, `scheduled_messages`, `proactive_queue_items`, `proactive_queue_state` |
| **IA** | `ai_agents`, `ai_agent_faqs`, `ai_agent_documents`, `ai_turns`, `workspace_ai_settings`, `workspace_ai_state` |
| **Campanhas** | `campaigns`, `campaign_recipients`, `campaign_step_deliveries`, `campaign_media_folders`, `campaign_media_files` |
| **Recursos** | `catalog_items`, `catalog_item_files`, `voice_library_items`, `quick_replies`, `simulator_sessions`, `workspace_pix_settings` |
| **Infra** | `webhook_events`, `workspace_exports`, `workspace_data_policies`, `admin_alert_deliveries`* |

\* em `private`.

**`messages` é particionada por dia** (`messages_2026_11_13`, …). Ao criar migração que altere `messages`, lembre:
`alter table` na tabela-mãe propaga para as partições; **índice** precisa ser criado na mãe também.

## 3. Funções (RPCs) — 159 em `public`

Convenção de nome, que já diz quem pode chamar:

| Prefixo | Significado | Exemplo |
|---|---|---|
| `my_` | age sobre o workspace de quem está logado, confere `auth.uid()` | `create_my_campaign`, `rename_my_local_executor` |
| `platform_` | só o master da plataforma | `platform_delete_workspace`, `list_platform_...` |
| `apply_` / `authenticate_` | webhook/edge (usa service_role, não tem sessão) | `apply_evolution_connection_update` |
| `claim_`, `complete_`, `begin_` | filas e tarefas (o motor e o cron chamam) | `claim_local_motor_commands`, `claim_ai_turn` |
| sem prefixo | utilitário do próprio banco | `pair_local_executor_by_code` |

**Regra de ouro:** função que confere dono usa `auth.uid()` e **precisa ser chamada com o token do usuário**. Com
`service_role`, `auth.uid()` é `null` e ela recusa (`42501 Workspace owner required`). Isso já causou um bug real
em 12/11 na rota `POST /api/motor/parear-senha`.

Toda função `security definer` deve ter `set search_path = ''` — há teste que verifica isso.

## 4. Como aplicar uma mudança no banco

```bash
# 1. criar a migração com timestamp maior que a última
ls supabase/migrations | tail -3
# ex.: 20261122120000_local_motor_password_pairing.sql

# 2. rodar os testes (montam um Postgres em memória com TODAS as migrações)
node -v            # 24
npm run test:db

# 3. aplicar no banco real (via API de gerenciamento, token em /home/user/.env)
#    SUPABASE_ACCESS_TOKEN → POST https://api.supabase.com/v1/projects/<ref>/database/query
#    (é o caminho usado aqui; `supabase db push` também serve se o CLI estiver logado)

# 4. registrar no histórico do Supabase (senão o histórico mente)
insert into supabase_migrations.schema_migrations(version, name) values ('2026...', 'nome');

# 5. REGERAR O RETRATO (obrigatório) — rode supabase/tests/impressao-digital.sql no banco real
#    e salve o resultado como { "categorias": { ... } } em supabase/tests/impressao-digital.remoto.json

# 6. conferir
npm run test:db     # esquema.test.ts compara Git x banco real
```

**Se `esquema.test.ts` falhar:** leia a diferença. `funcoes: itens 204 → 206` = alguém aplicou função sem regerar o
retrato. `permissoes_funcao` mudou = permissão de RPC mudou sem migração. Nunca "conserte" editando o retrato sem
entender — foi assim que o teste virou um detetive útil.

## 5. Segurança (o que já está provado por teste)

- `supabase/tests/isolamento.test.ts` — uma empresa **nunca** lê dados da outra (38 testes).
- `supabase/tests/permissoes.test.ts` — o navegador não faz o que é trabalho do servidor (14 testes).
- `supabase/tests/esquema.test.ts` — RLS ligada em tudo; `anon` não executa nenhuma função; schema `private`
  inacessível a usuário logado; `security definer` com `search_path` travado.
- `supabase/tests/impressao-digital.remoto.json` — o retrato do banco real (11 categorias com md5).
- Chaves de IA são cifradas em `private.workspace_ai_secrets` com `IENVIA_CHAVE_DOS_SEGREDOS` (AES-GCM).
  Sem essa variável, o painel não guarda nem usa chave de IA.

## 6. Dados de hoje (para calibrar)

20 MB no total (limite do plano grátis: 500 MB): 577 mensagens, 547 eventos de webhook, 91 anexos, 24 contatos,
24 conversas, 4 chips, 3 empresas/3 vínculos, 1 aparelho local. **Backup:** `walg_enabled: true`,
`pitr_enabled: false`, lista de backups vazia → **não há restauração para ponto no tempo** no plano atual.

## 7. Funções do motor local (as mais novas)

| Função | Quem chama | O que faz |
|---|---|---|
| `create_my_local_executor_pairing(workspace, nome, code_sha256)` | painel (dono) | cria aparelho `pending_pair` + código válido 15 min |
| `pair_local_executor_by_code(code_sha256, token_sha256, plataforma, versão, metadata)` | motor | troca o código por `device_token` (uso único) |
| `pair_local_executor_by_password(workspace, nome, token_sha256)` | rota do painel **com token do usuário** | cria aparelho já `active`; teto de 20/24h; auditoria |
| `list_my_owner_workspaces()` | rota do painel | `[{id,name}]` das empresas em que a pessoa é dona |
| `authenticate_local_executor_heartbeat` | motor (pulso 25 s) | valida token, atualiza `last_seen_at` |
| `claim_local_motor_commands` / `complete_local_motor_command` | motor | fila de comandos (`connect_qr`, `connect_code`, `send_text`…) |

Detalhes do fluxo do motor: `MOTOR-E-INTEGRACOES.md`.
