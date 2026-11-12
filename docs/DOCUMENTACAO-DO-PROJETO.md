# Ienvia — documentação do projeto

Retrato feito em 12/11/2026 (horário de Fortaleza), logo depois do commit `4722bf5`.

Este documento junta, num lugar só: como o trabalho é feito, o que aconteceu até aqui, o que já está
pronto, o que já foi testado (e o que não foi), o que falta e o que é cada arquivo. Serve para o dono
do projeto e para qualquer pessoa, ou outra IA, que venha a continuar o trabalho.

Os outros documentos, e para que serve cada um:

| Documento | Para quê |
| --- | --- |
| [PLANO.md](./PLANO.md) | O mapa do trabalho: as fases, cada decisão tomada e cada pendência, em detalhe. É a fonte da verdade. |
| [O-QUE-FICA-E-O-QUE-SAI.md](./O-QUE-FICA-E-O-QUE-SAI.md) | A lista, aprovada pelo dono, do que entra no sistema novo e do que foi cortado. |
| [README.md](../README.md) | Como rodar o painel num computador e como conferir se está tudo certo. |
| `apoio-da-reconstrucao/LEIAME.md` (fora do Git) | O diário técnico do trabalho: o que foi descoberto, as armadilhas e os comandos usados. |

Se este documento e o PLANO.md disserem coisas diferentes, vale o PLANO.md (ele é atualizado a cada entrega).

---

## 1. O projeto em uma página

**O que é.** O Ienvia é um sistema de atendimento e CRM para WhatsApp: vários chips, atendente de
IA, caixa de entrada (Inbox), campanhas e contas separadas por cliente. Este repositório é a
**reescrita limpa** do sistema antigo (ZAP IA Studio, `zap-ia-studio` 5.8). O antigo funcionava, mas
tinha crescido sem ordem, e mexer numa parte quebrava outra. A decisão foi refazer do zero, lendo o
antigo e reescrevendo limpo, fase por fase.

**Situação em 12/11/2026.**

- Fases 0 e 1 prontas. Fase 2 (atendente de IA) quase toda pronta.
- Tudo o que foi feito está no GitHub e no banco novo, e passa nos testes.
- **Nada do que foi feito depois de 11/11 está publicado**: a hospedagem está parada (seção 7).
- **Ninguém viu ainda uma mensagem de verdade num celular** com o sistema novo. Tudo foi conferido
  até onde dá sem um chip conectado no painel publicado.

**Onde cada coisa mora.**

| O quê | Onde | Observação |
| --- | --- | --- |
| Código | GitHub, repositório privado `ivandoplay/ienvia-novo`, ramo `main` | Enviar para o GitHub não publica nada sozinho. |
| Banco do sistema novo | Supabase, projeto `ienvia-001` (`rhcabqlwazvjcjjdknsc`), organização "ienvia", São Paulo, plano gratuito | 16 migrações aplicadas, idêntico ao que está no Git. |
| Banco anterior do sistema novo | Supabase, projeto "Ienvia" (`jazvdlkyvwquoednmljf`), organização "ZAP IA STUDIO" | Pausado em 12/11. Não tinha dado de cliente. Pode ser apagado. |
| Banco do sistema antigo | Supabase, projeto `iuysmojhaxplnhfrxqkv`, organização "ZAP IA STUDIO" | Bloqueado por cota até 26/11/2026. Nele só se lê, nunca se escreve. |
| Hospedagem (conta de sempre) | Vercel, conta `ivandoplay`, plano gratuito | Pausada pela Vercel até 11/12/2026. Lá está a versão de 11/11 do sistema novo (`ienvia-novo.vercel.app`) e o sistema antigo (`zap-ia-studio.vercel.app`). |
| Hospedagem (conta nova) | Vercel, conta `jeffersonivan748-7132`, plano gratuito | Criada pelo dono em 12/11 para deixar o Ienvia separado. Nada foi publicado nela pelo assistente. |
| Chips do WhatsApp | Servidor Evolution API 2.3.7 (endereço e chave no `.env`) | Falta confirmar se o servidor é do próprio dono. |
| Chaves de IA do dono (para testes) | Gemini, OpenRouter e NVIDIA, no `.env` | A do Gemini está bloqueada pelo Google. |
| Cópia de segurança | Google Drive do dono, pasta "Ienvia — cópia de segurança e documentação" | <https://drive.google.com/drive/folders/170L0zRiKjBpkUecpLHrUAdr6QoviplLQ> |
| Área de trabalho do assistente | `/home/user`: `ienvia/` (este repositório), `apoio-da-reconstrucao/`, `.env` | Descrita na seção 8. |

---

## 2. Como o trabalho é feito

### As regras

Estas regras vêm das decisões do dono e valem para todo o projeto (a lista completa está na seção 2 do PLANO.md).

1. **Fase por fase.** Uma fase só começa quando a anterior está com os testes passando.
2. **Nada entra sem teste.** O que já funcionava continua sendo testado a cada entrega.
3. **Nada é publicado sozinho.** Cada publicação é feita de propósito, depois dos testes.
4. **A segurança fica no banco.** O painel conversa com o banco como o usuário logado. Mesmo que uma
   tela tenha um erro, o banco não entrega dados de outra empresa.
5. **Migração aplicada não se edita.** Toda mudança no banco é um arquivo novo.
6. **Segredo não vai para o Git.** As credenciais ficam no arquivo `.env`, fora do repositório.
7. **Nada finge funcionar.** Tela que ainda não foi refeita diz isso com clareza.
8. **Nunca reenviar sozinho** uma mensagem depois de um envio incerto.
9. **Todo chip nasce com a IA desligada.** Quem liga é o dono, num botão explícito.
10. **Tudo em português do Brasil**, na tela e no código.
11. **No banco antigo só se lê.** Se uma mudança no banco novo apagar algum dado que já existe, o dono é consultado antes.

### O caminho de cada entrega

1. **Ler o antigo.** Ver como o sistema antigo fazia aquilo e o que a lista de cortes diz.
2. **Banco primeiro.** Escrever a migração nova e os testes dela, num banco de teste que roda na memória.
3. **Ensaiar no banco de verdade.** A migração roda inteira e é desfeita, só para ver se passa.
4. **Aplicar.** Depois do ensaio, a migração é aplicada no banco de verdade.
5. **Tirar o retrato.** Um resumo do banco de verdade é comparado com o do Git. Têm de ser iguais.
6. **Escrever o código** das regras, das telas e do servidor, com os testes de cada parte.
7. **Testar no navegador** de mentira (um Supabase, uma Evolution e uma IA "de mentira").
8. **Conferir no ambiente de verdade**, com uma conta de teste separada: primeiro direto no banco
   (um roteiro que desfaz tudo no final), depois pelo navegador, com o painel rodando ligado ao banco
   de verdade. Os roteiros apagam o que criam.
