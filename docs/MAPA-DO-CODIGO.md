# Mapa do código — onde fica cada coisa e o que cada arquivo faz

> **Para quem chega agora (pessoa ou IA) e vai mexer no sistema.**
> Este arquivo responde uma pergunta só: *"onde está o arquivo que faz X, e quem chama quem?"*
> Levantado lendo o código em **16/11/2026**, no commit `14dbc9f`. Se algo aqui envelhecer, **corrija este arquivo** —
> ele é a fonte.
>
> Antes deste, leia `docs/README.md` (visão geral) e `docs/REGRAS-DA-CASA.md` (comandos, o que nunca fazer).

---

## 0. Como ler este mapa

- **`→` significa "chama"**. `inbox/page.tsx → lib/dados/inbox.ts` quer dizer que a página lê os dados por ali.
- Caminhos são relativos à raiz do repositório (`/home/user/ienvia`).
- **`(painel)` e `(plataforma)`** são grupos de rota do Next.js — os parênteses não aparecem na URL.
  `web/src/app/(painel)/inbox/page.tsx` vira `https://app.ienvia.online/inbox`.
- Quando o nome de uma função aparece, é **o nome de exportação real** do arquivo (conferido no código).

---

## 1. O sistema em uma tela

```
Navegador (painel Next.js)
   │
   │  Server Components leem o banco; Server Actions escrevem
   ▼
Supabase (Postgres + Auth + Storage)  ──────►  RPCs `*_my_*` (regra de acesso no banco)
   ▲                                                │
   │                                                │
Evolution API (chips)  ◄──── /api/webhooks/evolution
   │
   └── ou ── Motor local (na máquina do cliente) ◄──── /api/motor/*
```

**Regra de ouro da arquitetura:** o painel **não** fala com o WhatsApp direto. Ele grava a intenção no banco
(`start_my_text_message`, `schedule_my_message`, …) e um dos dois caminhos entrega: a Evolution (via webhook) ou o
motor local (que faz *polling* em `/api/motor/comandos`). Por isso quase toda ação de tela termina numa RPC, não numa
chamada HTTP externa.

---

## 2. Topo do repositório

| Caminho | O que é |
|---|---|
| `web/` | **O painel** (Next.js 16, App Router). É onde 90% do trabalho acontece. |
| `shared/` | Regras **puras** usadas pelo painel e pelo motor (sem banco, sem rede). Pacote `@ienvia/shared`. |
| `supabase/` | `migrations/` (29 arquivos `.sql`) e `tests/` (regras de banco em Postgres em memória). |
| `motor/` | O motor local (Node ESM, Baileys) que roda na máquina do cliente. Empacotado e distribuído pelo painel. |
| `landing/` | Site institucional estático → **Cloudflare Pages**. Nunca publicar pela Vercel. |
| `docs/` | Documentação. Este arquivo é um deles. |
| `scripts/` | `migrar-legado.mjs` (importação de dados antigos) e `lib/`. |
| `vitest.config.ts` | Define os 3 projetos de teste rápido: `shared`, `web`, `banco`. |
| `netlify.toml` / `render.yaml` | Planos **reserva** de hospedagem (não é o que está no ar). |
| `cloudflare/`, `laboratorio-instagram/`, `prompt-mestre/` | Trabalho à parte, não fazem parte do build do painel. |

---

## 3. O painel (`web/src`)

### 3.1 Telas — `web/src/app/(painel)/`

Cada tela segue **sempre** o mesmo desenho de três arquivos:

| Arquivo | Papel |
|---|---|
| `page.tsx` | Server Component. Lê o banco, trata erro de leitura e passa os dados adiante. **Não tem lógica de negócio.** |
| `painel-*.tsx` | Client Component (`'use client'`). A tela em si: estado, formulário, chamadas às ações. |
| `acoes.ts` | Server Actions (`'use server'`). Toda escrita passa por aqui. |

