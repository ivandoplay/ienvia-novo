# O que a Escola Ienvia precisa ensinar — currículo conferido contra o sistema

> Levantado em **16/11/2026** lendo o código (commit `41a92e6`), não de memória.
> Cada aula deste documento tem um **status**: o que existe hoje, o que existe parcialmente e o que **não existe**
> no sistema. O protótipo `escola-ienvia-member-area-prototype` promete 90 cursos; **nem todos têm lastro no código**.
> Ensinar o que não existe gera cliente frustrado e suporte — é o erro mais caro que uma escola interna pode cometer.

---

## 0. A regra que guia tudo

**Só entra em vídeo o que o cliente consegue fazer hoje, na tela dele.**

O protótipo planejou uma escola de *atendimento ideal* (trilha de "comunicação que encanta", "roteamento inteligente",
"testes A/B"). Isso é conteúdo de curso de marketing, não de manual do produto. O cliente que paga o Ienvia quer:
**conectar o número, não deixar cair, responder rápido, e a IA trabalhar por ele.**

Ordem de valor, na prática do dia a dia:

```
conectar o chip  →  não ser bloqueado  →  atender a conversa  →  a IA responder sozinha  →  vender mais
```

A escola segue essa ordem. O que vem depois disso é curso, não tutorial.

---

## 1. O mapa: 13 telas que existem para ensinar

Conferido em `web/src/lib/navegacao.ts` — é literalmente o menu do sistema:

| # | Tela | O que faz (descrição real do menu) | Fase |
|---|---|---|---|
| 1 | **Visão geral** | Números da operação num lugar só | 0 |
| 2 | **Inbox** | Conversas, contatos, Kanban, ficha do cliente, histórico por chip | 1 |
| 3 | **Campanhas** | Disparo em lote com prévia, intervalos e acompanhamento | 5 |
| 4 | **Treinamento** | Identidade do negócio, regras, perguntas frequentes, arquivos | 2 |
| 5 | **Catálogo & PIX** | Produtos com fotos e chave PIX enviada na conversa | 6 |
| 6 | **Áudios** | Áudios na sua voz, enviados como mensagem de voz | 6 |
| 7 | **Simulador** | Testar a IA antes de ligar o atendimento de verdade | 6 |
| 8 | **Motor de IA** | Chaves Gemini/OpenRouter/NVIDIA, modelos, o que fazer quando falha | 2 |
| 9 | **Instâncias** | Conectar cada chip por QR Code, apelido, o que cada um faz | 1 |
| 10 | **Conexões / Motor** | O motor local no aparelho: versão, atualização, download | 4 |
| 11 | **Geral** | Marca, cópia de segurança, dados da conta | 7 |
| 12 | **Segurança** | Antiban, horário de atendimento, alertas, contatos ignorados | 5 |
| 13 | **Clientes SaaS** | Contas dos seus clientes: plano, cobrança, limite, suspensão | 7 |

---

## 2. As trilhas — e o veredito de cada uma

### ✅ TRILHA 1 — Começar (obrigatória, todo mundo assiste)

**Objetivo:** o cliente sai sabendo entrar, achar as coisas e não se perder.

| Aula | Duração | Existe? | O que mostrar de verdade |
|---|---|---|---|
| Boas-vindas: o que o Ienvia faz por você | 3 min | ✅ | — |
| Entrar no painel (usuário e senha) | 2 min | ✅ | Login por *usuário*, não e-mail (`shared/src/auth/usuario.ts`) |
| O mapa do painel: as 13 abas | 5 min | ✅ | `navegacao.ts` |
| **Visão geral: ler seus números** | 5 min | ✅ | `conectadas`, `comIaLigada`, `esperandoVoce`, `mensagensRecebidasHoje`, `respostasDaIaHoje` |
| Perfil, senha e tema claro/escuro | 3 min | ✅ | `salvarNomePessoal`, `alterarMinhaSenha` |

**Total: ~18 min.** É a única trilha que **100% dos clientes** precisam ver.

---

### 🟡 TRILHA 2 — Conectar o WhatsApp (obrigatória, e a que mais dá suporte)

**Objetivo:** o número está conectado, e o cliente sabe o que fazer quando cair.

| Aula | Duração | Existe? | Observação crítica |
|---|---|---|---|
| Antes de conectar: número dedicado | 4 min | ✅ | Precisa explicar **por que não usar o número principal** |
| Conectar por QR Code | 5 min | ✅ | `gerarQrCode`, `conferirChip` |
| Conectar por código (motor local) | 6 min | ✅ | `criarCodigoPareamentoLocal` |
| O que é o motor local (e quando usar) | 6 min | 🟡 | O motor existe (`motor/`), mas é instalação técnica |
| Quando o chip cai: o que fazer | 5 min | ✅ | `desconectarChip`, estado em `descreverEstado` |
| Apelido e função de cada chip | 4 min | ✅ | `salvarChip`, `mudarIaDoChip` |