9. **Rodar `npm run verificar`** inteiro (tipos, estilo, testes, montagem e navegador).
10. **Fotografar as telas** e comparar com o visual escolhido.
11. **Atualizar o PLANO.md** e o README.md, procurar segredos nos arquivos e gravar no Git.
12. **Contar ao dono** o que foi feito, o que foi conferido e o que não foi.

### Como saber que uma fase está pronta

1. `npm run verificar` passa inteiro.
2. As telas novas foram comparadas com o visual de referência, no computador e no celular.
3. O que mudou no banco está numa migração nova, testada antes de ir para o banco de verdade.
4. O PLANO.md foi atualizado.

---

## 3. Linha do tempo

Horários de Fortaleza. Os códigos entre crases são os commits no Git.

### Antes do código

- O dono respondeu três questionários. As respostas viraram a tabela de decisões do PLANO.md
  (motores do WhatsApp, banco, ordem das fases, visual, chaves de IA, lista de cortes).
- O visual escolhido foi o do ramo `feat/modernizacao-painel-oficial` do sistema antigo.

### 11/11/2026

| Hora | O que aconteceu |
| --- | --- |
| 13h40 | Fase 0: fundação. Repositório novo, login, moldura do painel, Visão geral e testes (`6b2518b`). |
| 14h05 | Decisões do terceiro questionário registradas (`127b4cb`). |
| 15h13 | Banco: chips com função, número conectado, limite por conta e ações do dono (`3bcd7d8`). |
| 15h38 | Fase 1: aba Instâncias, para conectar chips pela Evolution (`b2c12a4`). |
| 15h46 | Fase 1: porta de entrada das mensagens, os avisos da Evolution (`f4192ed`). |
| 16h15 | **Publicado** em `ienvia-novo.vercel.app` (versão `bd3c033`). Instâncias e recebimento funcionaram no ar. |
| 16h42 | **A Vercel pausou a conta inteira** (limite do plano gratuito). Daqui em diante, nada mais foi publicado. |
| 17h35 | Fase 1: Inbox com texto: ler, responder, resolver, buscar, ver por chip (`e61304f`). |
| ~19h30 | **O Supabase bloqueou a organização antiga** por cota de tráfego (o banco do sistema antigo e o primeiro banco do novo). |
| 20h06 | Fase 1: arquivos na Inbox: fotos, áudios, vídeos, documentos e figurinhas (`49f6204`). |
| 21h39 | Fase 2: Motor de IA com Gemini, OpenRouter e NVIDIA (`46cb018`). |
| 22h10 | Fase 2: Treinamento: identidade, regras, perguntas, arquivos, modelos e várias bases (`43fa814`). |
| 22h28 | Plano atualizado: quem gastou a cota dos dois bloqueios e os caminhos de saída (`7546480`). |

### 12/11/2026

| Hora | O que aconteceu |
| --- | --- |
| 07h37 | **O banco do sistema novo mudou de endereço**: projeto `ienvia-001`, numa organização nova, com cota própria. Remontado a partir do Git, com os mesmos logins e senhas (`d67e1f8`). |
| 14h29 | Fase 2: atendente de IA. A IA responde no WhatsApp nos chips em que for ligada (`890f4c9`). |
| 14h55 | Lido na Vercel o motivo exato da pausa e a data de volta: 11/12/2026 às 16h42. |
| 15h41 | Fase 2: corrigir resposta em 1 clique, ensinar a IA sem sair da conversa (`7145ed4`). |
| 16h14 | O dono criou uma conta nova na Vercel, para deixar o Ienvia separado. |
| 16h16 | Plano atualizado: o teste gratuito do Vercel Pro como saída (`6518a0e`). |
| 16h39 | A área de trabalho passou do limite de tamanho. Causa: a pasta de montagem dos testes. Corrigido (`4722bf5`). |
| 16h49 | Cópia de segurança da área de trabalho enviada ao Google Drive do dono. |
| depois | Este documento. |

---

## 4. O que já foi feito

O detalhe de cada item, com as decisões tomadas, está na seção 4 do PLANO.md.

### Fase 0 — Fundação (pronta)

- Login com usuário ou e-mail e senha, no mesmo formato do sistema antigo.
- Moldura do painel: menu lateral, barra do topo, tema escuro e claro, menu do celular, "Sair".
- Visão geral com números reais do banco.
- As outras abas aparecem no menu e avisam em que fase ficam prontas.

### Fase 1 — Conectar e conversar (pronta no código e no banco)

- **Instâncias**: adicionar chip por QR Code ou código, apelido, função, desconectar, remover, limite de chips por conta.
- **Recebimento**: a Evolution avisa o painel de cada mensagem que chega ou sai e de cada chip que conecta ou cai. Cada chip tem um segredo próprio. Mensagem repetida não é gravada duas vezes.
- **Inbox**: lista de conversas com filtros e busca, ver por chip, conversa em balões, responder, resolver, reabrir, ficha básica do contato, tela própria no celular. Mensagem nova entra sozinha.
- **Arquivos na Inbox**: receber e enviar fotos, áudios, vídeos e documentos; receber figurinhas. Os arquivos ficam num depósito fechado, e só quem é da empresa vê.
- **Regras do envio**: nunca reenvia sozinho; envio incerto fica "sem confirmação" e a pessoa decide.

### Fase 2 — Atendente de IA (em andamento)

Pronto:

- **Motor de IA**: três provedores (Gemini, OpenRouter, NVIDIA), chave de cada cliente guardada cifrada, ordem de uso com reserva, comportamento nas conversas.
- **Treinamento**: identidade, regras, perguntas frequentes, arquivos de conhecimento, nove modelos prontos, várias bases, base por chip, "ver instruções geradas".
- **Atendente**: a IA responde no WhatsApp nos chips em que for ligada, espera o cliente terminar de escrever, mostra "digitando…", divide respostas longas, passa a conversa para uma pessoa quando precisa e para quando uma pessoa responde. Botões "Assumir" e "Devolver para a IA" na Inbox. Botão de emergência "Pausar tudo".
- **Corrigir resposta em 1 clique**: na Inbox, o dono guarda no Treinamento o jeito certo de responder, a partir de uma resposta da IA ("Corrigir resposta") ou de uma pessoa ("Ensinar à IA").

Falta: ver a seção 6.

### Trabalho de bastidor

- **Mudança de banco** (12/11): o banco do sistema novo saiu da organização bloqueada e foi remontado num projeto só dele, idêntico ao anterior, com os mesmos logins.
- **Causa dos bloqueios encontrada**: o painel antigo chama o servidor a cada 3,5 segundos e relê a conta inteira; a extensão "Agente de Página" pergunta ao banco a cada 11 segundos. Foi isso que gastou as cotas do Supabase e, por dedução, da Vercel. O sistema novo não repete o problema (medido).
- **Pasta de montagem dos testes** mudou de lugar (12/11), para a área de trabalho não passar do limite.
- **Cópia de segurança** no Google Drive, com as credenciais num arquivo fechado por senha.