| Tela | URL | Arquivos-chave | O que faz |
|---|---|---|---|
| **Inbox** | `/inbox` | `inbox/page.tsx`, `inbox/painel-da-inbox.tsx` (**3370 linhas**, o maior arquivo do projeto), `inbox/acoes.ts` (34 ações), `conversa-topo.tsx`, `crm-visoes.tsx`, `crm-modais.tsx`, `kanban-automacao.tsx`, `janela-de-ensino.tsx` | Conversas do WhatsApp: lista, conversa, envio, etiquetas, funil, lote, lembretes, citação, busca, rascunho da IA, automação de etapa. **É a tela mais complexa — mexa com cuidado.** |
| **Visão geral** | `/visao-geral` | `visao-geral/page.tsx` → `lib/dados/visao-geral.ts` | Números do dia, funil, estado dos chips e da IA. |
| **Campanhas** | `/campanhas` | `campanhas/painel-de-campanhas.tsx` (1534 linhas), `campanhas/acoes.ts` (14) | Disparo em massa com cadência, spintax, supressão e confirmação. |
| **Chips / Instâncias** | `/instancias` | `instancias/painel-de-chips.tsx`, `instancias/acoes.ts` (7) | Adicionar chip, QR Code, conectar/desconectar, IA por chip. |
| **Conexões** | `/conexoes` | `conexoes/acoes.ts` (3) | Pareamento do **motor local** (código de 6 dígitos), renomear e revogar aparelho. |
| **Inteligência artificial** | `/inteligencia-artificial` | `inteligencia-artificial/painel-do-motor.tsx` (922), `acoes.ts` (6) | Provedores (Gemini/OpenRouter/NVIDIA), cofre de chaves, teste de conexão, modelos. |
| **Treinamento** | `/treinamento` | `treinamento/painel-de-treinamento.tsx`, `estudio-abas.tsx` (1005), `acoes.ts` (9) | Bases de conhecimento da IA, estúdio de mensagens, skills, objeções, "Cérebro Completo". |
| **Segurança** | `/seguranca` | `seguranca/painel-de-seguranca.tsx` (1159), `acoes.ts` (9) | Presets antiban, horário de funcionamento, números ignorados, fila segura, alertas. |
| **Catálogo** | `/catalogo` | `catalogo/painel-de-catalogo.tsx` (891), `acoes.ts` (4) | Itens que a IA pode oferecer, mídias do item, PIX. |
| **Áudios** | `/audios` | `audios/painel-de-audios.tsx`, `acoes.ts` (4) | Biblioteca de áudios estratégicos (transcrição automática). |
| **Simulador** | `/simulador` | `simulador/painel-do-simulador.tsx`, `acoes.ts` (2) | Conversa de teste com a própria IA, sem gastar chip. |
| **Configurações** | `/configuracoes` | `configuracoes/painel-de-configuracoes.tsx`, `acoes.ts` (4) | Marca, perfil, senha, política de dados. |
| **`[aba]`** | `/<aba>` | `(painel)/[aba]/page.tsx` | Rota coringa: telas que ainda não têm página própria dizem em que fase ficam prontas (`lib/fases.ts`). **Não é 404** — é intencional. |

Fora do grupo `(painel)`:

| Arquivo | O que faz |
|---|---|
| `app/layout.tsx` | `<html>`, fontes, `RaizDoTema`, metadados/PWA. |
| `app/page.tsx` | Redireciona para `/inbox` (ou `/login`, sem sessão). |
| `app/login/page.tsx` + `app/login/acoes.ts` | Login por usuário/senha (o usuário vira e-mail em `shared/src/auth/usuario.ts`). Ação: `entrar`. |
| `app/acoes-de-sessao.ts` | Ações globais de sessão: `sair`, `definirTema`, `selecionarWorkspaceAtivo`, `sairDoModoSuporte`. |
| `app/(painel)/layout.tsx` | A moldura: `Casca` + `MolduraDoPainel`. Protege o grupo (sem sessão → `/login`). |
| `app/(painel)/acoes-da-ia.ts` | `pausarTudo` / `retomarIa` — o botão de pânico da IA no topo. |
| `app/(plataforma)/**` | Área do **dono da plataforma** (não do cliente): `contas/painel-de-contas.tsx` (1379), `contas/acoes.ts` (12) — criar/suspender/excluir cliente SaaS, cobrança, modo suporte. |

### 3.2 Dados (leitura) — `web/src/lib/dados/`

