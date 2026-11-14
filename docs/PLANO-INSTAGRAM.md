# Instagram no Ienvia: como funcionaria (análise técnica e plano)

> Pergunta: "além do WhatsApp, funcionar no Instagram — tem como? como eu faço?"
> Resposta curta: **tem como, é oficial (API da Meta), mas não é o mesmo caminho do WhatsApp.** O WhatsApp você conecta sem pedir licença a ninguém (Evolution + QR Code). O Instagram exige **app aprovado pela Meta** antes de atender o primeiro cliente.
> Verificado em 12/11/2026 contra o código do repositório e a documentação pública da Meta.

---

## 1. A boa notícia: seu banco já nasceu multi-canal

Isto já existe em `supabase/migrations/20261109122635_0001_core.sql`:

```sql
create table public.instances (
  channel text not null check (channel in ('whatsapp','instagram')),
  engine  text not null check (engine  in ('evolution','baileys','meta')),
  ...
  check ((channel = 'whatsapp' and engine in ('evolution','baileys'))
      or (channel = 'instagram' and engine = 'meta'))
);

create table public.contacts (
  channel text not null check (channel in ('whatsapp','instagram','manual')),
  external_user_id text,   -- no Instagram, é o IGSID
  ...
);
```

Ou seja: quem desenhou isso já previu Instagram com motor `meta`. **Não é uma reescrita do sistema** — é preencher a segunda metade de uma estrutura que já está lá.

O que falta, na prática: **não existe nenhum código de Instagram hoje.** Uma busca por "instagram" no projeto retorna só essas 3 linhas de migration. Não há cliente da API, webhook, tela de conexão nem nada.

---

## 2. Como o Instagram funciona (e onde ele bate de frente com o WhatsApp)

### 2.1 O caminho oficial: Instagram Messaging API

Dois jeitos de autenticar:

| | **Instagram API with Instagram Login** | **Instagram API with Facebook Login** |
|---|---|---|
| Tela de login | Do Instagram | Do Facebook, escolhendo a Página |
| Permissão de mensagem | `instagram_business_manage_messages` | `instagram_manage_messages` + `pages_manage_metadata` |
| Token | token do usuário IG, longo (60 dias, renovável) | token da Página, derivado do usuário FB |
| Precisa de Página do Facebook? | **Não** | Sim |
| Envio | `POST graph.instagram.com/{ig-user-id}/messages` | `POST /{page-id}/messages` |
| Bom para | conta própria / ferramenta enxuta | agência que já vive no Business Suite |

Para o seu caso (cliente conecta a conta dele e a IA atende), o caminho mais enxuto é **Instagram Login**.

### 2.2 As regras que mudam o produto (não são detalhe, são o desenho)

1. **Só conta profissional** (Business ou Creator). Conta pessoal não tem API.
2. **Só responde quem falou primeiro.** Não existe DM frio. Nem com permissão, nem com pagamento.
3. **Janela de 24 horas.** A partir da última mensagem do cliente, você tem 24h para responder. Cada nova mensagem dele reinicia o relógio. Passou disso: erro `10 / 2534022` ("sent outside allowed window").
4. **HUMAN_AGENT estende para 7 dias — mas só para humano.** A tag existe para pessoa de verdade responder caso de suporte. **A IA usando essa tag é violação** e a Meta audita: é uma das formas mais rápidas de perder o acesso.
5. **Comentário → DM: 1 resposta por comentário, em até 7 dias.** É o "comenta EU QUERO que eu te chamo no direct". Vale 1 vez por comentário, sempre.
6. **Precisa avisar que é automático.** Divulgação de automação é exigência da Meta e um dos motivos mais comuns de reprovação no App Review.
7. **Responder rápido:** a Meta trabalha com a expectativa de resposta em até 30 segundos para entrada de usuário.

### 2.3 Limites técnicos (para dimensionar, não para decorar)

| O quê | Limite |
|---|---|
| Envio de texto/link | 100 chamadas por segundo por conta profissional |
| Envio de áudio/vídeo | 10 por segundo |
| Ler conversas (Conversations API) | 2 por segundo |
| Resposta privada a comentário | 750 por hora |
| Tamanho do texto | 1.000 bytes UTF-8 (não é 1.000 caracteres — emoji e acento contam mais) |
| Imagem | png/jpeg, 8 MB, até 10 por mensagem |
| Áudio | aac, m4a, wav, mp4 — 25 MB |
| Vídeo | mp4, ogg, avi, mov, webm — 25 MB |
| Arquivo | pdf, 25 MB |
| Volume total da conta | acima de ~72.000 mensagens enviadas+recebidas a caixa para de funcionar até baixar |