---

## 5. O que já foi testado (e o que não foi)

### Testes automáticos

Rodam com `npm run verificar`. Nenhum deles encosta no banco de verdade, cria chip de verdade, manda mensagem para alguém ou gasta chave de IA.

| Tipo | Quantos | O que conferem |
| --- | --- | --- |
| Regras e banco (`npm test`) | 901 testes em 36 arquivos | Login, menu, datas, chips, Inbox, arquivos, a conversa com a Evolution, os avisos de mensagem, o motor de IA, o treinamento, o atendente, ensinar a IA, e as regras do banco (uma empresa não vê a outra, o que o navegador não pode fazer, o que cada papel pode). |
| Navegador (`npm run test:e2e`) | 279 testes, mais 15 que só valem para uma das duas telas | As telas usadas como uma pessoa usaria, em tela de computador e de celular, nos dois temas, com teclado e conferência de acessibilidade. |

- A última rodada completa foi em 12/11, no commit `7145ed4`: tudo passou.
- Depois dela houve um commit que só mexe no lugar da pasta de montagem dos testes (`4722bf5`).
  Para ele foram rodados a conferência de tipos, a de estilo e os testes de login e do painel no
  navegador (43 passaram, 3 pulados de propósito). **A bateria inteira não foi rodada de novo.**

### Conferências no banco de verdade

Cada roteiro roda no banco de verdade com a conta de teste e desfaz tudo no final.

| O quê | Resultado |
| --- | --- |
| Retrato do banco comparado com o Git (11 categorias, 16 migrações) | Igual |
| Motor de IA e Treinamento | 31 de 31 |
| Arquivos da Inbox | 40 de 40 |
| Atendente de IA | 56 de 56 |
| Ensinar a IA pela conversa | 37 de 37 |

### Conferências pelo navegador, no ambiente de verdade

O painel rodando na área de trabalho, ligado ao banco novo de verdade, com a conta de teste.

| O quê | Com o quê | Resultado |
| --- | --- | --- |
| Instâncias e recebimento | Painel publicado na Vercel em 11/11, Evolution de verdade | Funcionaram no ar (antes da pausa) |
| Inbox com texto | Banco e Evolution de verdade, chip de teste nunca ligado a um WhatsApp | Funcionou; os avisos de mensagem foram entregues à mão |
| Arquivos da Inbox | Banco, depósito de arquivos e Evolution de verdade | 62 conferências certas, entre elas 25 tentativas de acesso indevido, todas recusadas |
| Motor de IA e Treinamento | Banco de verdade, NVIDIA e OpenRouter de verdade | 26 conferências certas |
| Atendente de IA | Banco, Evolution e NVIDIA de verdade | 34 conferências certas; a IA respondeu em menos de 1 segundo usando o treinamento |
| Ensinar a IA pela conversa | Banco de verdade | 31 conferências certas |

As instruções que a IA recebe também foram postas à prova com dois modelos de verdade (NVIDIA e
OpenRouter), em 14 situações. A primeira rodada achou três defeitos no texto; corrigidos, a segunda
deu 14 de 14 nos dois.

### O que NÃO foi conferido

| O quê | Por quê |
| --- | --- |
| Uma mensagem de verdade chegando do WhatsApp, a resposta saindo e chegando num celular | Precisa de um chip do dono conectado no painel publicado. |
| A IA respondendo num celular de verdade, com "digitando…" e com uma resposta ensinada | O mesmo motivo. |
| Um arquivo de verdade chegando pelo WhatsApp e outro saindo para um contato | O mesmo motivo. |
| O Gemini: conversa, foto, áudio, PDF e lista de modelos | A chave do dono está bloqueada pelo Google. Áudio e PDF só funcionam pelo Gemini. |
| O sistema numa hospedagem de verdade (tudo o que veio depois de 11/11) | A hospedagem está parada. |
| A bateria inteira de testes depois do último commit | Ver acima: só uma parte foi rodada. |
| O arquivo fechado da cópia de segurança aberto no 7-Zip, WinRAR ou ZArchiver | Foi aberto só com a mesma ferramenta que o criou. |

---

## 6. O que falta fazer

### Para fechar a Fase 2

1. No Treinamento: **Mensagens prontas** (M01–M13), **Estúdio de Skills**, **"Cérebro completo"** e **"Pacote Turbo"**.
2. **Publicar** e conferir com um chip do dono: uma mensagem real chegando, a IA respondendo e a resposta aparecendo no celular.

### As próximas fases

| Fase | Nome | O que entrega |
| --- | --- | --- |
| 3 | CRM completo | Etiquetas, Kanban, agenda de contatos, valor e ganho/perdido, notas, busca, respostas rápidas, agendar envio, Histórico. |
| 4 | Motor local | O motor que roda no PC ou no Termux do cliente, com atualização automática assinada. Aba Conexões / Motor. |
| 5 | Campanhas e segurança | Campanhas com prévia, cadência segura, rodízio de chips, pausar e retomar. Anti-ban, fila segura, horário de atendimento, contatos ignorados, alerta no WhatsApp do dono. |
| 6 | Catálogo, áudios e simulador | Catálogo & PIX, áudios na voz do dono, Simulador. |
| 7 | Contas, configurações e migração | Clientes SaaS (criar contas, limites, modo suporte), Configurações, exportar dados. Migração dos dados do banco antigo (seção 5 do PLANO.md). |
| 8 | Virada | O endereço de produção passa a apontar para o novo. O antigo só é desligado depois de o dono conferir. |

### Antes da virada

- Limite próprio de tentativas de login, por usuário.
- Política de segurança de conteúdo (CSP) completa.
- Limpeza automática dos arquivos que passaram do prazo de guarda (hoje nada é apagado).
- Apagar a conta de teste do banco novo (`teste-automatico`).
- Rodar a bateria inteira de testes de novo.

### Coisas pequenas anotadas

Estão no fim da seção 6 do PLANO.md. As principais: a Inbox consulta o servidor de tempos em tempos
(com muitos atendentes, vale trocar pelo canal em tempo real do Supabase); o áudio do WhatsApp não
toca em navegadores antigos (há o botão "Baixar"); o verde dos botões com letra branca tem pouco contraste.

---

## 7. Bloqueios e pendências

### Bloqueios de conta