Todos têm `import 'server-only'` e falam com o banco por RPC (`read_my_*`). **É aqui que a tela busca dados**, nunca
em `page.tsx` diretamente.

| Arquivo | Principais funções |
|---|---|
| `inbox.ts` (1148 linhas) | `carregarInbox`, `carregarConversa`, `carregarPessoas`, `carregarKanban`, `carregarCatalogosDoCrm`, `carregarDiretorioDeContatos`, `carregarAutomacoesDeEtapa`, `buscarNaConversa`, `buscarNasMensagens`, `carregarRecursosDaInbox` |
| `atendente.ts` | `carregarResumoDaIa` — estado da IA (pausada, chips ligados, o que falta). |
| `visao-geral.ts` | `carregarVisaoGeral`, `somarEtapas`, `resumirInstancias`, `ETAPAS_DO_FUNIL`. |
| `campanhas.ts` | `carregarDadosDasCampanhas`. |
| `instancias.ts` | `listarChips`, `listarExecutoresLocais`. |
| `ia.ts` | `lerMotorDeIa`. |
| `treinamento.ts` | `lerBasesDeTreinamento`, `lerBaseDeTreinamento`. |
| `recursos.ts` | `carregarDadosCatalogo`, `carregarDadosAudios`, `carregarDadosSimulador`. |
| `seguranca.ts` | `carregarDadosDeSeguranca`. |
| `configuracoes.ts` | `carregarConfiguracoes`. |
| `contas.ts` | `carregarContasSaas` (área da plataforma). |
| `motor.ts` | `carregarConexoesDoMotor`. |
| `retencao.ts` | `executarLimpezaDeRetencao` (usada pelo cron). |

### 3.3 Ação (escrita) — `web/src/app/(painel)/<tela>/acoes.ts`

`inbox/acoes.ts` (1475 linhas, 34 ações) é o mais importante do projeto. As principais:

`enviarMensagem`, `enviarArquivo`, `prepararEnvioDeArquivo`, `decidirEnvio`, `buscarArquivo`, `mudarConversa`,
`salvarContato`, `iniciarConversaManual`, `atualizarFlagsContato`, `atualizarNegocioConversa`, `ensinarIa`,
`silenciarConversa`, `transferirConversa`, `lembrarEmLote`, `pedirRascunhoDaIA`, `procurarNaConversa`,
`procurarNasMensagens`, `salvarAutomacaoDaEtapa`, `preverAutomacaoDaEtapa`, `aplicarAcaoEmLote`,
`agendarMensagem`, `editarMensagemAgendada`, `cancelarMensagemAgendada`, `enviarPixNaConversa`,
`enviarItemCatalogoNaConversa`, `enviarAudioEstrategicoNaConversa`, `salvarEtiquetaCrm`, `alternarEtiquetaContato`,
`adicionarNotaConversa`, `lerEquipe`.

> **Padrão obrigatório:** a ação valida a sessão, chama **uma** RPC, traduz o erro do Postgres em frase de tela
> (`mensagemDeErro`) e chama `revalidatePath`. Se a RPC não existe, crie a migração — não faça SQL na ação.

### 3.4 Regras de domínio — `web/src/lib/<área>/`