Observação importante: os "200 DMs por hora" que se lê por aí **não são da Meta** — é o ritmo que as ferramentas se impõem para não parecer spam. O limite publicado é por segundo.

---

## 3. O que isso muda no SEU produto

### 3.1 O que já serve sem mexer
- **O treinamento inteiro** (identidade, regras, FAQs, skills, humanização, objeções, playbook). É texto que vira prompt — independente de canal.
- **O motor de IA** (Gemini/OpenRouter/NVIDIA, ordem de uso, chaves no cofre).
- **A quebra de mensagens em balões** que acabamos de fazer.
- **O CRM**: contatos, conversas, estágios do Kanban, ficha do cliente.
- **O repasse para humano** (`[[CHAMAR_HUMANO]]`) — no Instagram vira "conversa em modo manual".

### 3.2 O que precisa de camada nova

| Peça | O que muda |
|---|---|
| **Conexão** | em vez de QR Code: botão "Conectar Instagram" → OAuth da Meta → guardar token cifrado (o cofre já existe: `web/src/lib/ia/cofre.ts`) |
| **Webhook** | nova porta de entrada (`/api/webhooks/meta`) com **verificação de assinatura** (`X-Hub-Signature-256`) e resposta ao desafio `hub.challenge` |
| **Entrada de mensagem** | `ingest_evolution_message` é específico da Evolution. Precisa de um `ingest_meta_message` (ou generalizar o existente) gravando `source_engine = 'meta'` e `provider_message_id` = `mid` da Meta |
| **Envio** | `enviarTexto`/`enviarArquivo` são da Evolution. Precisa de um cliente Meta com **fila e recuo** (o `outbox_jobs` já existe) |
| **Janela de 24h** | campo novo: `last_inbound_at` na conversa + bloqueio na hora de enviar, com erro claro |
| **Formatação** | Instagram **não** usa `*negrito*` igual ao WhatsApp; suporta negrito/itálico próprios e **não aceita botão de lista** livre. O texto precisa de um formatador por canal |
| **Balões** | o Instagram aceita até 3 mensagens seguidas sem problema, mas o "digitando…" e o tempo entre balões são diferentes — e a Meta pune rajada (o teto por thread é baixo) |
| **Regra de áudio** | áudio no Instagram é anexo comum (não é PTT como no WhatsApp). O `[[ENVIAR_AUDIO]]` precisa virar "envia arquivo de áudio" |
| **Telas** | Instâncias (conectar IG), Inbox (ícone do canal, responder dentro da janela), treinamento (nada muda) |
| **Recibos** | Instagram tem `read`/`delivered` por webhook — dá para manter o mesmo padrão de status |

### 3.3 O que simplesmente não existe no Instagram (e você precisa prometer ao cliente)
- **Disparo em massa / campanha.** A aba Campanhas é WhatsApp-only. No Instagram, mandar para quem não falou = ban.
- **Follow-up depois de 24h pela IA.** Só humano, e só até 7 dias.
- **Lista de transmissão.**
- **Qualquer coisa parecida com o que os "bots de Instagram" vendem por aí** (aqueles que logam com senha e mandam DM em lista) — isso quebra os Termos da Meta e derruba a conta.

---

## 4. O que você precisa fazer FORA do código (o caminho crítico)

Isto é o que costuma travar o projeto, não a programação:

1. **Conta profissional** — o Instagram do cliente precisa ser Business ou Creator.
2. **App no Meta for Developers** — criar, adicionar o produto Instagram.
3. **Verificação de negócio (Business Verification)** — CNPJ/documentos da sua empresa. Sem isso, você fica em *Standard Access* (só atende contas que você mesmo administra).
4. **App Review das permissões**, uma por uma:
   - `instagram_business_basic` (ler perfil)
   - `instagram_business_manage_messages` (ler e enviar DM) ← **a mais escrutinada**
   - `instagram_business_manage_comments` (se quiser comentário → DM)
5. **Política de privacidade + termos publicados** com o uso de dados do Instagram. (Você já tem `privacidade.html` e `termos.html` na landing — precisa acrescentar a seção Instagram.)
6. **Vídeo/roteiro de demonstração** mostrando a automação funcionando e a divulgação de que é automático.
7. **Webhook verificado** (HTTPS, com assinatura) — precisa do seu domínio no ar antes de submeter.
8. **Revisão periódica:** token de 60 dias precisa ser renovado; se ficar parado, cai.