| O quê | Situação | Como sai |
| --- | --- | --- |
| Vercel, conta `ivandoplay` | Pausada desde 11/11 às 16h42. Motivo lido na própria Vercel: limite de uso do plano gratuito (*Fast Origin Transfer*, 10 GB a cada 30 dias). Data de volta registrada: **11/12/2026 às 16h42** (pode precisar do suporte). | Pagar o plano Pro (US$ 20 por mês), usar o teste gratuito do Pro (14 dias), ou esperar. |
| Supabase, organização "ZAP IA STUDIO" (sistema antigo) | Bloqueada desde a noite de 11/11: usou 14,76 GB dos 5,5 GB de tráfego do plano gratuito. Volta em **26/11/2026**. | Pagar o plano Pro (US$ 25 por mês) ou esperar. O sistema novo não depende mais dela. |
| Chave do Gemini | Recusada pelo Google como "vazada". | O dono cria uma chave nova em `aistudio.google.com/apikey`. |

### Onde publicar o sistema novo (em aberto)

O plano gratuito da Vercel não aceita uso comercial, e a conta de sempre está pausada. As saídas
levantadas, com os preços de novembro de 2026:

1. **Teste gratuito do Vercel Pro**, por 14 dias, sem cartão. Serve para pôr o sistema novo no ar já.
   No fim, ou se paga o Pro, ou o painel muda de lugar.
2. **Vercel Pro**, US$ 20 por mês.
3. **Um servidor pequeno sempre ligado**, cerca de US$ 5 a 7 por mês (Fly.io, Railway ou Render). Leva
   de um a dois dias para montar. É o formato que melhor atende as próximas fases (campanhas e envios agendados).
4. **Esperar** o fim da pausa.

Hospedagem gratuita que aguente um atendimento de verdade não foi encontrada.

**A conta nova da Vercel.** Em 12/11 o dono criou uma segunda conta (`jeffersonivan748-7132`), para o
Ienvia ficar separado da conta pessoal, pensando numa venda futura do sistema. Ela está no plano
gratuito. A política de uso da Vercel proíbe criar várias contas para passar dos limites de uso, e a
conta de sempre está pausada por esse limite. Por isso o assistente não publicou nem configurou o
sistema no plano gratuito da conta nova; com ela no teste do Pro ou no Pro pago, faz. O dono disse
que ele mesmo vai criar o projeto e ligar o GitHub nessa conta. O token dela está guardado no `.env`.

**O que a hospedagem precisa ter**, seja qual for:

| Variável | Para quê |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Endereço do projeto `ienvia-001`. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Chave pública do projeto. |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave do servidor (segredo). Sem ela as mensagens não entram e a IA não responde. |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` | Endereço e chave da Evolution (segredo). |
| `IENVIA_CHAVE_DOS_SEGREDOS` | Abre as chaves de IA guardadas (segredo). Tem de ser o mesmo valor do `.env`. |
| `IENVIA_URL_PUBLICA` | Endereço público do painel. Na Vercel não precisa. |

Os valores estão no `.env` e no `web/.env.local` (seção 8). A região do servidor deve ser São Paulo,
ao lado do banco (na Vercel isso já está no arquivo `web/vercel.json`). Depois de publicar, é preciso
cadastrar o endereço novo no Supabase (endereço do site e endereços permitidos para o login).

Cuidados que valem para qualquer hospedagem:

- Os chips têm de ser conectados pelo endereço publicado. A prévia da área de trabalho não recebe mensagens do WhatsApp.
- O atendente de IA prepara a resposta dentro do pedido que trouxe a mensagem. Cada pedido tem 55
  segundos (cabe numa hospedagem que corta em 60). Num servidor próprio dá para aumentar com `IENVIA_ATENDENTE_ORCAMENTO_MS`.
- Quando a conta de sempre da Vercel voltar, o painel antigo usado do mesmo jeito gasta o limite outra vez em cerca de duas semanas.

### Pendências que dependem do dono

1. Escolher onde publicar.
2. Criar uma chave nova do Gemini.
3. Confirmar se o servidor da Evolution é dele.
4. Conferir que o próprio login funciona no banco novo (mesmo e-mail e mesma senha de antes).
5. Dizer se quer manter o botão "Ensinar à IA" (foi um acréscimo; o pedido era corrigir a resposta da IA).
6. Quando o trabalho acabar, trocar os tokens que foram colados no chat (GitHub, Supabase e Vercel).
7. O repositório antigo é público e tem usuário, senha e telefones escritos em dois documentos. Recomendado: trocar essa senha e tornar o repositório privado.
8. Fechar as abas do painel antigo que não estiverem em uso e desligar a extensão "Agente de Página", para o Supabase antigo não bloquear de novo.
9. Os projetos do Supabase das organizações "menu flow" e "pizzaria" não foram apagados: o assistente não tem acesso a elas.
10. No plano gratuito, o Supabase pausa um projeto que fica uma semana sem movimento. Se o `ienvia-001` pausar, basta abrir o projeto no site e clicar em *Restore project*. Nada se perde.

---

## 8. O que é cada arquivo

### 8.1 Visão de cima

```
ienvia/                    Este repositório (vai para o GitHub).
├── docs/                  Os documentos.
├── shared/                Regras usadas pelo painel e, mais adiante, pelo motor local.
├── supabase/              O banco: as migrações, em ordem, e os testes de segurança.
└── web/                   O painel: o que o cliente abre no navegador, e o servidor dele.