| Arquivo | O que decide |
|---|---|
| `inbox/regras.ts` | `VISOES`, `ABAS_DO_CRM`, `ETAPAS_DO_KANBAN` (novo → concluído), `descreverEtapaCrm`, `SITUACOES_DE_NEGOCIO`, `CORES_DE_ETIQUETA`. **Fonte dos rótulos do funil.** |
| `inbox/arquivos.ts` | Limites e tipos de mídia (`LIMITE_DE_MIDIA`, `LEGENDA_MAXIMA`, `tipoParaEnvio`). |
| `inbox/buscar-arquivo.ts` | `trazerArquivoDaMensagem` (Storage → navegador). |
| `atendente/atendente.ts` (1079) | **O cérebro do atendente de IA**: `atenderVez`, `atenderSobras`, `orcamentoDoAtendente`. |
| `atendente/regras.ts` | Montagem do histórico e do contexto: `lerHistorico`, `mensagensPendentes`, `montarConversa`, `escolherArquivo`. |
| `atendente/painel.ts` | Como a IA aparece na tela: `situacaoDaIa`, `lerIaDaConversa`, `descreverIaNaConversa`, `quandoVolta`, `explicarFalta`. |
| `atendente/rascunho.ts` | `rascunharResposta` — o "Rascunho da IA" (não envia nada). |
| `atendente/qr-pix.ts` | `gerarPngQrPix` — QR do PIX desenhado no servidor. |
| `atendente/alertas.ts` | Avisos ao dono (desconexão, campanha incerta). |
| `atendente/dossie.ts` | Dossiê para o admin. |
| `ia/estudio.ts` (1502) | **Estúdio de Mensagens / Skills / Objeções / Cérebro**: `lerCerebro`, `conferirEstudio`, `selecionarContextoDoTurno`. Código puro — roda no Next, no navegador **e no Deno**. |
| `ia/provedores.ts` (611) | `gerarResposta`, `listarModelos`, `transcreverAudio`, `testarConexao`, `ErroDeIa`. |
| `ia/cofre.ts` | `cifrar`/`decifrar` das chaves de IA (nunca em claro no banco). |
| `ia/regras.ts` | `PROVEDORES`, `NOME_DO_PROVEDOR`, eventos de alerta. |
| `ia/instrucoes.ts` | `montarInstrucoes` — o prompt final do turno. |
| `ia/ensino.ts`, `ia/treinamento.ts` | Regras do "ensinar a IA" e das bases. |
| `evolution/cliente.ts` | Cliente HTTP da Evolution API (criar instância, QR, enviar, configurar webhook). |
| `evolution/processar-aviso.ts` | Trata o que chega em `/api/webhooks/evolution`. |
| `evolution/aviso.ts` | `interpretarAviso` — dá forma ao evento cru. |
| `evolution/agendados.ts` | `processarAgendamentosVencidos`. |
| `campanhas/executor.ts` | `executarCampanhasEFilaSegura` — motor das campanhas. |
| `motor/assinatura.ts` | Assinatura Ed25519 do pacote do motor. |
| `motor/autenticacao.ts` | Pareamento por código, token de aparelho, SHA-256. |
| `motor/pacote.ts` | `gerarPacoteDoMotor` — zip do motor para o cliente. |
| `audio/*` | `gravador-de-voz.ts`, `opus.ts`, `voz-do-whatsapp.ts` — gravar e converter áudio no navegador para ogg/opus. |
| `instancias/regras.ts` | `validarApelido`, `gerarNomeNaEvolution`, `descreverEstado`, `normalizarNumeroParaPareamento`. |
| `recursos/mapeamento.ts` | `mapearItemCatalogo`, `mapearAudioEstrategico`, `mapearRecursosDoPacote`. |

### 3.5 Infraestrutura do painel — `web/src/lib/*.ts`

| Arquivo | O que faz |
|---|---|
| `env.ts` | `lerConfigSupabase`, `lerConfigEvolution`, `enderecoPublico`, `enderecoDoAviso`. **Toda variável de ambiente entra por aqui.** |
| `supabase/servidor.ts` | `criarClienteServidor` — cliente com a sessão do usuário (RPC `*_my_*`). |
| `supabase/servico.ts` | `criarClienteDeServico` — `service_role`, **só no servidor**, para Storage e webhook. |
| `supabase/deposito.ts` | `enderecoDoDepositoParaONavegador`. |
| `sessao.ts` | `obterSessao`, `rotuloDoPapel`. |
| `navegacao.ts` | **O menu inteiro**: `MENU`, `ATALHOS_CELULAR`, `rotaEstaAtiva`, `menuParaUsuario`. Menu novo só aqui. |
| `fases.ts` | `FASES`, `nomeDaFase` — o texto das telas que ainda não existem. |
| `formato.ts` | `plural`, `horaMinuto`, `saudacao` (usado em toda a UI: `3 conversas`, `14:38`). |
| `tempo.ts`, `tema.ts`, `cookies.ts`, `redirecionamento.ts` | Fuso, tema claro/escuro, cookies, `destinoSeguro` (anti open-redirect). |

