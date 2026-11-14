# Laboratório do Instagram — passo a passo (para fazer hoje, com o seu Instagram)

> **ATUALIZAÇÃO 13/11/2026 — leia antes de seguir.** O laboratório agora roda em endereço fixo:
> **https://lab-instagram.ivanjeffersong8.workers.dev** (Cloudflare Worker).
> As etapas 4 e 5 abaixo (subir na máquina / túnel) **não são mais necessárias** — o endereço é permanente.
> O passo a passo atualizado está em `COMO-CONECTAR.md`. O resto deste arquivo continua válido como
> referência das regras da Meta (janela de 24h, limites, o que não funciona).

> Objetivo: **provar que o canal funciona** antes de escrever uma linha no Ienvia. Se o laboratório
> receber a sua DM e conseguir responder pela API, o caminho está validado.
> Tempo total: 40 a 60 minutos. Custo: zero.

---

## O que já está pronto e testado

O arquivo `laboratorio-instagram.mjs` está escrito e **já passou nos testes locais**:

| Teste | Resultado |
|---|---|
| Responde o desafio do webhook (`hub.challenge`) quando o token confere | ✅ devolveu `1234567890` |
| Recusa com 403 quando o token está errado | ✅ 403 |
| Recebe DM e mostra texto, remetente e `mid` | ✅ registrado |
| Entende **resposta de story** | ✅ marcada como `respondendoStory` |
| Confere a assinatura `X-Hub-Signature-256` | ✅ aceita válida, recusa falsa com 401 |
| Envio pela API | código pronto — só falta token real |

Falta só o que depende do seu Instagram: as 3 credenciais e um endereço público.

---

## Etapa 1 — Preparar a conta (5 min, no celular)

1. Instagram → **Configurações → Tipo de conta** → mudar para **Profissional** (Empresa ou Criador). É grátis.
2. Instagram → **Configurações → Mensagens e respostas a stories → Controles de mensagem →
   Ferramentas conectadas** → **ativar "Permitir acesso às mensagens"**.
   *Sem isso a API não recebe nada, e não aparece erro nenhum — é o problema silencioso mais comum.*

## Etapa 2 — Criar o app na Meta (10 min, no computador)

1. Entre em `developers.facebook.com` com a **conta do Facebook** (precisa de uma; Instagram sozinho não serve aqui).
2. **Meus apps → Criar app** → tipo **"Outro"** → **"Empresa"** (não precisa de empresa verificada para uso próprio).
3. No painel do app: **Adicionar produto → Instagram** → **API setup with Instagram login**.
4. Anote, na tela **Configurações do app → Básico**:
   - **ID do app** (App ID)
   - **Chave secreta do app** (App Secret) → botão *Mostrar*
5. Ainda nas configurações do app: preencha **URL da política de privacidade** e **URL dos termos**
   (pode usar `https://ienvia.online/privacidade` e `/termos` — já estão no ar).
6. Em **Funções (Roles)**: confirme que **o seu perfil do Instagram está adicionado** como testador/administrador.
   (Em app recém-criado, só contas com papel conseguem conectar — é o modo Standard Access, exatamente o
   que a gente quer provar agora.)

## Etapa 3 — Gerar o token de acesso (10 min)

Na tela do produto **Instagram → API setup with Instagram login**:

1. Clique em **Gerar token** para a sua conta do Instagram.
2. Autorize. A Meta devolve um **token de acesso do usuário do Instagram** (longo, ~60 dias).
3. Copie também o **Instagram User ID** que aparece na mesma tela.

> Esse token só serve **para a sua conta** (Standard Access). É o que queremos nesta etapa.
> Se aparecer erro de permissão, volte na Etapa 1.2 (permitir acesso às mensagens).

## Etapa 4 — Abrir o laboratório com endereço público (10 min)

A Meta precisa alcançar o webhook por **HTTPS público**. Duas opções:

**A) Pelo preview do workspace (mais fácil)**
O laboratório sobe numa porta e o ambiente já expõe um endereço público. Rode:

```bash
cd ~/ienvia/laboratorio-instagram
IG_TOKEN="cole-o-token" \
IG_APP_SECRET="cole-o-app-secret" \
IG_VERIFY_TOKEN="ienvia-teste-2026" \
PORTA=3000 node laboratorio-instagram.mjs
```

E o endereço público será algo como `https://3000-<sandbox>.e2b.app`.
O webhook que você vai colar na Meta é: **`https://<esse-endereço>/webhook`**