> Tradução honesta: **o App Review é o gargalo.** Programar o conector é uma a três semanas; a aprovação da Meta pode levar de dias a algumas semanas e depende de documentos da empresa, não de código.

---

## 5. Um caminho intermediário que talvez te sirva antes

Se o objetivo é **atender o Instagram de um cliente específico logo**, sem esperar App Review, dá para fazer com um **provedor intermediário** (ex.: Chatwoot, 360dialog, Take Blip, ou um gateway de DM que já tem app aprovado). Você continua com o cérebro no Ienvia e delega o pedágio da Meta.

- **Prós:** funciona em dias, sem App Review seu.
- **Contras:** custo por mensagem/assinatura, você depende de terceiro, e o cliente fica com dois fornecedores. Também limita o white-label.

Recomendação: **usar intermediário para validar** (1 ou 2 clientes reais, medir taxa de resposta no Instagram) e **submeter o App Review em paralelo**, já que a aprovação é o item de prazo mais longo. Quando aprovar, desliga o intermediário.

---

## 6. Plano por fases (o que eu faria, na ordem)

### Fase 0 — Decisão e documentação (1 dia)
- Definir: Instagram Login (mais enxuto) ou Facebook Login (se o cliente vive no Business Suite).
- Escrever a seção "Instagram" na política de privacidade e nos termos.
- Abrir o app na Meta e iniciar a verificação de negócio **na hora** (é o que demora).

### Fase 1 — Fundação no código, sem falar com a Meta (3 a 5 dias)
- Migration: `last_inbound_at` em `conversations`, `channel` já existe; tabela/coluna para token do canal cifrado; `capabilities` por canal (o que cada canal suporta: campanha? áudio PTT? botões?).
- Interface `CanalDeMensagem` com duas implementações: `WhatsAppEvolution` e `InstagramMeta` (receber, enviar texto, enviar arquivo, marcar lido).
- `formatarTextoParaCanal()`: `*negrito*` no WhatsApp, formatação equivalente no Instagram.
- Testes com dublê da API — dá para fazer tudo isso **sem** aprovação, porque não depende de conta real.

### Fase 2 — Conector real em modo Standard Access (3 a 5 dias)
- OAuth do Instagram Login, token cifrado no cofre, renovação.
- Webhook `/api/webhooks/meta` com assinatura + desafio.
- `ingest_meta_message` gravando IGSID como `external_user_id`, `mid` como `provider_message_id` (o índice de deduplicação que já existe serve).
- Envio com fila (`outbox_jobs`) e controle da janela de 24h.
- **Aqui você já consegue testar de verdade**, porque em Standard Access dá para atender contas que você administra — inclusive a sua.

### Fase 3 — Telas (2 a 3 dias)
- Instâncias: cartão do Instagram com "Conectar", estado (conectado/expirado), botão renovar.
- Inbox: ícone do canal na conversa, faixa "janela fecha em Xh", bloqueio de envio fora da janela com explicação.
- Motor de IA: interruptores por canal (ex.: dividir em balões ligado no WhatsApp, mais conservador no Instagram).

### Fase 4 — Diferenciais que o Instagram permite (2 a 4 dias)
- Comentário → DM (palavra-chave). É o maior ganho comercial no Instagram, e tem regra clara: 1 por comentário, em 7 dias.
- Story reply tratado como mensagem (abre a janela de 24h).
- Detectar pergunta "você é um robô?" e responder com a divulgação de automação já configurada no treinamento (`robot_question_policy`).

### Fase 5 — App Review e escala (prazo da Meta)
- Submeter as permissões com o vídeo de demonstração.
- Ao aprovar: abrir para contas de clientes (Advanced Access).

**Estimativa total de código:** 2 a 3 semanas de trabalho técnico. **Prazo do App Review:** variável, fora do seu controle.

---

## 7. Decisões que valem pensar antes de começar