### 3.6 Componentes — `web/src/components/`

| Arquivo | O que é |
|---|---|
| `casca/casca.tsx` | `Casca` — menu lateral, cabeçalho, moldura geral. |
| `casca/moldura-do-painel.tsx` | `MolduraDoPainel` — o que envolve cada tela. |
| `casca/menu-da-conta.tsx` | `MenuDaConta` — perfil, tema, sair, modo suporte. |
| `casca/controle-da-ia.tsx` | `ControleDaIa` — pausar/retomar IA no topo. |
| `casca/busca-global.tsx` | `BuscaGlobal`. |
| `tema/raiz-do-tema.tsx` | `RaizDoTema`, `useTema` — tema por `html[data-theme]`. |
| `ui/dialogo.tsx` | `Dialogo` — modal padrão (**não** trata `Esc`; feche por botão). |
| `ui/icone.tsx` | `Icone` — todos os ícones são SVG aqui (não há biblioteca de ícones). |
| `ui/campo-de-data.tsx` / `campo-de-hora.tsx` / `campo-de-texto.tsx` / `interruptor.tsx` | Campos padrão do formulário. |
| `configuracao-pendente.tsx` | `ConfiguracaoPendente` — aviso quando falta variável de ambiente. |

### 3.7 Estilos — `web/src/styles/`

Uma folha por área: `tokens.css` (**cores, espaçamentos, `--on-accent`** — tudo sai daqui), `base.css`, `componentes.css`,
`casca.css`, `inbox.css` (o maior), `campanhas-seguranca.css`, `conexoes.css`, `contas.css`, `instancias.css`,
`login.css`, `motor-de-ia.css`, `recursos.css`, `treinamento.css`, `visao-geral.css`, `apoio.css`.

> **Regra:** nada de `style={{}}` novo em JSX. Classe nova → folha da área correspondente.

---

## 4. Rotas de API — `web/src/app/api/`

| Rota | Métodos | O que faz |
|---|---|---|
| `/api/saude` | GET | `{"ok":true,"servico":"ienvia-painel"}` — prova de vida para hospedagem. |
| `/api/webhooks/evolution` | POST | **Porta de entrada dos avisos da Evolution.** Autentica pelo token do chip, grava a mensagem (`ingest_evolution_message`) e agenda o atendente. |
| `/api/inbox/versao` | GET | *"Mudou alguma coisa?"* — a Inbox aberta pergunta a cada poucos segundos e só recarrega quando muda. |
| `/api/inbox/midia/[...caminho]` | GET | Entrega um arquivo da Inbox (`/api/inbox/midia/<empresa>/<conversa>/<mensagem>/<nome>`). |
| `/api/recursos/midia/[...caminho]` | GET | Arquivos do catálogo/áudios. |
| `/api/crm/busca` | GET | Busca do CRM (usada pela busca global). |
| `/api/configuracoes/exportar` | GET | Baixa o retrato da empresa (JSON). |
| `/api/motor/pacote` | GET | Zip do motor local. |
| `/api/motor/versao` | GET | Versão + assinatura do motor (o motor pergunta se deve se atualizar). |
| `/api/motor/parear` | POST | Pareamento por código de 6 dígitos. |
| `/api/motor/parear-senha` | POST | Pareamento por e-mail/senha (o mais usado hoje). |
| `/api/motor/pulso` | POST | Batimento do motor: "estou online, versão X". |
| `/api/motor/estado` | POST | O motor informa o estado dos chips. |
| `/api/motor/eventos` | POST | O motor entrega mensagens recebidas. |
| `/api/motor/comandos` | GET/POST | O motor busca comandos pendentes (GET) e confirma execução (POST). |
| `/api/motor/midia` | GET/POST | Baixar/subir mídia pelo motor. |
| `/api/cron/agendamentos` | POST | Dispara mensagens agendadas vencidas. Protegido por `CRON_SECRET`. |
| `/api/cron/campanhas` | POST | Avança as campanhas. |
| `/api/cron/retencao` | POST | Limpeza por política de dados. |

---

## 5. Regras puras — `shared/src/`

Usado pelo painel **e** pelo motor. Sem `node:*`, sem banco, sem `window` — por isso dá para rodar em qualquer lugar.