apoio-da-reconstrucao/     Fora do Git. Diário, ferramentas e fotos do assistente.
.env                       Fora do Git. Todas as credenciais.
```

A pasta `motor/` (o motor local do WhatsApp) entra na Fase 4.

### 8.2 Raiz do repositório

| Arquivo | O que é |
| --- | --- |
| `README.md` | Apresentação, como rodar e como conferir. |
| `package.json` | Os comandos do projeto (`dev`, `build`, `check`, `lint`, `test`, `test:e2e`, `verificar`) e as três partes (`shared`, `web`, `supabase`). |
| `package-lock.json` | A lista exata das dependências instaladas. Gerado sozinho. |
| `vitest.config.ts` | Configuração dos testes de regras e de banco, em três grupos: `shared`, `web` e `banco`. |
| `tsconfig.base.json` | Regras do TypeScript comuns às três partes. |
| `.nvmrc` | A versão do Node usada (24). |
| `.editorconfig` | Padrão de espaços e fim de linha para os editores. |
| `.gitignore` | O que nunca vai para o Git: dependências, montagens, caches e arquivos `.env`. |

### 8.3 `docs/`

| Arquivo | O que é |
| --- | --- |
| `PLANO.md` | O mapa do trabalho (fases, decisões, pendências). |
| `O-QUE-FICA-E-O-QUE-SAI.md` | A lista do que entra e do que foi cortado, aba por aba. |
| `DOCUMENTACAO-DO-PROJETO.md` | Este documento. |

### 8.4 `shared/`

| Arquivo | O que é |
| --- | --- |
| `shared/src/auth/usuario.ts` | Login por nome de usuário: transforma `joao` no e-mail interno `joao@zapia.local` e de volta. |
| `shared/src/index.ts` | A porta de entrada do pacote. Aqui só entra código puro, sem rede nem banco. |
| `shared/test/usuario.test.ts` | Testes do login por nome de usuário. |
| `shared/package.json`, `shared/tsconfig.json` | Configuração do pacote. |

### 8.5 `supabase/migrations/` — as mudanças do banco, em ordem

As nove primeiras vieram da tentativa anterior do dono e foram trazidas como estavam. As outras sete foram escritas nesta reconstrução.

| Arquivo | O que faz |
| --- | --- |
| `20261109122635_0001_core.sql` | A base: perfis, empresas, participações, chips, contatos, conversas, mensagens, fila de envio, avisos recebidos, administrador da plataforma e auditoria, com a trava por empresa. |
| `20261109122713_0002_consent_campaigns.sql` | Anexos de mensagem, consentimento dos contatos, campanhas e destinatários, exportações e convites. |
| `20261109141126_workspace_owner_settings.sql` | Ajuste de permissão do dono nas configurações da empresa. |
| `20261109141631_platform_master_identity_rpc.sql` | Função que diz se quem está logado é o administrador da plataforma. |
| `20261109143524_contact_erasure_request_insert.sql` | Permite registrar um pedido de apagar os dados de um contato. |
| `20261109143837_conversation_safe_actions.sql` | Mudar a etapa de uma conversa por uma função segura. |
| `20261109144048_workspace_data_policy_rpc.sql` | Mudar os prazos de guarda dos dados da empresa. |
| `20261109150238_evolution_instance_lifecycle.sql` | Registrar um chip da Evolution e atualizar o estado dele. |
| `20261109154324_evolution_webhook_ingest.sql` | Receber uma mensagem de texto da Evolution, com o segredo de cada chip. |
| `20261111181233_instance_controls.sql` | Chips: função, número conectado, limite por conta, criar, renomear, conferir, trocar o segredo e remover. |
| `20261111192236_inbox_messaging.sql` | Enviar texto pela Inbox, o eco da Evolution e reabrir conversa. |
| `20261111194001_inbox_reading.sql` | Ler a Inbox: lista de conversas, conversa aberta e o "mudou alguma coisa?". |
| `20261111222708_inbox_media.sql` | Arquivos: receber, guardar no depósito, enviar, e quem pode ler ou subir cada arquivo. |
| `20261112002400_ai_engine_and_training.sql` | Motor de IA (ajustes e chaves cifradas) e Treinamento (bases, perguntas e arquivos de conhecimento). |
| `20261112161500_ai_attendant.sql` | O atendente: a vez da IA em cada conversa, o envio da resposta, passar para uma pessoa, assumir e devolver, Pausar tudo, ligar a IA por chip. |
| `20261112181500_ai_teaching.sql` | Ensinar a IA a partir de uma mensagem da conversa, e a revisão das bases de treinamento. |

### 8.6 `supabase/tests/` — testes do banco

Sobem um Postgres de verdade na memória, aplicam as migrações e conferem as regras.

| Arquivo | O que confere |
| --- | --- |
| `esquema.test.ts` | O banco montado a partir do Git é igual ao retrato do banco de verdade. |
| `isolamento.test.ts` | Uma empresa nunca enxerga os dados da outra. |
| `permissoes.test.ts` | O que o navegador não pode fazer direto no banco, o que cada pessoa pode e o que é do servidor. |
| `instancias.test.ts` | Chips: quem cria, renomeia, confere e remove; o limite por conta; os avisos de conexão. |
| `recebimento.test.ts` | Mensagem que chega vira contato, conversa e mensagem na empresa certa, sem duplicar. |
| `conversa.test.ts` | Responder, envio que falha ou fica incerto, o eco da Evolution, mensagens pelo celular, reabrir. |
| `inbox.test.ts` | A lista de conversas com filtros e busca, a conversa aberta e o "mudou alguma coisa?". |
| `midia.test.ts` | Arquivos: receber, guardar, enviar, o eco, e quem pode ler ou subir no depósito. |
| `ia.test.ts` | Motor de IA (ajustes e chaves) e Treinamento (bases, perguntas, arquivos). |
| `atendente.test.ts` | O atendente no banco: quando a IA responde, a vez dela, o envio, o repasse, a pausa, assumir e devolver. |
| `ensino.test.ts` | Ensinar a IA pela conversa e a revisão das bases. |
| `helpers/banco.ts` | Monta o banco de teste na memória. |
| `helpers/cenario.ts` | O cenário dos testes: duas empresas que não se conhecem. |
| `impressao-digital.sql` | O comando que tira o retrato do banco (um resumo por categoria). |
| `impressao-digital.remoto.json` | O retrato do banco de verdade, tirado depois da última migração. |

`supabase/tsconfig.json` é a configuração do TypeScript desses testes.

### 8.7 `web/` — arquivos de configuração

| Arquivo | O que é |
| --- | --- |
| `web/.env.example` | O modelo das variáveis de ambiente, explicadas uma a uma. É o único `.env` que vai para o Git. |
| `web/next.config.ts` | Configuração do Next.js: cabeçalhos de segurança, pasta de montagem, origens aceitas em desenvolvimento. |
| `web/playwright.config.ts` | Configuração dos testes de navegador: as duas telas, os servidores de mentira e a pasta de montagem dos testes (`.cache/next-e2e`). |
| `web/eslint.config.mjs` | Regras de estilo do código. |
| `web/tsconfig.json`, `web/tsconfig.testes.json` | Regras do TypeScript do painel e dos testes dele. |
| `web/package.json` | Dependências e comandos do painel. |
| `web/vercel.json` | Diz à Vercel para rodar o servidor em São Paulo (`gru1`). |
| `web/public/ienvia-icone.png`, `ienvia-logo.png`, `pwa/192.png`, `pwa/512.png` | A marca e os ícones do aplicativo. |

### 8.8 `web/src/app/` — as telas e as portas do servidor

| Arquivo | O que é |
| --- | --- |
| `layout.tsx` | A página-mãe de todo o site: título, tema e idioma. |
| `globals.css` | Junta os arquivos de visual, na ordem certa. |
| `page.tsx` | A raiz do site: manda para o painel. |
| `not-found.tsx` | A página "não encontrada". |
| `manifest.ts` | Permite instalar o painel na tela inicial do celular. |
| `icon.png` | O ícone da aba do navegador. |
| `acoes-de-sessao.ts` | "Sair": encerra a sessão. |
| `login/page.tsx`, `login/formulario.tsx`, `login/acoes.ts` | A tela de login, o formulário e a ação de entrar. |
| `(painel)/layout.tsx` | A moldura de todas as abas. Só entra quem está logado. |
| `(painel)/error.tsx` | Quando uma aba quebra, o resto do painel continua de pé. |
| `(painel)/acoes-da-ia.ts` | "Pausar tudo" e retomar a IA. |
| `(painel)/[aba]/page.tsx` | As abas que ainda não foram refeitas: avisam em que fase ficam prontas. |
| `(painel)/visao-geral/page.tsx`, `saudacao.tsx`, `loading.tsx` | A Visão geral, a saudação com relógio e a tela de espera. |
| `(painel)/instancias/page.tsx` | A aba Instâncias (carrega os chips). |
| `(painel)/instancias/painel-de-chips.tsx` | A tela dos chips: adicionar, QR Code, apelido, função, IA do chip. |
| `(painel)/instancias/acoes.ts` | As ações dos chips no servidor: adicionar, salvar, gerar QR Code, conferir, desconectar, remover, ligar a IA. |
| `(painel)/inbox/page.tsx` | A aba Inbox (carrega a lista e a conversa). |
| `(painel)/inbox/painel-da-inbox.tsx` | A tela da Inbox inteira: lista, conversa, balões, anexos, faixa da IA, ficha do contato. |
| `(painel)/inbox/janela-de-ensino.tsx` | A janela do "corrigir resposta em 1 clique". |
| `(painel)/inbox/acoes.ts` | As ações da Inbox no servidor: enviar texto e arquivo, buscar arquivo, confirmar envio, mudar a conversa, ensinar a IA. |
| `(painel)/inteligencia-artificial/page.tsx` | A aba Motor de IA. |
| `(painel)/inteligencia-artificial/painel-do-motor.tsx` | A tela do Motor de IA: os três provedores, a ordem de uso e o comportamento. |
| `(painel)/inteligencia-artificial/acoes.ts` | Salvar o motor, guardar e remover chave, testar o provedor, buscar os modelos. |
| `(painel)/treinamento/page.tsx` | A aba Treinamento. |
| `(painel)/treinamento/painel-de-treinamento.tsx` | A tela do Treinamento: bases, identidade, regras, perguntas e arquivos. |
| `(painel)/treinamento/acoes.ts` | Salvar, criar e apagar base, base padrão, base do chip, anexar e apagar arquivo, ver instruções. |
| `api/webhooks/evolution/route.ts` | A porta de entrada dos avisos da Evolution. É aqui que o atendente de IA começa a responder. |
| `api/inbox/versao/route.ts` | Responde "mudou alguma coisa na Inbox?". A consulta mais barata do painel. |
| `api/inbox/midia/[...caminho]/route.ts` | Mostra ou baixa um arquivo da Inbox, só para quem pode ver. |

`web/src/proxy.ts` é o porteiro: roda antes de toda página, renova a sessão e manda para o login quem não entrou.

### 8.9 `web/src/components/` — peças das telas

| Arquivo | O que é |
| --- | --- |
| `casca/casca.tsx` | A moldura: menu lateral, barra do topo, gaveta e barra inferior do celular. |
| `casca/controle-da-ia.tsx` | O botão de emergência "Pausar tudo" e o aviso "IA pausada". |
| `casca/menu-da-conta.tsx` | O menu da conta, com o tema e o "Sair". |
| `tema/raiz-do-tema.tsx` | Guarda e troca o tema escuro ou claro. |
| `configuracao-pendente.tsx` | A tela mostrada quando o painel sobe sem as variáveis do Supabase. |
| `ui/icone.tsx` | Os ícones do painel. |
| `ui/dialogo.tsx` | A janela por cima da tela. |
| `ui/interruptor.tsx` | O liga/desliga com título e explicação. |
| `ui/campo-de-texto.tsx` | O campo de texto com contador de caracteres. |

### 8.10 `web/src/lib/` — as regras e o acesso aos dados

Nenhuma tela fala com o banco direto: passa por aqui.

| Arquivo | O que é |
| --- | --- |
| `env.ts` | Leitura das variáveis de ambiente, num lugar só. |
| `sessao.ts` | Quem está logado, de qual empresa e com qual papel. |
| `cookies.ts` | As regras dos cookies (sessão, tema, empresa escolhida). |
| `navegacao.ts` | O menu do painel inteiro, numa lista só. |
| `fases.ts` | As fases do plano, para as telas "em construção". |
| `redirecionamento.ts` | Para onde ir depois do login (só endereços do próprio painel). |
| `formato.ts`, `tempo.ts`, `tema.ts` | Pequenas funções de texto, de data e do tema. |
| `supabase/servidor.ts` | Acesso ao banco como o usuário logado. |
| `supabase/servico.ts` | Acesso ao banco com a chave do servidor (só para os avisos, os arquivos e o atendente). |
| `supabase/deposito.ts` | O endereço do depósito de arquivos visto pelo navegador. |
| `dados/visao-geral.ts` | Os números da Visão geral. |
| `dados/instancias.ts` | Os chips como a tela mostra. |
| `dados/inbox.ts` | A lista de conversas, a conversa aberta e a versão da Inbox. |
| `dados/ia.ts` | O Motor de IA da empresa. |
| `dados/treinamento.ts` | As bases de treinamento da empresa. |
| `dados/atendente.ts` | Como está a IA da empresa: pausada ou não, em quantos chips, o que falta. |
| `instancias/regras.ts` | Regras dos chips: função, estado, apelido, telefone. |
| `evolution/cliente.ts` | A conversa com a Evolution: criar chip, QR Code, enviar texto e arquivo. |
| `evolution/aviso.ts` | Entende os avisos que a Evolution manda. |
| `inbox/regras.ts` | Regras da Inbox: filtros, busca, ritmo das consultas. |
| `inbox/arquivos.ts` | Regras dos arquivos: tipos, tamanhos, o que vai como documento. |
| `inbox/buscar-arquivo.ts` | Traz para o depósito o arquivo de uma mensagem que chegou. |
| `ia/regras.ts` | Regras do Motor de IA: valores permitidos, padrões, textos da tela. |
| `ia/cofre.ts` | O cofre das chaves de IA: cifra e abre com o segredo do servidor. |
| `ia/provedores.ts` | A conversa com o Gemini, o OpenRouter e a NVIDIA. |
| `ia/treinamento.ts` | Regras do Treinamento: campos, limites, arquivos de conhecimento. |
| `ia/instrucoes.ts` | Monta as instruções que a IA recebe e lê os comandos que ela escreve. |
| `ia/ensino.ts` | Regras de ensinar a IA pela conversa. |
| `ia/modelos-prontos.json` | Os nove modelos prontos de treinamento, por ramo. |
| `atendente/atendente.ts` | O atendente em si: espera o cliente, pede a resposta, envia em balões, encerra a vez. |
| `atendente/regras.ts` | Regras do atendente: o que a IA lê, os balões, o tempo de "digitando…". |
| `atendente/painel.ts` | O que as telas mostram sobre a IA: o resumo e a faixa de cada conversa. |

### 8.11 `web/src/styles/` — o visual

| Arquivo | O que é |
| --- | --- |
| `tokens.css` | Cores, cantos, sombras. Tema escuro e claro. |
| `base.css` | A base: texto, foco, campos, barra de rolagem. |
| `componentes.css` | Peças reutilizadas: botão, painel, formulário, pílula, janela. |
| `casca.css` | A moldura: menu, topo e a navegação do celular. |
| `apoio.css` | Telas de apoio: aba em construção, não encontrada, erro. |
| `login.css`, `visao-geral.css`, `instancias.css`, `inbox.css`, `motor-de-ia.css`, `treinamento.css` | Um arquivo por tela. |

### 8.12 `web/e2e/` — testes de navegador

| Arquivo | O que confere |
| --- | --- |
| `login.spec.ts` | Entrar e sair. |
| `painel.spec.ts` | Visão geral, navegação no computador e no celular, tema. |
| `instancias.spec.ts` | A tela de chips, do começo ao fim. |
| `inbox.spec.ts` | A Inbox, do começo ao fim, com texto e arquivos. |
| `motor-de-ia.spec.ts` | A tela do Motor de IA. |
| `treinamento.spec.ts` | A tela do Treinamento. |
| `atendente.spec.ts` | A IA nas telas: ligar no chip, Pausar tudo, a faixa da conversa, assumir e devolver. |
| `ensino.spec.ts` | Corrigir resposta e ensinar a IA pela Inbox. |
| `acessibilidade.spec.ts` | Contraste, rótulos e estrutura das telas prontas. |
| `apoio/supabase-falso.mjs` | Um "Supabase de mentira", com contas inventadas e depósito de arquivos. |
| `apoio/ia-no-banco-falso.mjs` | A parte de IA desse Supabase de mentira. |
| `apoio/evolution-falsa.mjs` | Uma "Evolution de mentira". |
| `apoio/ia-falsa.mjs` | Uma "IA de mentira": imita o Gemini, o OpenRouter e a NVIDIA. |
| `apoio/dados.mjs` | Os dados inventados dos testes (contas, chips, conversas). |
| `apoio/chaves-de-ia.mjs` | As chaves que a IA de mentira reconhece. Nenhuma é de verdade. |
| `apoio/arquivos-de-exemplo.mjs` | Uma foto, uma figurinha, um áudio e um PDF pequenos, criados na hora. |
| `apoio/sessao.ts` | Faz login pela tela, como uma pessoa. |
| `apoio/*.d.mts` | Descrições de tipos dos arquivos acima. |

### 8.13 `web/test/` e `web/test-com-banco/` — testes de regras

| Arquivo | O que confere |
| --- | --- |
| `configuracao.test.ts` | Cookies, configuração do Supabase, tema, fases, endereço do depósito, registros do servidor. |
| `navegacao.test.ts`, `redirecionamento.test.ts` | O menu e o destino depois do login. |
| `formato.test.ts`, `tempo.test.ts` | Textos e datas. |
| `instancias.test.ts` | Regras dos chips. |
| `evolution.test.ts` | O painel conversando com a Evolution de mentira. |
| `aviso.test.ts` | A leitura dos avisos da Evolution. |
| `rota-de-avisos.test.ts` | A porta de entrada dos avisos. |
| `inbox.test.ts` | Regras da Inbox. |
| `rota-da-versao.test.ts` | A rota do "mudou alguma coisa?". |
| `arquivos.test.ts`, `buscar-arquivo.test.ts`, `rota-da-midia.test.ts` | Regras dos arquivos, a busca do arquivo recebido e a rota que mostra um arquivo. |
| `ia-regras.test.ts`, `cofre.test.ts`, `provedores.test.ts` | Regras do Motor de IA, o cofre das chaves e a conversa com os provedores. |
| `treinamento.test.ts`, `instrucoes.test.ts` | Regras do Treinamento e as instruções que a IA recebe. |
| `atendente-regras.test.ts`, `atendente-painel.test.ts`, `atendente.test.ts` | Regras do atendente, o que as telas mostram e o atendente contra o relógio. |
| `ensino.test.ts` | Ensinar a IA pela conversa. |
| `apoio/vazio.ts` | Arquivo de apoio dos testes. |
| `../test-com-banco/atendente.test.ts` | O atendente de ponta a ponta, com o banco de teste. |

### 8.14 Fora do repositório: `apoio-da-reconstrucao/`

Não faz parte do sistema. São os materiais de trabalho do assistente.

| Arquivo | O que é |
| --- | --- |
| `LEIAME.md` | O diário técnico: o que foi feito em cada etapa, o que foi descoberto e as armadilhas. |
| `preparar.sh` | Recria o ambiente de trabalho numa máquina nova (Node, navegador de testes, dependências). |
| `evolution-respostas-reais-v2.3.7.txt` | Respostas de verdade da Evolution, usadas para fazer a Evolution de mentira responder igual. |
| `ia-respostas-reais.txt` | Respostas de verdade dos provedores de IA, com o mesmo fim. |
| `fotos-do-novo/` | 67 fotos das telas do sistema novo, a cada entrega. As que começam com `real-` são do ambiente de verdade. |
| `fotos-referencia/` | 12 fotos do visual escolhido, para comparar. |

Ferramentas (`apoio-da-reconstrucao/ferramentas/`):

| Arquivo | O que faz |
| --- | --- |
| `enviar-ao-github.sh` | Envia o repositório para o GitHub. |
| `painel-com-dados-de-exemplo.sh` | Sobe o painel com dados inventados, para olhar as telas. É a prévia que aparece ao lado do chat. |
| `painel-com-dados-reais.sh` | Sobe o painel ligado ao banco e à Evolution de verdade. |
| `painel-teste.sh` | Sobe o painel de teste na porta 3100, usado pelas ferramentas de fotos e de contraste. |
| `supabase_admin.py` | Acesso de administração ao projeto novo do Supabase. |
| `montar-banco-novo.py` | Mostra o estado do banco, ensaia e aplica migrações, tira e compara o retrato. |
| `restaurar-bagagem.py` | Levou os logins e as empresas para o banco novo. Já foi usado; não rodar de novo. |
| `rodar-conferencia-no-banco-real.py` | Roda um roteiro de conferência no banco de verdade e mostra o relatório. |
| `conferir-arquivos-no-banco-real.sql`, `conferir-ia-no-banco-real.sql`, `conferir-atendente-no-banco-real.sql`, `conferir-ensino-no-banco-real.sql` | Os roteiros de conferência direto no banco. Cada um desfaz tudo no final. |
| `conferir-arquivos-no-ambiente-real.mjs`, `conferir-ia-no-ambiente-real.mjs`, `conferir-atendente-no-ambiente-real.mjs`, `conferir-ensino-no-ambiente-real.mjs` | As conferências pelo navegador, no ambiente de verdade. Apagam o que criam. |
| `gerar-migracao-do-atendente.py`, `atendente-parte-nova.sql` | Montaram a migração do atendente. Já usados; recusam rodar de novo. |
| `gerar-migracao-do-ensino.py`, `ensino-parte-nova.sql` | Montaram a migração de ensinar a IA. Já usados; recusam rodar de novo. |
| `gerar-modelos-prontos.mjs` | Gerou os nove modelos prontos a partir do painel antigo. |
| `fotos-da-inbox-com-arquivos.mjs`, `fotos-do-motor-de-ia.mjs`, `fotos-do-treinamento.mjs`, `fotos-do-atendente.mjs`, `fotos-do-ensino.mjs` | Tiram as fotos das telas. |
| `shot-novo.mjs`, `shot-painel.mjs`, `shot-ref.mjs`, `extrair-css.mjs`, `axe-detalhe.mjs` | Comparação com o visual de referência e detalhe dos problemas de contraste. |
| `digital-local.mjs`, `indices-local.mjs` | Mostram o retrato e os índices do banco de teste, para comparar com o de verdade. |
| `teste-embutido.mjs`, `teste-origem.mjs`, `teste-real.mjs` | Pequenos testes da prévia e do caminho de verdade. |
| `tamanho-da-area-de-trabalho.py` | Mede o que conta para o limite da área de trabalho (128 MB). |
| `fazer-copia-de-seguranca.py` | Monta a cópia de segurança que vai para o Google Drive. |
| `gerar-documentacao.py` | Transforma este documento em página e em PDF. |

### 8.15 Fora do repositório: as credenciais

Estes arquivos nunca vão para o Git. Na cópia de segurança, ficam dentro de `credenciais-fechadas.7z`, com senha.

| Arquivo | O que é |
| --- | --- |
| `.env` | Todas as credenciais do projeto, com a explicação de cada uma. |
| `.env.antes-da-mudanca` | Os valores antigos, de antes da mudança de banco. |
| `ienvia/web/.env.local` | As variáveis do painel quando roda na área de trabalho ligado ao banco de verdade. |
| `ienvia/web/.env.local.antes-da-mudanca` | O mesmo arquivo, de antes da mudança de banco. |
| `bagagem-do-banco-novo.json` | Os logins e as empresas levados para o banco novo. |

O que há no `.env` (só os nomes):

| Nome | O que é |
| --- | --- |
| `GITHUB_TOKEN`, `GITHUB_USUARIO` | Acesso ao GitHub do dono. |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` | O servidor dos chips. Regra: só criar ou apagar chips cujo nome começa com `ienvia-`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | O banco novo e a chave do servidor. |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJETO_NOVO` | Acesso de administração ao projeto `ienvia-001`. |
| `TESTE_USUARIO`, `TESTE_SENHA`, `TESTE_WORKSPACE`, `TESTE_USUARIO_ID` | A conta de teste no banco novo. |
| `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY` | As chaves de IA do dono, para os testes de verdade. |
| `IENVIA_CHAVE_DOS_SEGREDOS` | O segredo de produção que cifra as chaves de IA dos clientes. Se for perdido, as chaves guardadas não abrem mais. |
| `VERCEL_TOKEN_CONTA_NOVA` | O token da conta nova da Vercel. |
| `SENHA_DA_COPIA_DE_SEGURANCA` | A senha do arquivo fechado das cópias de segurança. |

### 8.16 O que não é guardado

Dependências (`node_modules`), montagens (`.next`) e caches (`.cache`) não vão para o Git nem para a
cópia de segurança. Refazem-se sozinhos com `npm install` e com os comandos de teste.

---

## 9. Como continuar a partir daqui

### Para ver o sistema

- **Com dados inventados** (não mexe em nada de verdade): `bash apoio-da-reconstrucao/ferramentas/painel-com-dados-de-exemplo.sh 3000`.
  Entrar com o usuário `inbox` (dona), `colega` (atendente) ou `dona` (outra empresa). A senha de
  todos é `senha-de-teste-123`. São contas de mentira, que só existem nessa demonstração.
- **Com o banco de verdade**: `bash apoio-da-reconstrucao/ferramentas/painel-com-dados-reais.sh 3000`. Tudo o que for feito ali vale de verdade.

Os dois usam as mesmas portas dos testes. Pare o painel antes de rodar `npm run verificar`.

### Para montar o ambiente do zero

1. Extrair a cópia de segurança numa pasta vazia (no ambiente do assistente, `/home/user`).
2. Abrir `credenciais-fechadas.7z` com a senha e extrair no mesmo lugar.
3. Rodar `bash apoio-da-reconstrucao/preparar.sh`.
4. Na pasta `ienvia`: `npm run verificar`. Tem de passar inteiro antes de qualquer mudança.

Também dá para começar só pelo GitHub (`git clone` do repositório privado e `npm install`). Nesse caso
faltam as credenciais e os materiais de apoio, que só existem na cópia de segurança.

### Para continuar o trabalho

1. Ler a seção 2 (decisões) e a seção 6 (pendências) do PLANO.md.
2. Ler o fim do `apoio-da-reconstrucao/LEIAME.md`: as armadilhas já encontradas poupam horas.
3. O próximo passo do plano é o resto da Fase 2: Mensagens prontas e Skills.
4. Seguir o caminho de cada entrega (seção 2 deste documento).

### O que não fazer

- Não editar nem aplicar de novo uma migração que já foi aplicada. Toda mudança é um arquivo novo.
- Não escrever no banco antigo.
- Não publicar sem os testes, e não mandar mensagem de teste para número de verdade.
- Não reenviar sozinho uma mensagem cujo envio ficou incerto.
- Não copiar valores do `.env` para o código, para os testes ou para documentos.
- Não mexer em chips da Evolution cujo nome não começa com `ienvia-`.

---

## 10. Pequeno dicionário

| Palavra | O que quer dizer aqui |
| --- | --- |
| Chip ou instância | Um número de WhatsApp ligado ao sistema. |
| Evolution | O servidor que mantém os chips do WhatsApp ligados na nuvem. |
| Aviso (webhook) | O recado que a Evolution manda ao painel quando chega uma mensagem ou um chip conecta. |
| Supabase | O serviço onde fica o banco de dados, o login e o depósito de arquivos. |
| Migração | Um arquivo com uma mudança do banco. Elas são aplicadas em ordem. |
| Retrato do banco | Um resumo do banco, usado para conferir que o banco de verdade é igual ao do Git. |
| RLS | A trava do banco que faz cada empresa enxergar só os próprios dados. |
| Empresa (workspace) | A conta de um cliente. Tudo é separado por empresa. |
| Dono e equipe | O dono da conta mexe em chips, IA e treinamento. A equipe atende. |
| Base de treinamento | O que a IA sabe: identidade, regras, perguntas frequentes e arquivos. |
| Vez da IA | O momento em que a IA responde uma mensagem, do começo ao fim. |
| Vercel | O serviço de hospedagem onde o painel foi publicado em 11/11. |
| Prévia | O painel rodando na área de trabalho do assistente. Só quem está no chat vê. |
| Commit | Um ponto gravado no histórico do código. |