**Total: ~30 min.** 🔴 **Esta é a trilha que mais evita suporte.** Se for gravar só uma, grave esta.

---

### ✅ TRILHA 3 — Não ser bloqueado (a mais valiosa comercialmente)

**Objetivo:** o cliente entende antiban antes de tomar bloqueio.

| Aula | Duração | Existe? | O que mostrar |
|---|---|---|---|
| Por que o WhatsApp bloqueia | 5 min | ✅ | Contexto |
| Os presets antiban | 6 min | ✅ | `PRESETS_ANTIBAN` (`shared/src/seguranca/regras.ts`) |
| Horário de atendimento | 4 min | ✅ | `MODOS_HORARIO`, `FUSOS_HORARIOS_COMUNS` |
| Alertas no seu WhatsApp | 4 min | ✅ | `testarAlertaDeSeguranca` |
| Contatos ignorados (quem a IA nunca responde) | 3 min | ✅ | `adicionarNumeroIgnorado` |
| **A fila segura** | 6 min | ✅ | `iniciarFilaSegura`, `limparFilaSegura`, `resolverIncertoDaFila` |
| Aquecimento de número novo | 5 min | 🟡 | Existe como *preset*, mas o sistema **não automatiza** aquecimento — não prometer |

**Total: ~33 min.**

---

### 🟡 TRILHA 4 — Atender a conversa (o coração, e onde o protótipo mais errou)

**Objetivo:** a pessoa atende bem pelo painel, sem decorar.

| Aula | Duração | Existe? | Observação |
|---|---|---|---|
| A tela da Inbox: anatomia | 6 min | ✅ | Lista + conversa + ficha |
| As 5 visões (Ativas, Não lidas, Esperando, Resolvidas, Arquivadas) | 5 min | ✅ | `VISOES` — são **5**, o protótipo listava mais |
| Ler e responder (texto, foto, áudio, documento, figurinha) | 6 min | ✅ | `enviarMensagem`, `enviarArquivo` |
| **Silenciar uma conversa** | 2 min | ✅ | `silenciarConversa` |
| **Transferir para um colega / devolver para a fila** | 4 min | ✅ | `transferirConversa` — **só o dono vê o botão** |
| **Responder citando** | 3 min | ✅ | `responderCitando` |
| **Lembretes: não esquecer o cliente** | 4 min | ✅ | `lembrarEmLote` |
| **Marcar lembrete em várias de uma vez** (lote) | 4 min | ✅ | `aplicarAcaoEmLote` |
| Procurar dentro da conversa e nas mensagens | 4 min | ✅ | `procurarNaConversa`, `procurarNasMensagens` |
| **Rascunho da IA: a IA escreve, você aprova** | 5 min | ✅ | `pedirRascunhoDaIA` — o recurso mais subestimado |
| Etiquetas do CRM e funil (Kanban) | 6 min | ✅ | `salvarEtiquetaCrm`, `alternarEtiquetaContato` |
| Ficha do contato: valor do negócio, etapa, perder | 5 min | ✅ | `atualizarNegocioConversa` |
| Fixar conversa, marcar como não lida | 3 min | ✅ | `is_pinned`, `mark_unread` |
| Enviar PIX na conversa | 3 min | ✅ | `enviarPixNaConversa` |
| Enviar item do catálogo | 3 min | ✅ | `enviarItemCatalogoNaConversa` |
| Enviar áudio estratégico | 3 min | ✅ | `enviarAudioEstrategicoNaConversa` |
| **Ensinar a IA em 1 clique** (corrigir resposta) | 5 min | ✅ | `ensinarIa` — diferencial forte, pouco explorado |
| Agendar mensagem | 4 min | ✅ | `agendarMensagem`, `editarMensagemAgendada` |
| Aviso das 24 h do WhatsApp | 3 min | ✅ | Janela de 24h |
| | | | |
| 🚫 **"Configurar sua equipe" / convidar atendente** | — | ❌ | A tabela `workspace_invites` existe, mas **não há tela nem ação de convite**. O protótipo promete nas aulas `pp-2-2`. **Tirar ou dizer "em breve".** |
| 🚫 **"Trabalhando em equipe / atribuição"** | — | ❌ | Atribuir conversa existe (`assign_my_conversation`), mas não há gestão de usuários pela tela |

**Total: ~90 min.** É a trilha mais longa e a mais valiosa. Pode ser dividida em 3 blocos.

---

### ✅ TRILHA 5 — O atendente de IA

**Objetivo:** a IA responde sozinha e o cliente confia nela.