1. **Um número de Instagram por workspace ou vários?** O banco aceita vários (`instances`). Começar com um simplifica a tela e o suporte.
2. **Campanhas: o que a tela mostra quando o canal é Instagram?** Sugiro esconder a aba para essas instâncias, com aviso "campanha não existe no Instagram — e tentar isso derruba a conta".
3. **A IA pode usar áudio no Instagram?** Áudio no IG é anexo, não mensagem de voz. Talvez valha deixar desligado no começo.
4. **Quem cuida do token expirado?** Se o cliente desconectar o Instagram, o atendimento para em silêncio. Precisa de alerta no painel e no WhatsApp administrativo (o `alertaAdminAtivo` já existe).
5. **Preço/plano:** Instagram custa seu tempo de App Review e de suporte; talvez seja um add-on, não parte do plano base.
6. **Compliance como diferencial:** no Instagram, quem respeita a janela e a divulgação de automação sobrevive; quem não respeita perde a conta do cliente. Escrever isso no produto ajuda a vender.

---

## 8. Resumo em cinco linhas

1. **Tem como, e é oficial** — Instagram Messaging API, via app aprovado pela Meta.
2. **Seu banco já está preparado** (`channel`, `engine`, `external_user_id`); falta o código do conector.
3. **As regras mudam o produto**: sem disparo em massa, janela de 24h, só responde quem falou primeiro, obrigação de avisar que é automático.
4. **O gargalo é burocrático**: verificação de negócio + App Review das permissões, com CNPJ e política de privacidade.
5. **Caminho recomendado**: conector em Standard Access (testável na sua própria conta) + intermediário para validar rápido + App Review rodando em paralelo.

---

## 9. Como o ManyChat faz (e o que isso ensina para o Ienvia)

> Referência trazida pelo dono. Verificado em 12/11/2026: ManyChat é **Meta Business Partner / Tech
> Provider**, usa a API oficial e cobra por *contatos ativos*.

### 9.1 A cadeia de uma DM dentro do ManyChat

1. **Uma vez, na empresa ManyChat:** eles criaram o app na Meta, passaram por **Business Verification** e
   **App Review** das permissões de mensagem. Isso já está pronto há anos.
2. **Na sua conta:** você clica em *Conectar Instagram* → tela da Meta → autoriza. Você nunca digita a
   senha do Instagram no ManyChat. O que fica salvo é um **token** (por conta conectada).
3. **Cliente manda DM** → a Meta entrega no webhook do ManyChat → o ManyChat cria/atualiza o contato e
   dispara o **fluxo** (gatilho por palavra-chave, resposta de story, comentário, etc.).
4. **O fluxo roda no servidor deles** (canvas): mensagens, condições, captura de dados, "AI Step".
5. **Resposta volta pela API da Meta**, dentro da janela de 24h. Passou de 24h, o ManyChat recusa e
   manda para o inbox humano (ou oferece o tag HUMAN_AGENT quando o plano/ação permite).

**A parte que importa:** o cliente do ManyChat não faz papelada nenhuma. Quem carrega a aprovação é o
ManyChat. É exatamente esse "pedágio já pago" que ele vende.

### 9.2 Como ele cobra (modelo 2026)

O preço não é por mensagem nem por conta: é por **contato ativo** — uma pessoa real com quem você trocou
mensagem no mês. Um comentário que vira DM já conta como contato ativo.

| Plano | Anual (mês) | Mensal | Contatos ativos | Canais | IA | Inbox compartilhado |
|---|---|---|---|---|---|---|
| Free | $0 | $0 | 25 | 2 | não | não |
| Essential | $14 | $17 | 250 | 2 | não | não |
| Pro | $29 | $39 | 2.500 | 3 | sim | não |
| Business | $69 | $99 | 7.500 | todos | sim | sim |
| Advanced | $139 | $199 | 25.000 | todos | sim | sim |

Excedente por contato: $0,10 (Essential) até $0,004 (Advanced). Um Reel que viraliza pode levar de $29
para $130+ no mesmo mês. Essa é a crítica constante ao modelo.

### 9.3 O que o ManyChat é e o que ele NÃO é

**É:** excelente construtor de fluxo por palavra-chave, com comentário → DM impecável, biblioteca de
modelos, conexão oficial e barata para começar. Milhões de contas usam.

**Não é:** um cérebro de atendimento. O "caminho feliz" dele é o que você desenhou no canvas; se o
cliente sair do roteiro, ele não lê logística, não interpreta objeção, não tem playbook, não tem matriz
de objeções nem memória do jeito de falar do dono. A IA ali é um **passo** dentro do fluxo, não o
atendente. É por isso que o seu produto (treinamento + humanização + marcações de repasse) continua
tendo lugar mesmo com ManyChat existindo.