| Arquivo | O que contém |
|---|---|
| `index.ts` | Reexporta tudo (`@ienvia/shared`). |
| `auth/usuario.ts` | `normalizarUsuario`, `usuarioParaEmail`, `iniciais` — o login é *usuário*, não e-mail. |
| `campanhas/regras.ts` | `expandirSpintax`, `extrairPlaceholders`, `descreverStatusCampanha`, cadência. |
| `campanhas/importacao.ts` | `importarDestinatariosDeTexto`, `importarDestinatariosDeXlsx`. |
| `contas/regras.ts` | `validarCriacaoDeCliente`, `validarConfiguracaoDaMarca`, `LIMITES_DE_CONTAS`. |
| `motor/regras.ts` | `VERSAO_ATUAL_DO_MOTOR`, `ehVersaoMaisNova`, `JANELA_EXECUTOR_ONLINE_MS`. **Versão do motor muda aqui E em `motor/package.json`.** |
| `motor/chave-publica.ts` | `CHAVE_PUBLICA_ATUALIZACAO_MOTOR` (par da chave privada que assina). |
| `recursos/pix.ts` | `gerarBrCodePix`, `formatarMensagemPix`, `crc16Ccitt`. |
| `recursos/regras.ts` | Limites de catálogo, áudios e mídia. |
| `seguranca/regras.ts` | `PRESETS_ANTIBAN`, `MODOS_HORARIO`, `PADRAO_SEGURANCA`, `LIMITES_SEGURANCA`. |
| `simulador/regras.ts` | `normalizarSessaoSimulador`, `avaliarMidiaSimulador`. |

---

## 6. Banco — `supabase/`

### 6.1 Migrações (`supabase/migrations/`, 29 arquivos)

Nomeadas `<AAAAMMDDhhmmss>_<nome>.sql`. **Migração aplicada não se edita** — sempre um arquivo novo.

As duas que mais importam agora:
- `20261124120000_inbox_gestao_da_conversa.sql` — `is_muted`, citação, lembretes, automação por etapa, `read_my_workspace_people`, `bulk_update_my_conversations`. É a rodada da "gestão fina" da Inbox.
- `20261123120000_openrouter_free_default.sql` — modelo padrão `openrouter/free`.

### 6.2 Tabelas (**47** em `public`)

> Contagem feita por `grep -c "create table public\."` nas migrações. Se criar tabela nova, **atualize este número**.

Agrupadas por assunto:

- **Conversa:** `conversations`, `messages`, `message_attachments`, `conversation_notes`, `scheduled_messages`, `contact_tags`, `contacts`, `contact_links`.
- **CRM:** `crm_tags`, `crm_stage_automations`, `quick_replies`.
- **IA:** `ai_agents`, `ai_agent_documents`, `ai_agent_faqs`, `ai_turns`, `workspace_ai_settings`, `workspace_ai_state`, `simulator_sessions`.
- **Chips e motor:** `instances`, `local_executors`, `local_motor_commands`, `suspension_notices`.
- **Campanhas:** `campaigns`, `campaign_recipients`, `campaign_step_deliveries`, `campaign_media_files`, `campaign_media_folders`.
- **Recursos:** `catalog_items`, `catalog_item_files`, `voice_library_items`, `workspace_pix_settings`.
- **Segurança:** `security_ignored_numbers`, `contact_consent_state`, `contact_consent_events`, `contact_erasure_requests`, `webhook_events`.
- **Empresa/plataforma:** `workspaces`, `workspace_memberships`, `workspace_invites`, `profiles`, `workspace_lifecycle_requests`, `workspace_exports`, `workspace_data_policies`, `support_sessions`.
- **Filas/infra:** `outbox_jobs`, `proactive_queue_items`, `proactive_queue_state`.

### 6.3 Funções (RPCs) — 161 em `public`

**O padrão de nome diz tudo:**