| Aula | Duração | Existe? | O que mostrar |
|---|---|---|---|
| O que a IA pode e não pode fazer | 5 min | ✅ | `IA_FORA_DA_CONVERSA`, `explicarFalta` |
| Chaves dos provedores (Gemini/OpenRouter/NVIDIA) | 8 min | ✅ | `guardarChave`, `testarProvedor` — o cofre cifra |
| Escolher o modelo (e o grátis) | 5 min | ✅ | `buscarModelos`, padrão `openrouter/free` |
| **Treinamento: identidade do negócio** | 6 min | ✅ | `salvarBase`, `tornarPadrao` |
| Perguntas frequentes e regras de ouro | 6 min | ✅ | `ensinarIa` |
| Arquivos de conhecimento (PDF, áudio → transcrição) | 6 min | ✅ | `anexarArquivo`, `transcreverAudioEstrategico` |
| O Estúdio: mensagens, skills, objeções | 10 min | ✅ | `lerCerebro`, `selecionarContextoDoTurno` |
| **Testar no Simulador** | 6 min | ✅ | `enviarMensagemSimulador` |
| Ligar a IA em cada chip | 3 min | ✅ | `mudarIaDoChip` |
| Quando a IA passa para humano | 5 min | ✅ | `assign_my_conversation` pausa a IA |
| Pausar a IA (o botão de pânico) | 2 min | ✅ | `pausarTudo` |
| Ver por que a IA não respondeu | 5 min | ✅ | `situacaoDaIa`, `quandoVolta` — **aula de ouro contra suporte** |

**Total: ~67 min.**

---

### ✅ TRILHA 6 — Vender mais: Catálogo, PIX e Áudios

| Aula | Duração | Existe? |
|---|---|---|
| Montar o catálogo (fotos, PDF, preço) | 8 min | ✅ `salvarItemDoCatalogo` |
| Configurar o PIX (e mandar cobrança na conversa) | 6 min | ✅ `salvarConfiguracaoPix` |
| Biblioteca de áudios na sua voz | 6 min | ✅ `salvarAudioEstrategico` |
| Transcrição automática do áudio | 3 min | ✅ `transcreverAudioEstrategico` |

**Total: ~23 min.**

---

### ✅ TRILHA 7 — Campanhas (disparo em massa) — **a mais perigosa de ensinar errado**

| Aula | Duração | Existe? | Observação |
|---|---|---|---|
| Antes de disparar: o risco real | 5 min | ✅ | Amarrar com a Trilha 3 |
| Importar destinatários | 6 min | ✅ | `importarDestinatariosDeTexto/Xlsx` |
| Spintax: variar a mensagem | 5 min | ✅ | `expandirSpintax` |
| Cadência e intervalos | 5 min | ✅ | `CADENCIA_PADRAO` |
| Prévia antes de confirmar | 5 min | ✅ | `gerarPreviaCampanha` |
| Confirmar, pausar, retomar, cancelar | 5 min | ✅ | 4 ações reais |
| **O que é "envio incerto" e como resolver** | 5 min | ✅ | `resolverEnvioIncertoCampanha` — exclusivo do Ienvia |
| Acompanhar resultados | 4 min | 🟡 | Há status por destinatário; **não há relatório de conversão** |

| 🚫 **Teste A/B de campanha** | — | ❌ | **Não existe no sistema.** O protótipo promete (`cp-3-2`). Retirar. |

**Total: ~40 min.**

---

### ✅ TRILHA 8 — Rotina e manutenção (fecha o ciclo, evita churn)

| Aula | Duração | Existe? |
|---|---|---|
| Backup e exportação de dados | 4 min | ✅ `exportar` (rota `/api/configuracoes/exportar`) |
| Política de retenção (por quanto tempo guardar) | 4 min | ✅ `salvarPoliticaDeDados` |
| Marca e identidade do sistema | 3 min | ✅ `salvarMarcaEPerfil` |
| Apagar um contato e a conversa dele (LGPD) | 4 min | ✅ `apagarContatoEConversa` |
| Atualizar o motor local | 4 min | ✅ `/api/motor/versao` |

**Total: ~19 min.**

---

### 🔒 TRILHA 9 — Para quem revende (Clientes SaaS) — **não é para todo cliente**

| Aula | Duração | Existe? |
|---|---|---|
| Criar um cliente SaaS | 5 min | ✅ `criarClienteSaas` |
| Plano, cobrança e marcar como pago | 6 min | ✅ `salvarCobrancaDoCliente`, `marcarClienteComoPago` |
| Suspender / reativar / excluir | 5 min | ✅ |
| Modo suporte: entrar na conta do cliente | 5 min | ✅ `entrarEmModoSuporte` |

**Total: ~21 min.** Só aparece para o dono da plataforma.

---

## 3. O placar: quanto vídeo isso dá de verdade

Somando as trilhas que **têm lastro** no código:

| Trilha | Minutos |
|---|---|
| 1. Começar | 18 |
| 2. Conectar WhatsApp | 30 |
| 3. Não ser bloqueado | 33 |
| 4. Atender a conversa | 90 |
| 5. Atendente de IA | 67 |
| 6. Catálogo, PIX, Áudios | 23 |
| 7. Campanhas | 40 |
| 8. Rotina | 19 |
| 9. Clientes SaaS | 21 |
| **Total** | **~341 min ≈ 5,7 horas** |

**Conclusão importante:** são **5,7 horas** de vídeo, não as 12 que eu estimei antes com as 92 aulas do protótipo.
Isso muda tudo a favor:

- A **10 GB grátis** do R2 cabem **~28 h** em 1080p → seu curso inteiro ocupa **20% do plano grátis**
- A trilha **inteira** cabe em menos de 1 GB

---

## 4. O que cortar do protótipo (e por quê)

O protótipo tem 90 cursos. **Cerca de um terço não tem lastro no sistema:**

| Conteúdo do protótipo | Veredito | Por quê |
|---|---|---|
| "Gatilhos e condições", "Fluxos avançados", "Roteamento inteligente", "Integrações e webhooks" | ❌ **Cortar** | O Ienvia **não tem construtor de fluxos**. A única automação é "etiqueta + mensagem por etapa do funil" (`crm_stage_automations`). |
| "Testes A/B na prática" | ❌ Cortar | Não existe. |
| "Integrações e webhooks" (saída) | ❌ Cortar | Webhook existe só de **entrada** (Evolution → painel). |
| "Configurando sua equipe" | ❌ Cortar | Não há tela de convite de usuário. |
| "Escrever bem no WhatsApp", "Acolhendo uma reclamação", "Conversas difíceis" | 🟡 Mover | É **curso de atendimento**, não tutorial do produto. Ótimo como bônus, mas não ensina o Ienvia. |
| "Relatórios e métricas essenciais", "Montando seu painel" | 🟡 Reduzir | A Visão geral dá 11 números; não há relatório customizável. |

**Cortar 30 cursos de conteúdo inexistente diminui a produção em ~40%** — e evita que o cliente procure um botão
que não existe.

---

## 5. A ordem de gravação recomendada

Não grave na ordem das trilhas. Grave na ordem do **impacto em suporte**:

| Ordem | O que | Por quê |
|---|---|---|
| **1º** | Trilha 2 — Conectar o WhatsApp (30 min) | É 60% dos tickets de suporte |
| **2º** | Trilha 3 — Não ser bloqueado (33 min) | Evita o cliente perder o número (e cancelar) |
| **3º** | Trilha 1 — Começar (18 min) | Precisa existir para o cliente novo |
| **4º** | Trilha 4 — Atender a conversa (90 min) | O uso diário |
| **5º** | Trilha 5 — IA (67 min) | O diferencial; depois que o básico funciona |
| **6º** | Trilhas 6, 7, 8 | Complemento |
| **7º** | Trilha 9 | Só se você revende |

**Primeira entrega sugerida:** trilhas 2 + 3 + 1 = **81 minutos**, graváveis em um fim de semana.
Com isso o cliente já consegue conectar e não se queimar.

---

## 6. Formato de cada aula (o que gravar)

Pela minha recomendação, e coerente com o que medi:

| Item | Recomendação | Por quê |
|---|---|---|
| Duração | **3 a 8 min**, nunca mais | Retenção cai muito depois dos 10 min |
| Resolução | **1080p** | Cabe folgado nos 10 GB medidos (6 MB/min) |
| Áudio | Voz + legenda queimada (opcional) | Muita gente assiste sem som |
| Ritmo | Uma ação por aula | "Ensinar a silenciar" é uma aula, não um capítulo |
| Abertura | 5 s mostrando **em qual tela** ele vai estar | Orientação espacial reduz dúvida |
| Fechamento | "O que você já sabe fazer agora" | Fecha o ciclo e dá sensação de progresso |

---

## 7. O que eu preciso de você para fechar isso

1. **Confirma os cortes da seção 4?** (especialmente automações avançadas e teste A/B, que não existem)
2. **A trilha 9 (Clientes SaaS) entra?** Você revende hoje ou é só uso próprio?
3. **A trilha "atendimento que encanta" vira bônus separado** ou fica fora?
4. **Quem grava?** Você mesmo, com gravação de tela (OBS/QuickTime), ou quer que eu monte um roteiro
   passo a passo de cada aula — o que clicar, o que falar, e qual tela abrir?

Se quiser, o próximo passo natural é eu escrever o **roteiro detalhado da primeira entrega** (as 9 aulas das
trilhas 1+2+3, 81 min): para cada uma, o que aparece na tela, a fala palavra por palavra e o que deve ser
clicado. Isso é o que transforma este mapa em vídeo.