### 9.4 A descoberta útil: ManyChat aceita chamar um cérebro externo

O ManyChat tem a ação **External Request**: dentro do fluxo, ele faz `POST` para uma URL sua, passa
variáveis (`{{last_user_message_text}}`, nome, etc.) e **espera a resposta** para usar como conteúdo da
mensagem. É assim que as integrações com n8n/Make/Relevance AI funcionam.

Traduzindo para o Ienvia: dá para usar o ManyChat **como a porta aprovada da Meta** e o Ienvia como o
cérebro, sem App Review nenhum. O Ienvia recebe a mensagem, roda o treinamento e devolve o texto.

O que essa rota custa:
- o cliente precisa de ManyChat **Pro** ($29/mês) — dois fornecedores na conta do cliente;
- a chamada é **síncrona**: o Ienvia tem que responder em poucos segundos (timeout do External Request),
  então nada de processos longos; e quem divide em balões passa a ser o ManyChat (o Ienvia devolve o
  texto ou o fluxo manda várias mensagens em sequência);
- a janela de 24h continua valendo (é da Meta, não do ManyChat);
- sem white-label: o cliente vê ManyChat.

### 9.5 Os três caminhos, comparados

| | **A. App próprio na Meta** | **B. ManyChat como porta + Ienvia como cérebro** | **C. Intermediário com API de parceiro** (Chatwoot, 360dialog, Blip) |
|---|---|---|---|
| Prazo para o 1º cliente | 3 a 6 semanas (App Review) | **2 a 5 dias** | 1 a 3 semanas |
| Papelada | toda sua (CNPJ + review) | nenhuma | média (contrato com o parceiro) |
| Custo para o cliente | só o Ienvia | Ienvia + ManyChat Pro | Ienvia + parceiro |
| White-label | **sim** | não | depende |
| Controle do produto | total | limitado pelo fluxo do ManyChat | médio |
| Risco de bloqueio | baixo (API oficial) | baixo | baixo |
| Esforço de engenharia | alto (conector completo) | **baixo** (uma rota HTTP) | médio |

### 9.6 O que eu faria no seu lugar

1. **Agora:** seguir o caminho **A** no que não depende da Meta (migration, interface de canal, webhook).
   É o que constrói o produto de verdade e não tem prazo de terceiro.
2. **Em paralelo:** abrir a verificação de negócio — é o item de prazo mais longo e não custa nada começar.
3. **Se aparecer cliente pagante querendo Instagram antes da aprovação:** ligar o caminho **B** para ele
   (ManyChat Pro + External Request apontando para uma rota do Ienvia). O cliente paga $29 e você entrega
   em dias. Quando o App Review sair, migra esse cliente para a conexão própria e corta o custo.
4. **Nunca** o caminho dos "bots de Instagram" que logam com senha: derruba a conta do cliente e o seu CNPJ.

Resumo da diferença: **o ManyChat vende acesso já aprovado + fluxo visual; o Ienvia vende o cérebro que
atende.** Um não substitui o outro — e o ManyChat pode ser o atalho para o Ienvia chegar no Instagram antes
da aprovação da Meta.

---

## 10. Fase 5 em detalhe: App Review e Advanced Access

> Verificado em 12/11/2026. Regra de ouro: **a Fase 5 não é uma etapa de programação — é uma
> candidatura.** Você entrega evidência, a Meta julga. Programar já acabou.

### 10.1 O portão: dois selos, nesta ordem (errar a ordem = rejeição automática)

```
Selo 1 · Business Verification          Selo 2 · Advanced Access (App Review)
Meta Business Suite                      developers.facebook.com
"essa empresa existe?"                   "esse app precisa mesmo dessa permissão?"
        │                                          │
        └── só depois disso o app vira Live ────────┘
            e só depois disso você pode pedir
```

**Standard Access** = só contas com papel no seu app (você e seus testers) funcionam.
**Advanced Access** = qualquer conta profissional pode conectar. **É esse que você precisa vender.**

Se você pedir Advanced Access antes da Business Verification concluída, a Meta **rejeita
automaticamente**, mesmo com todo o resto perfeito. É o erro de sequência mais comum.

### 10.2 Selo 1 — Business Verification (o que a Meta pede)