**B) Com túnel (se o endereço acima não abrir)**
```bash
cloudflared tunnel --url http://127.0.0.1:3000
```
(o `cloudflared` está instalado no ambiente; ele devolve uma URL `https://algo.trycloudflare.com`)

⚠️ Dois avisos que já custaram tempo antes: túnel gratuito **não resolve DNS dentro do sandbox**
(então teste pelo navegador do seu computador, não por dentro do sandbox) e a URL do túnel muda
cada vez que sobe.

## Etapa 5 — Conectar o webhook no painel da Meta (10 min)

No painel do app → **Instagram → Configuração da API → Webhooks**:

| Campo | Valor |
|---|---|
| URL de retorno de chamada | `https://SEU-ENDERECO/webhook` |
| Token de verificação | `ienvia-teste-2026` (o mesmo do `IG_VERIFY_TOKEN`) |

Clique em **Verificar e salvar**. O laboratório responde o desafio na hora — se der erro, o terminal
mostra o motivo (token diferente, URL errada ou porta fechada).

Depois de salvar, **assine os campos**:

- `messages` (DMs e respostas de story) ← **obrigatório para o teste**
- `messaging_postbacks` (cliques em botão)
- `comments` (comentários — só se você quiser testar a Fase 4)

## Etapa 6 — O teste de verdade (5 min)

1. Abra o painel do laboratório no navegador: `https://SEU-ENDERECO/painel`
2. Peça para **outra pessoa** (ou outra conta sua) mandar uma DM para o seu Instagram:
   *"Oi! Vocês entregam no centro?"*
3. A mensagem aparece no terminal **e** no painel, com o IGSID de quem mandou. 🎉
4. Copie o **IGSID** e use o formulário "Enviar DM de teste" do painel.
5. A resposta deve chegar no Instagram de quem mandou.

Se os 5 passos funcionarem, o canal está provado: **recebe, entende e responde pela API oficial.**

## Etapa 7 — Testar os limites de propósito (5 min, é o mais valioso)

| Teste | O que deve acontecer |
|---|---|
| Responder uma **resposta de story** | chega igual a uma DM, marcada como story reply |
| Mandar **áudio** ou **foto** | chega como anexo (o laboratório mostra o tipo) |
| Tentar enviar para alguém que **não** te mandou mensagem | Meta recusa — é a regra do "só responde quem falou primeiro" |
| Esperar **mais de 24h** e tentar responder | erro `10 / 2534022` — a janela existe de verdade |
| Desligar "permitir acesso às mensagens" e mandar DM | **nada chega** e nenhum erro aparece — o problema silencioso |

Esses cinco testes valem mais que qualquer documentação: são as regras que vão desenhar o produto.

---

## O que **não** vai funcionar nesta fase (e é esperado)

- **Outra pessoa** conectar o Instagram dela no seu app → bloqueado (Standard Access).
  Cada cliente precisa do **app dele** (modelo BYOA, seção 11 do `PLANO-INSTAGRAM.md`).
- **Comentário → DM** só funciona se você assinar o campo `comments` e o app tiver a permissão de
  comentários — em Standard Access, apenas nas suas próprias mídias.
- O laboratório **não guarda nada**: reiniciou, perdeu. É de propósito.

## Se algo der errado, olhe aqui primeiro

| Sintoma | Causa provável | Onde resolver |
|---|---|---|
| "Verificar e salvar" falha | URL não é pública, ou token de verificação diferente | Etapa 4 e 5 |
| Nenhum evento chega | campo `messages` não assinado, ou "acesso às mensagens" desligado | Etapa 1.2 e 5 |
| Erro de permissão ao gerar token | conta não é profissional, ou seu IG não tem papel no app | Etapa 1.1 e 2.6 |
| Envio recusado com erro 10 | fora da janela de 24h, ou destinatário nunca te escreveu | é a regra, não é bug |
| Token para de funcionar em ~60 dias | validade normal | gerar de novo |

---

## Depois que der certo

Com o canal provado, a próxima etapa é esta sequência (sem pressa e sem retrabalho):

1. **Credencial Meta por workspace** no Ienvia (a peça que serve para uso pessoal, BYOA e futuro App Review).
2. Conector Instagram (`receber` / `enviar`) reaproveitando exatamente a lógica que o laboratório provou.
3. Tela de conexão (colar App ID / App Secret / token de verificação).
4. Quando o CNPJ sair: Business Verification + App Review → "conectar com 1 clique" para o cliente.