| Prefixo | Significa |
|---|---|
| `read_my_*` | Leitura da empresa da sessão (nunca recebe `workspace_id` de fora — ela descobre sozinha). |
| `save_*` / `update_my_*` / `delete_my_*` | Escrita na própria empresa. |
| `start_my_*` / `finish_*` | Envio de mensagem (texto, mídia, citação, recurso). |
| `claim_*` | Fila: um trabalhador pega o item e marca como seu (evita dois enviarem a mesma coisa). |
| `*_platform_*` / `list_platform_*` | Só o dono da plataforma (`is_my_platform_master`). |
| `ingest_*` | Entrada de mensagem vinda da Evolution ou do motor. |

As mais usadas pela Inbox: `read_my_inbox`, `read_my_conversation`, `start_my_text_message`,
`update_my_conversation_crm`, `assign_my_conversation`, `bulk_update_my_conversations`,
`search_my_conversation_messages`, `read_my_workspace_people`, `save_my_stage_automation`.

As de segurança para lembrar: `revoke all ... from anon` + grants explícitos; **toda** função nova leva isso.
Não recrie `start_my_text_message(uuid,uuid,text,text)` — a versão sobrecarregada quebra o PostgREST com `PGRST203`.

### 6.4 Testes de banco (`supabase/tests/`, 16 arquivos + `web/test-com-banco/`)

`esquema.test.ts` compara a impressão digital das migrações com `supabase/tests/impressao-digital.remoto.json`
(634 colunas, 440 restrições, 177 índices, 215 funções, 26 gatilhos, 53 políticas…). **Mexeu no banco → esse número muda → regere.**

---

## 7. Testes

| Onde | O que cobre | Como rodar |
|---|---|---|
| `shared/test/` (8) | Regras puras. | `npx vitest run --project=shared` |
| `web/test/` | Regras de tela e de servidor com dublês. | `npx vitest run --project=web` |
| `supabase/tests/` (16) | RLS, permissões, esquema, isolamento — Postgres em memória (PGlite). | `npx vitest run --project=banco` |
| `web/test-com-banco/atendente.test.ts` (35) | O atendente de ponta a ponta (código + banco + Evolution/IA falsas). | idem |
| `web/e2e/*.spec.ts` (19) | Navegador (Playwright), 2 projetos: `computador` e `celular`. | `npx playwright test` |
| `motor/test/` (2) | Atualização assinada, zip, config. | `(cd motor && npm test)` |

### 7.1 Os dublês do e2e — `web/e2e/apoio/`

**Nada do e2e toca o Supabase real.** Tudo é servido por dublês locais que escutam só durante o teste:

| Arquivo | Papel |
|---|---|
| `supabase-falso.mjs` | Banco de mentira com as tabelas e RPCs. `reiniciar-inbox` volta ao cenário inicial. |
| `crm-no-banco-falso.mjs` | As RPCs do CRM (etiquetas, funil, automação). |
| `evolution-falsa.mjs` | Evolution de mentira: registra envios em `/controle/enviadas`. |
| `ia-falsa.mjs` | Provedores de IA de mentira (`Resposta de teste para: "<última fala>"`). |
| `ia-no-banco-falso.mjs`, `recursos-simulador-no-banco-falso.mjs`, `campanhas-seguranca-no-banco-falso.mjs`, `contas-suporte-no-banco-falso.mjs` | Mesma ideia, por área. |
| `dados.mjs` | **O cenário**: `criarInbox()` devolve conversas (Ana, Bruno, Carla, Helena…), contatos `e000…`, etiquetas `d000…0101`, usuários, chips. |
| `sessao.ts` | Login programático (cookie de sessão) para o teste não passar pela tela. |
| `arquivos-de-exemplo.mjs` | PDF/foto/áudio de amostra. |

> **Sintaxe:** esses arquivos são `.mjs`, **não** aceitam sintaxe TypeScript. Rode `node --check` antes de commitar.

---

## 8. Motor local — `motor/`

Node ESM puro (sem TypeScript). Roda na máquina do cliente.