| Item | Detalhe |
|---|---|
| Onde | `business.facebook.com` → Central de Segurança → Verificação de empresa |
| Nome legal | Tem que bater **exatamente** com o documento |
| Endereço | O mesmo do comprovante |
| Telefone | A Meta **liga** para confirmar — precisa atender |
| Documento | Contrato social / cartão CNPJ / comprovante de inscrição |
| Comprovante de endereço | Conta de luz, água ou extrato bancário dos **últimos 90 dias** |

Prazo: varia muito; de 2 dias a 3 semanas. É o item que você **começa hoje**, porque não depende de código.

### 10.3 Selo 2 — App Review: as 7 peças que a Meta olha

**1. App configurado e em modo Live**
URL da política de privacidade, ícone, categoria, termos e checkboxes de uso de dados — tudo preenchido
e coerente. Campo faltando ou divergente = rejeição **antes** de qualquer análise.

**2. Pelo menos 1 chamada real por permissão**
A Meta exige que a funcionalidade **já funcione** antes de você pedir a permissão, e que a chamada tenha
acontecido nos 30 dias anteriores ao envio. Ou seja: a Fase 2 tem que estar de pé.

**3. Screencast por permissão (o motivo nº 1 de reprovação)**

| Regra | Detalhe |
|---|---|
| Um vídeo por permissão | Não vale um vídeo cobrindo várias |
| Do começo ao fim | Tela deslogada → login → **tela de consentimento** → app funcionando |
| Conta real | Business ou Creator de verdade, **não** usuário de teste |
| Dado aparecendo na tela | Token no console não conta: a conversa tem que aparecer no inbox |
| Idioma e qualidade | Inglês, 1080p, curto (2 a 3 minutos) |
| Sem corte esperto | Reviewers precisam identificar qual permissão está em uso em cada momento |

**4. Política de privacidade que cite a Meta**
Texto genérico = reprovação. Precisa dizer: quais dados do Instagram são coletados, para quê, com quem
são compartilhados, por quanto tempo ficam e como o titular apaga. E tem que estar **no mesmo domínio**
do app cadastrado.

**5. URL / callback de exclusão de dados funcionando**
A Meta **testa** isso durante a revisão. Se der 404 ou erro: reprovação. É uma rota simples — retorna um
código de confirmação e status — mas precisa existir e responder.

**6. Webhooks de ciclo de vida**
Assinatura verificada, e tratadores para `message_deletions` (se o usuário apaga a mensagem, sua cópia
também vai) e um caminho de **descadastro dentro da conversa** (palavra de saída respeitada pela IA).
O ciclo 2025–2026 está bem mais rígido nisso do que era em 2022.

**7. Texto de justificativa por permissão**
Por que **aquela** permissão, e por que uma mais estreita não resolve. Exemplo do que **não** escrever:
"usamos para melhorar o atendimento". Precisa nomear a funcionalidade e o dado.

### 10.4 O que o Ienvia pede (e só isso)

| Permissão | Para quê no produto | Obrigatória? |
|---|---|---|
| `instagram_business_basic` | ler perfil da conta conectada | **Sim** — vai junto com as outras |
| `instagram_business_manage_messages` | receber e responder DM | **Sim** — é o coração |
| `instagram_business_manage_comments` | comentário → DM (palavra-chave) | Só se quiser a Fase 4 |

Pedir permissão que você não demonstra no vídeo → ela é **removida ou reprovada**. Melhor ir com duas e
pedir a terceira depois do primeiro "aprovado".

### 10.5 Roteiro do screencast (para gravar e legendar em inglês)

| Tempo | Cena | O que o revisor precisa ver |
|---|---|---|
| 0:00–0:20 | Tela do Ienvia, aba Instâncias, botão "Connect Instagram" | app real, produto real |
| 0:20–0:45 | Tela da Meta com o login **deslogado** | o OAuth de verdade |
| 0:45–1:05 | **Tela de consentimento** com as permissões listadas | o usuário concedendo |
| 1:05–1:25 | Volta ao Ienvia: conta conectada, status "connected" | a permissão sendo usada |
| 1:25–2:00 | **Outro celular** manda um DM; ele aparece no inbox do Ienvia | mensagem chegando por webhook |
| 2:00–2:30 | A IA responde e a resposta aparece nos dois celulares | envio funcionando — e é isto que quase todo mundo esquece de mostrar |
| 2:30–2:50 | Aviso de que o atendimento é automático + palavra de descadastro sendo respeitada | conformidade |

Duas coisas obrigatórias no vídeo: **o aviso de automação** e **o caminho de saída**. Sem elas, reprova.