| Arquivo | O que faz |
|---|---|
| `src/index.mjs` | Ponto de entrada: laço principal, conexão Baileys, fila. |
| `src/config.mjs` | Lê a configuração do aparelho. |
| `src/sessoes.mjs` | Sessões de WhatsApp (credenciais do Baileys). |
| `src/assinatura.mjs` | Verifica a assinatura Ed25519 da atualização. |
| `src/atualizador.mjs` | Baixa e aplica atualização assinada. |
| `src/zip.mjs` | Descompacta o pacote do painel. |
| `src/pagina-local.mjs` | Página local (porta de entrada do usuário). |
| `src/chave-publica.mjs` | Chave pública embutida. |
| `scripts/setup-*.sh` / `.ps1` | Instalação em Termux, Linux, Windows. |

---

## 9. Os arquivos que você provavelmente vai precisar

| Quero… | Vá para |
|---|---|
| Mudar um texto/rótulo da tela | o `painel-*.tsx` **daquela** tela (ex.: `web/src/app/(painel)/seguranca/painel-de-seguranca.tsx`) |
| Mudar o rótulo de uma etapa do funil | `web/src/lib/inbox/regras.ts` (`ETAPAS_DO_KANBAN`) |
| Mudar uma cor | `web/src/styles/tokens.css` |
| Adicionar item no menu | `web/src/lib/navegacao.ts` |
| Adicionar uma ação da Inbox | `web/src/app/(painel)/inbox/acoes.ts` + RPC nova em migração |
| Mudar o que a IA responde | `web/src/lib/atendente/atendente.ts` e `web/src/lib/ia/instrucoes.ts` |
| Ver por que a IA não respondeu | `web/src/lib/atendente/painel.ts` (`explicarFalta`, `situacaoDaIa`) |
| Mudar o envio de WhatsApp | `web/src/lib/evolution/cliente.ts` (Evolution) ou `motor/src/index.mjs` (motor) |
| Adicionar uma rota de API | `web/src/app/api/<nome>/route.ts` |
| Rodar um teste só (comando, não arquivo) | `npx vitest run -t "nome do teste"` ou `npx playwright test -g "nome"` |

---

## 10. Armadilhas que já custaram um dia

1. **`(painel)/inbox/painel-da-inbox.tsx` tem 3370 linhas.** Editar com `edit_file` em trecho pequeno, nunca reescrever.
2. **`import 'server-only'`** em `lib/dados/*` — se você importar isso num Client Component, o build quebra.
3. **`shared/` não pode importar `node:*`** nem `next/*`. Se precisar, o lugar é `web/src/lib/`.
4. **Migração aplicada no Supabase não se edita** — e o banco publicado é a fonte da verdade. Já se perdeu uma rodada
   inteira de trabalho por ter ficado só no banco, fora do Git (`docs/INBOX-GESTAO-RECONSTRUCAO-24-11.md`).
5. **`.git/config` não sobrevive** entre sessões do sandbox — o `git remote` volta vazio; reconfigure com o token.
6. **Node precisa ser 24.x.** Com Node 20 o Vitest nem imprime o relatório.
7. **`npm test` roda da raiz.** Rodar `npx vitest` dentro de `web/` pega os specs do Playwright e dá 47 falhas falsas.
8. **No celular (`pointer: coarse`) Enter quebra linha — não envia.** Nos testes, clique em `Enviar`.
9. **No celular a lista não fica na tela com uma conversa aberta.** Localize pelo link `^Nome`; volte por
   "Voltar para a lista de conversas".
10. **`.linha-check` e `.inbox-titulo-contador` são invisíveis para `getByRole`** quando a lista está com `display:none`
    (celular) — use seletor de classe nesses casos.

---

## 11. Estado em 16/11/2026 (para calibrar expectativa)

| Frente | Situação |
|---|---|
| `npm test` (rápido) | **1037 testes, 54 arquivos, verde** |
| `--project=banco` | **375 verdes** (inclui os 35 do `test-com-banco`) |
| e2e `inbox-gestao` + `crm` + `inbox` | **141 passed, 11 skipped, 0 failed** (computador + celular) |
| `next build`, `tsc`, `eslint .` | limpos |
| Deploy | Vercel `app.ienvia.online` e Netlify `superb-tapioca-aaf330` no commit `14dbc9f` |

**O que ainda não está coberto:** os 11 casos skipped do e2e (cenários que os dublês não montam), conversão de áudio
real no navegador, e o pareamento por senha só é provado em produção (o banco em memória não reproduz o
`service_role`).