### 10.6 Prazo real

| Etapa | Prazo |
|---|---|
| Business Verification | 2 dias a 3 semanas (fora do seu controle) |
| Preenchimento + screencast + políticas | 2 a 3 dias de trabalho |
| Fila do App Review (estimativa da Meta, nov/2026) | **até 20 dias úteis por rodada** |
| Experiência relatada | 8 a 10 dias por rodada; caso conhecido: aprovado no dia 22 sem rejeição |
| Reprovação + reenvio | cada rodada nova = nova fila |

**Planejamento honesto:** 3 a 6 semanas do "vamos começar" ao "cliente conecta". Com uma reprovação no
meio, até dois meses.

### 10.7 As 8 formas de ser reprovado (e como evitar)

1. Pedir Advanced Access antes da Business Verification → esperar o selo 1.
2. Screencast sem a tela de consentimento → gravar desde deslogado.
3. Screencast com usuário de teste em vez de conta profissional real → usar conta real.
4. Vídeo sem mostrar a mensagem **chegando e sendo respondida** → mostrar os dois lados.
5. Política de privacidade genérica, sem citar Meta/Instagram → reescrever (hoje a sua não cita).
6. URL de exclusão de dados que não responde → implementar e testar antes.
7. Justificativa vaga → escrever por funcionalidade, por dado.
8. **Mudar o app durante a revisão** → congelar deploys que afetem o fluxo mostrado; se o revisor não
   conseguir entrar com as credenciais de teste, é reprovação.

### 10.8 Depois de aprovado (a fase que ninguém planeja)

| Risco | Mitigação no produto |
|---|---|
| Token expira (60 dias) e o atendimento para em silêncio | renovação automática + alerta no painel e no WhatsApp admin (`alertaAdminAtivo` já existe) |
| Cliente desliga "acesso às mensagens" no app do Instagram → nada chega, sem erro | verificação periódica de saúde da conexão + aviso na tela |
| Conta volta a ser pessoal → API morre | avisar e bloquear a conexão com explicação |
| Permissão cai/expira numa revisão futura da Meta | monitorar erros de permissão e alertar |
| Meta muda versão da API (v26 hoje) | manter a versão da Graph API em configuração, não espalhada no código |
| Auditoria de uso de dados (Data Use Checkup) anual | manter a resposta pronta no mesmo documento da política |

### 10.9 O que eu preparo e o que você faz

**Eu preparo (não depende da Meta):**
- seção de Instagram/Meta na `privacidade.html` e nos `termos.html`;
- página pública de exclusão de dados + rota de callback;
- roteiro do screencast (tabela acima) com as legendas em inglês;
- os 3 textos de justificativa, um por permissão, no formato que a Meta espera;
- checklist de submissão com os portões na ordem certa.

**Você faz (depende de ser o dono da empresa):**
- Business Verification com CNPJ e comprovantes;
- gravar o screencast seguindo o roteiro;
- clicar em "Request Advanced Access" e acompanhar o e-mail da Meta;
- responder a eventual pedido de ajuste **sem mudar o app** enquanto estiver em revisão.

---

## 11. Sem CNPJ: "cada cliente faz o próprio app" (modelo BYOA)

> Situação do dono (12/11/2026): **ainda não tem CNPJ**. Pergunta: dá para cada cliente fazer o próprio
> cadastro na Meta, com ele ensinando, sem depender de empresa verificada?
> Resposta: **dá, e resolve o problema do CNPJ.** Mas muda a arquitetura — e é agora que decide.

### 11.1 A descoberta que torna isso possível

O App Review só é obrigatório quando o app atende **contas que ele não possui ou administra**:

| Situação | Precisa de App Review? | Precisa de CNPJ? |
|---|---|---|
| App atende **só a conta do próprio dono do app** | **Não** | Não (na prática) |
| App atende conta de **terceiros** (seus clientes) | **Sim** — Advanced Access | **Sim** — Business Verification |

Traduzindo: se **o cliente é o dono do app** e conecta **a conta dele mesmo**, ninguém está sendo
atendido "em nome de terceiro". É uso próprio. **Não tem App Review, não tem Advanced Access, não tem
Business Verification.**

O mesmo vale para você: seu app, sua conta, uso pessoal — funciona, sem CNPJ, sem revisão.

### 11.2 Como fica na prática (o modelo "traga o seu app")

Para cada cliente, uma vez:

1. Ele cria uma conta em `developers.facebook.com` (precisa de **conta no Facebook**, não só Instagram, com 2FA).
2. Cria um app, adiciona o produto Instagram.
3. Pega **App ID**, **App Secret** e gera um **token de verificação** de webhook.
4. Cola esses três valores no Ienvia (aba Instâncias → Instagram).
5. No painel da Meta, cola a **URL de webhook do Ienvia** e assina os campos `messages` e `messaging_postbacks`.
6. Conecta o Instagram dele (Business/Creator) pelo botão do Ienvia.

E o **Ienvia continua sendo o cérebro**: treinamento, IA, inbox, Kanban, repasse humano — tudo igual. Só
muda de onde vêm as credenciais.

### 11.3 A consequência técnica (importante)

Hoje o Ienvia pensa em **um** app. Nesse modelo, **cada workspace tem o seu app da Meta**. Então:

| Peça | Muda como |
|---|---|
| Credenciais | `app_id`, `app_secret` (cifrado no cofre) e `verify_token` **por workspace** |
| OAuth | o `client_id` da autorização passa a ser o do cliente, resolvido pelo `state` |
| Webhook | uma URL só no Ienvia; o `verify_token` de cada workspace identifica de quem é o evento |
| Token de acesso | é do app do cliente; renovação de 60 dias é responsabilidade daquele app |
| Tela de conexão | precisa de um passo a mais: "cole aqui App ID / App Secret / token de verificação" |

**Decisão de arquitetura que economiza retrabalho:** implementar as credenciais **por workspace desde o
começo**, mesmo que hoje só exista uma (a sua). O conector é o mesmo código; se depois você fizer o App
Review e passar para "app único do Ienvia", ele vira o caso "padrão" e o BYOA continua como opção. Se
fizer o contrário — código com credencial global — a migração custa uma refatoração inteira.

### 11.4 O caminho recomendado, na ordem

| Etapa | O que é | Precisa de CNPJ? | Serve para |
|---|---|---|---|
| **0. Seu app pessoal** | você cria o app, conecta a sua conta | Não | validar tudo de verdade, hoje |
| **1. BYOA por workspace** | cada cliente com o app dele | **Não** | atender clientes já |
| **2. App Review (Fase 5)** | app único do Ienvia, Advanced Access | **Sim** | escala, white-label, onboarding de 1 clique |

As três etapas compartilham o mesmo conector. A 0 e a 1 são entregáveis de semanas; a 2 fica esperando o
CNPJ, sem bloquear nada.

### 11.5 O preço escondido do BYOA (para você decidir com os olhos abertos)

| Problema | Gravidade |
|---|---|
| Onboarding manual de 30 a 60 min por cliente, por telefone | alto — é o maior custo |
| Cliente precisa ter **conta no Facebook** ativa com 2FA | alto — muita gente só tem Instagram |
| Cliente pode errar o passo e o suporte cair em você | médio |
| Se o cliente apaga/recria o app, a conexão morre e ele não sabe | médio — precisa de alerta de saúde |
| Sem white-label: o cliente vê "app da Meta" no painel dele | baixo |
| LGPD: você processa os dados no seu Supabase → precisa de contrato de operador | médio (resolver no contrato de serviço) |
| **Você não pode criar o app no lugar dele** e usar a conta dele como tester | **crítico** — isso vira "atender terceiro" e devolve o problema do App Review |

### 11.6 O que nunca fazer (mesmo sem CNPJ)

1. **Não** crie um app seu e adicione o Instagram dos clientes como "testers"/papel no app. Para a Meta
   isso é atender contas de terceiros sem Advanced Access → permissão cortada e risco no seu nome.
2. **Não** aceite a senha do Instagram do cliente (nem "para eu configurar rapidinho"). Só OAuth.
3. **Não** use biblioteca que loga com usuário e senha ("instagrapi" e afins). Derruba a conta do cliente
   e é violação direta dos Termos.
4. **Não** prometa campanha/disparo no Instagram: no modelo do cliente é pior ainda — a conta é dele.

### 11.7 Resumo em três linhas

1. **Dá para fazer sem CNPJ**, desde que o app seja do próprio cliente e ele conecte a própria conta.
2. **O Ienvia precisa de credencial Meta por workspace** — é a única mudança de arquitetura, e é melhor
   fazer agora.
3. Isso é ótimo para você começar e atender os primeiros clientes; quando o CNPJ sair, o App Review
   transforma tudo em "conectar com 1 clique".
