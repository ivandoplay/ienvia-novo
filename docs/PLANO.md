# Plano de reconstrução do Ienvia

Este documento é o mapa do trabalho: o que está sendo feito, em que ordem e com quais regras.
É atualizado a cada fase concluída.

## 1. O que estamos fazendo

O Ienvia antigo (`zap-ia-studio`, versão 5.8) funciona, mas cresceu sem ordem: um arquivo só com
136 rotas, o painel inteiro em um arquivo de mais de 10 mil linhas, 14 cópias geradas da mesma
página e 73 documentos soltos. Mexer em uma parte quebrava outra.

A decisão foi **refazer do zero, lendo o antigo e reescrevendo limpo**, em vez de remendar.
O antigo fica intacto, como referência e como cópia de segurança, até a virada final.

## 2. Decisões já tomadas

Respondidas por você nos três questionários:

| Assunto | Decisão |
| --- | --- |
| Motores do WhatsApp | Os dois continuam: Evolution (na nuvem) e o motor local (no aparelho do cliente). |
| Função de cada chip | Livre por chip: atendimento, campanha ou os dois, com qualquer um dos motores. |
| Motor local | Roda no aparelho de cada cliente (celular com Termux ou PC). Instaladores e atualização automática continuam. |
| Banco de dados | O Supabase novo "Ienvia" (São Paulo). Contas, contatos e conversas do antigo serão migrados; o antigo fica como cópia. |
| Ordem | Atendimento primeiro: entrar → conectar o chip → Inbox → atendente de IA e Treinamento. Depois Campanhas, Catálogo/PIX, Áudios, Simulador e Contas. |
| Funcionalidades | Enxugar, mostrando a lista antes de cortar: [O-QUE-FICA-E-O-QUE-SAI.md](./O-QUE-FICA-E-O-QUE-SAI.md). |
| Visual | O do branch `feat/modernizacao-painel-oficial`. |
| Pessoas por conta | Um login por cliente agora; o banco já está pronto para equipe depois. |
| Chaves de IA | Cada cliente usa as suas: Google Gemini, OpenRouter e **NVIDIA** (a NVIDIA entrou em 11/11/2026, a seu pedido, como opção gratuita). |
| Repositório | Novo e **privado** no GitHub: `ivandoplay/ienvia-novo`. O repositório antigo e a primeira tentativa (`ivandoplay/ienvia`) não foram tocados. |
| Lista de cortes | Aprovada em 11/11/2026, como está em [O-QUE-FICA-E-O-QUE-SAI.md](./O-QUE-FICA-E-O-QUE-SAI.md). |
| Skills | Ficam: Estúdio de Skills, "Cérebro completo" e "Pacote Turbo" (você usa). Entram com o Treinamento. |
| Ligar a IA | Em cada chip. No topo, só o botão de emergência "Pausar tudo". Religar é sempre chip por chip. |
| Histórico | Deixa de ser aba: vira o filtro "ver por chip" dentro da Inbox (decisão que você deixou comigo). |
| Mudanças no banco novo | Você deixou comigo. Regra: testo aqui primeiro, aplico no banco "Ienvia" e aviso no resumo da entrega. Se a mudança **apagar** algum dado que já existe, eu pergunto antes. No banco antigo eu só leio, nunca escrevo. |
| Credenciais | Tudo o que você me mandar fica guardado num arquivo `.env` **fora** deste repositório (nunca vai para o GitHub) e pode ser usado nos testes e nas publicações sem eu pedir de novo. |

Regras suas que já estavam escritas nos documentos antigos e que continuam valendo:

- Tudo em português do Brasil.
- Uma empresa nunca enxerga os dados de outra.
- **Nunca reenviar sozinho** depois de um envio incerto.
- Todo chip novo nasce **pausado, com a IA desligada**. Quem liga é o dono, num botão explícito.
- Um número pode ter os dois motores, mas **sem troca silenciosa** de um para o outro.
- Quem cria as contas é o administrador (não existe cadastro aberto).
- Campanha é um disparo único, com prévia e confirmação.
- Mensagens guardadas por 60 dias e mídias por 30 (ajustável por empresa).
- No banco **antigo** (o que está em produção hoje) nada muda. No banco novo vale a regra da tabela acima.

## 3. Como o novo está organizado

Um repositório só, dividido em gavetas que não se misturam:

```
ienvia/
├── web/        O painel (o que o cliente abre no navegador) e, mais adiante, a API.
├── shared/     Regras usadas pelo painel e pelo motor local. Código puro, sem rede.
├── supabase/   O banco: as migrações (cada mudança, em ordem) e os testes de segurança.
├── motor/      O motor local do WhatsApp — entra na Fase 4.
└── docs/       Este plano e a lista do que fica e do que sai.
```

Dentro do painel (`web/src`), cada coisa tem um endereço previsível:

| Pasta | O que mora ali |
| --- | --- |
| `app/` | Uma pasta por tela. `app/login`, `app/(painel)/visao-geral`... Uma aba nova é uma pasta nova. |
| `components/casca/` | A moldura comum a todas as abas: menu lateral, barra do topo, menu do celular, menu da conta. |
| `components/ui/` | Peças pequenas reutilizadas (ícones, por enquanto). |
| `lib/` | Regras e acesso a dados: sessão, menu, cookies, formatação. Nenhuma tela fala com o banco direto; passa por aqui. |
| `styles/` | O visual, portado do branch escolhido: cores (`tokens.css`), base, peças, moldura e um arquivo por tela. |
| `proxy.ts` | O porteiro: roda antes de toda página, renova a sessão e manda para o login quem não entrou. |

Três princípios que evitam a bagunça voltar:

1. **Uma coisa, um lugar.** O menu inteiro é uma lista (`lib/navegacao.ts`); a moldura é um arquivo; cada tela é uma pasta.
2. **A segurança fica no banco.** O painel conversa com o banco *como o usuário logado*. Mesmo que
   uma tela tenha um erro, o banco não entrega dados de outra empresa (isso se chama RLS e é testado).
3. **Nada entra sem teste.** Cada fase termina com os testes passando, e o que já funcionava continua testado.

### Tecnologia (para quem for mexer no código)

- Next.js 16 (App Router) + React 19 + TypeScript, em `web/`.
- Supabase (Postgres + Auth). Sessão em cookie `httpOnly`, lida só pelo servidor (`@supabase/ssr`).
- CSS próprio, portado à mão do branch visual (sem Tailwind).
- Testes: Vitest (regras e banco, com PGlite — um Postgres de verdade em memória) e Playwright (navegador), mais axe para acessibilidade.
- Node 22.12 ou mais novo (recomendado: 24).

### O banco

O Supabase "Ienvia" já tinha um esquema bom, feito na sua tentativa anterior (`ivandoplay/ienvia`):
20 tabelas com a trava de linhas ligada em todas. **Aproveitei esse esquema como está.**

As 9 migrações que estavam aplicadas no banco foram trazidas para `supabase/migrations/`, byte a
byte (5 delas não estavam em nenhum repositório). Um teste compara o banco montado a partir
desses arquivos com um retrato do banco real: se alguém mudar o banco por fora, ou editar uma
migração antiga, o teste acusa.

Regra daqui para a frente: **migração aplicada não se edita**. Toda mudança é um arquivo novo.

## 4. As fases

Cada fase só começa quando a anterior está com os testes passando.

| Fase | Nome | O que entrega | Situação |
| --- | --- | --- | --- |
| 0 | Fundação | Repositório novo, login, moldura do painel com o visual escolhido, Visão geral com números reais, testes. | **Pronta** |
| 1 | Conectar e conversar | **Instâncias**: conectar chip por QR/código (Evolution primeiro), apelido e função do chip. **Inbox**: lista de conversas, abrir conversa, enviar texto e mídia, ficha básica do contato, ver por chip (o antigo Histórico). Recebimento das mensagens. | **Pronta no código e no banco; falta conferir no ar.** Feitos e testados: Instâncias, recebimento das mensagens e a Inbox com texto e com **arquivos** (fotos, áudios, vídeos, documentos e figurinhas). A conferência final com os serviços de verdade está **travada por dois bloqueios de conta** (Vercel e Supabase): ver o começo da seção 6. |
| 2 | Atendente de IA | **Treinamento** (identidade, regras, FAQ, arquivos) e **Motor de IA** (chaves do cliente, provedor, reserva). A IA responde, passa para você quando precisa, e você corrige uma resposta em 1 clique. Na Inbox: assumir uma conversa e devolver para a IA. Liga/desliga da IA em cada chip e o botão "Pausar tudo". | **Em andamento.** Prontas: as telas **Motor de IA** (Gemini, OpenRouter e NVIDIA) e **Treinamento** (identidade, regras, perguntas frequentes, arquivos, modelos prontos e várias bases). Falta: o atendente em si (a IA ainda **não responde** no WhatsApp), as Skills e as Mensagens prontas. Detalhes abaixo. |
| 3 | CRM completo | Etiquetas, Kanban, agenda de contatos, valor e ganho/perdido, notas, busca, respostas rápidas, agendar envio. **Histórico**. | |
| 4 | Motor local | O motor que roda no PC ou no Termux, ligado à conta do cliente, com atualização automática assinada. Aba **Conexões / Motor**. | |
| 5 | Campanhas e segurança | **Campanhas** com prévia, cadência segura, rodízio de chips, pausar/retomar. **Segurança**: anti-ban, fila segura, horário de atendimento, contatos ignorados, alerta no seu WhatsApp. | |
| 6 | Catálogo, áudios e simulador | **Catálogo & PIX**, **Áudios** na sua voz, **Simulador**. | |
| 7 | Contas, configurações e migração | **Clientes SaaS** (criar contas, limites, modo suporte com registro), **Configurações**, exportar dados. Migração dos dados do banco antigo. | |
| 8 | Virada | O endereço de produção passa a apontar para o novo. O antigo é desligado só depois de você conferir. | |

Observação sobre a ordem: a Fase 1 já traz a ficha básica do contato. O Kanban e os extras do
CRM estão na Fase 3, logo depois da IA. Se preferir o CRM completo *antes* da IA, as fases 2 e 3
trocam de lugar sem prejuízo.

### O que a Fase 0 entregou

- **Login** com usuário ou e-mail e senha. O usuário simples vira um e-mail interno
  (`joao` → `joao@zapia.local`), o mesmo formato do sistema antigo, para as contas migradas
  continuarem entrando com o mesmo usuário e a mesma senha.
- **Moldura do painel** igual à do branch visual: menu lateral, barra do topo, tema escuro e claro,
  gaveta e barra inferior no celular, menu da conta com "Sair".
- **Visão geral** com números reais do banco: conversas esperando você, IA ligada, campanhas
  ativas, chips online, mensagens de hoje, contatos e o funil.
- **As outras 12 abas** aparecem no menu e avisam, com honestidade, em que fase ficam prontas.
  Nenhuma finge funcionar. (Eram 13: o "Histórico" virou um filtro da Inbox.)
- **Testes** (os números exatos estão no [README](../README.md)):
  - regras do painel e do login;
  - banco: uma empresa não vê a outra, o que o navegador não pode fazer, o que cada papel pode;
  - navegador: login, sair, navegação no computador e no celular, tema, página não encontrada;
  - acessibilidade: contraste e rótulos nas telas prontas, nos dois temas.

### O que a Fase 1 entregou

- **Instâncias**: adicionar chip (QR Code ou código de 8 dígitos), apelido, função, desconectar,
  remover. Só o dono da conta mexe nos chips; cada conta tem um limite de chips.
- **Recebimento**: a Evolution avisa o painel a cada mensagem que chega, a cada mensagem que sai e
  quando um chip conecta ou cai. Cada chip tem um segredo próprio; aviso sem o segredo certo não
  grava nada. Mensagem repetida não é gravada duas vezes.
- **Inbox**:
  - lista das conversas com as não lidas em destaque; filtros **Ativas**, **Não lidas**,
    **Esperando você** e **Resolvidas**; **Ver por chip** (inclusive chips já removidos: é o antigo
    Histórico); busca por nome, telefone ou texto da última mensagem;
  - conversa aberta com as mensagens em balões, dizendo quem respondeu (você, a equipe, pelo
    celular do chip e, na Fase 2, a IA); abrir marca como lida; mensagem nova entra sozinha, sem
    recarregar a página (a tela confere a cada poucos segundos);
  - responder com texto; **resolver** e **reabrir**; ficha básica do contato;
  - no celular, a lista e a conversa ocupam a tela inteira, uma de cada vez.
- **Arquivos na Inbox** (fotos, áudios, vídeos, documentos e figurinhas):
  - **receber**: a Evolution avisa que chegou um arquivo; o painel grava a mensagem na hora e, logo
    depois, busca o arquivo e guarda num **depósito fechado** (não é público). Na conversa, a foto
    aparece (um clique abre grande, com botão de baixar), o áudio e o vídeo tocam ali mesmo (com um
    "Baixar" ao lado, para quando o navegador não souber tocar), o documento vira um link com o nome
    original e a figurinha aparece pequena. Enquanto o arquivo não chega, a conversa diz que está
    trazendo; se não deu, explica o motivo e oferece **"Buscar de novo"**;
  - **enviar**: pelo botão de anexar, arrastando o arquivo para o campo ou colando uma imagem
    (Ctrl+V). Dá para escrever uma legenda e tirar o anexo antes de enviar. O arquivo sobe direto
    do navegador para o depósito, mostrando o andamento; se a subida falhar, nada é enviado e
    aparece "Tentar de novo";
  - **limites**: foto, vídeo e áudio até 16 MB (o limite do WhatsApp); documento até 25 MB. Vídeo
    acima de 16 MB vai como documento, e a tela avisa antes de enviar. Áudio vai como **mensagem de
    voz**, sem legenda (o texto que estava escrito fica no campo, para ir numa mensagem seguinte).
    Figurinha só se recebe. Foto, vídeo ou áudio de "visualização única" não são guardados: aparece
    só o aviso de que chegou. Arquivo recebido acima de 25 MB também não é guardado: a conversa
    manda ver no celular do chip;
  - **quem vê**: só quem participa da empresa. O endereço de cada arquivo é emitido pelo servidor a
    cada pedido, vale por 1 hora e só sai para quem está logado e é daquela empresa. Para qualquer
    outra pessoa o arquivo "não existe". Ninguém troca nem apaga um arquivo já guardado;
  - a lista de conversas mostra o que chegou: "📷 Foto: legenda", "🎤 Áudio", "📄 nome do documento".
- **Regras do envio** (decididas nesta fase):
  - qualquer pessoa ativa da empresa responde; chips continuam sendo só do dono;
  - o painel **nunca reenvia sozinho**. Cada mensagem leva uma chave única criada no navegador;
    pedido repetido com a mesma chave não gera segundo envio;
  - quando a Evolution não confirma o envio, a mensagem fica **"sem confirmação"**: a pessoa
    confere no WhatsApp do chip e marca "foi enviada" ou "não foi enviada". Se o aviso da
    Evolution chegar depois, a mensagem é confirmada sozinha;
  - conversa resolvida não recebe resposta, mas pode ser reaberta. Se o cliente escrever de novo
    depois de resolvida, nasce uma conversa nova;
  - o que é digitado direto no celular do chip também aparece na conversa;
  - envio comum que deu certo não vai para o registro de auditoria (seria uma linha por
    mensagem); falha, "sem confirmação", resolver e reabrir vão.
  - **arquivo segue as mesmas regras do texto**: uma chave por envio, nunca reenvia sozinho, fica
    "sem confirmação" quando a Evolution não responde. A diferença: um arquivo que não foi enviado
    precisa ser anexado de novo (o painel não guarda o arquivo de um envio que falhou para reenviar).

### O que a Fase 2 entregou até aqui (12/11/2026)

**A IA ainda não responde ninguém.** O que existe são as telas **Motor de IA** (guarda e testa as
chaves e os ajustes) e **Treinamento** (guarda o que a IA sabe e mostra as instruções que ela vai
receber). As duas dizem isso com todas as letras enquanto o atendente não estiver pronto.

#### Motor de IA

- **Três provedores**, cada um com o seu cartão: **Google Gemini**, **OpenRouter** e **NVIDIA**.
  Em cada cartão: cadastrar, trocar, testar e remover a chave; escolher o modelo (digitando ou pela
  lista que o próprio provedor devolve).
- **A chave de cada cliente fica cifrada.** O painel cifra a chave antes de gravar no banco, com um
  segredo que só o servidor conhece (`IENVIA_CHAVE_DOS_SEGREDOS`). No banco fica só o texto cifrado
  e os 4 últimos caracteres. Depois de cadastrada, a chave não volta para a tela de ninguém, e
  só o dono da conta vê os 4 últimos caracteres. O banco recusa qualquer coisa que pareça uma chave
  em texto puro.
- **Ordem de uso**: provedor principal, reserva e segunda reserva (as duas últimas são opcionais).
  Se o principal falha numa mensagem, a reserva assume aquela resposta. A tela avisa de qual
  provedor falta chave.
- **Comportamento nas conversas**: mostrar "digitando…", dividir respostas longas, parar a IA quando
  uma pessoa responde (e em quanto tempo ela volta), esperar o cliente terminar de escrever, quanto
  da conversa a IA relê, e a criatividade.
- **Só o dono da conta altera.** A equipe vê como está configurado, sem botões.

#### Treinamento

- **As quatro partes do painel antigo**: Identidade, Regras, Perguntas frequentes e Arquivos, com os
  mesmos campos (inclusive a "atuação individual em 1ª pessoa" e a "trava permanente").
- **Arquivos de conhecimento** (.txt, .csv, .md, .json): só entra texto de verdade, e **inteiro**. Um
  arquivo grande demais (mais de 30 mil caracteres) é recusado com a explicação; nunca entra cortado.
- **Começar com um modelo pronto**: os nove modelos por ramo do painel antigo. O modelo troca os
  textos na tela e só grava quando você salva.
- **Várias bases de treinamento**: criar, abrir, escolher a padrão, apagar, e dizer qual base cada
  chip usa. Quem tem um chip só nem precisa pensar nisso: usa a base "Principal".
- **Ver instruções geradas**: mostra o texto exato que a IA recebe a cada conversa. É o mesmo texto
  que o atendente vai usar.
- **Só o dono da conta altera.** A equipe vê, sem botões.
- Ainda **não refeitos** (a tela avisa): Mensagens prontas (M01–M13), Estúdio de Skills, "Cérebro
  completo", "Pacote Turbo" e "corrigir resposta em 1 clique".

As instruções da IA foram postas à prova com dois modelos de verdade (NVIDIA e OpenRouter), em 14
situações: pergunta que está na base, pergunta que não está, "é um robô?", tentativa de arrancar as
regras, pedido de foto, preço que está num arquivo, "ok, obrigada", recusa, pedido para parar,
desconto forçado e três situações em 1ª pessoa. A primeira rodada achou três defeitos no texto (a IA
passava para uma pessoa perguntas de preço que ela sabia responder; um modelo inventou "não temos
esse produto"; outro disse "vou chamar alguém" sem avisar ninguém). Corrigidos, a segunda rodada
deu 14 de 14 nos dois modelos.

Decisões tomadas nesta parte (diga se quiser diferente):

- **A IA não mente quando perguntam se é um robô.** O painel antigo mandava a IA negar ("nunca
  admita que é uma IA", "sou eu mesmo falando"). O novo não manda. Você escolhe entre duas
  respostas: **passar a conversa para uma pessoa** (padrão: a IA não responde a pergunta, avisa você)
  ou **dizer que é a assistente virtual**. No resto da conversa ela continua escrevendo de forma
  natural, e em 1ª pessoa se você ligar essa opção. Por isso tirei dois trechos dos modelos prontos:
  no modelo do Lizandro, a frase "a pessoa deve sempre saber que está falando diretamente com o
  próprio Lizandro"; no modelo "Profissional Liberal · 1ª Pessoa", a pergunta frequente "Estou
  falando direto com você? → Sim! Sou eu mesmo".
- **A IA só responde o que está escrito no treinamento.** O que não está, ela não chuta: diz que vai
  confirmar e passa para uma pessoa.
- **Por enquanto a IA só escreve texto.** Fotos do catálogo, áudios e PIX são da Fase 6. Até lá, as
  instruções dizem à IA para não prometer envio de foto, arquivo ou PIX: ela passa para uma pessoa.

- **"Modo de rota" saiu; entrou a ordem de uso.** O painel antigo tinha dois modos ("Auto: áudio no
  Gemini, texto no OpenRouter" e "Principal + reserva"). Com três provedores isso virou uma coisa
  só: você escolhe a ordem, e **mensagem de voz vai sempre para o Gemini** (quando ele está na
  ordem e tem chave), porque só ele escuta.
- **Áudio nunca vai para a NVIDIA nem para o OpenRouter.** Testei de verdade: vários modelos da
  NVIDIA recebem o áudio, descartam calados e respondem como se o cliente não tivesse mandado nada.
  Num atendimento, isso seria uma resposta inventada. Sem o Gemini na ordem, a IA não entende áudio.
- **Foto** vai para qualquer um dos três, mas só funciona quando o modelo escolhido enxerga. Modelo
  que só lê texto devolve um erro claro, e o painel passa para o próximo da ordem.
- **Modelo padrão da NVIDIA: `nvidia/nemotron-3.5-super-vl-120b-a12b`.** Escolhido com um teste de
  verdade (instruções de uma loja e quatro perguntas, entre elas uma fora da base e uma tentativa
  de enganar a IA): foi o único que acertou as quatro e respondeu em menos de 1 segundo. Também
  enxerga fotos. O modelo mais rápido de lá (`nemotron-3.5-lightning`) **inventou** uma resposta.
- **Na NVIDIA, o painel pede ao modelo para não "raciocinar" antes de responder.** Sem isso, as
  respostas levam de 10 a 40 segundos (ou nem vêm). Com isso, menos de 1 segundo.
- **A NVIDIA é um serviço de testes.** É gratuita, mas a lista de modelos muda, alguns demoram e
  vários modelos da lista não estão liberados para toda conta. Por isso a tela pede para testar
  depois de escolher, e recomendo deixar o Gemini ou o OpenRouter como reserva.
- **Não trouxe o "pool de chaves extras do Gemini"** (várias chaves grátis para multiplicar a cota).
  No lugar dele há três provedores com reserva. Se fizer falta, diga.
- **Ainda não decidido:** a "mensagem enviada quando a IA está desligada" do painel antigo. Entra
  (ou não) junto com o atendente.
- **Nova opção no Treinamento (ainda sem tela):** o que a IA faz quando perguntam "estou falando com
  um robô?". Padrão: passa a conversa para uma pessoa. Alternativa: admitir que é uma assistente
  virtual. O painel antigo mandava negar; o novo não nega.

O que foi conferido de verdade, e o que não foi:

- **NVIDIA e OpenRouter, com as suas chaves**: teste de conexão, lista de modelos, uma conversa
  curta, foto num modelo que enxerga, foto num modelo que só lê texto, chave errada e modelo que
  não existe. Tudo pelo código do próprio painel, e cada erro virou a frase certa na tela.
- **Gemini: nada conferido com chave boa.** A chave que você mandou é recusada pelo Google com
  "API key was reported as leaked" (o Google bloqueia sozinho uma chave que encontra publicada).
  O painel reconhece esse caso e explica na tela. Conversa, foto, **áudio** e lista de modelos do
  Gemini seguem a documentação do Google, mas só serão conferidos com uma chave nova.
- **Banco real**: a migração `20261112002400_ai_engine_and_training` foi aplicada e o retrato do
  banco bate com o do Git. Um roteiro de 31 passos rodou no banco de verdade (gravar a ordem com a
  NVIDIA, recusar ordem repetida, guardar/ler/apagar chave cifrada, recusar chave em texto puro,
  criar base, pergunta, arquivo, base por chip; conta de fora e visitante recusados; auditoria sem
  a chave) e desfez tudo no fim: 31 de 31, nada ficou gravado.
- **Não conferido**: a tela falando com o banco de verdade pelo navegador (o Supabase está
  bloqueado para o painel), e nada disto está publicado (a Vercel está bloqueada).

O que falta na Fase 2:

1. O **atendente**: ler a mensagem que chega, montar as instruções, pedir a resposta ao provedor,
   enviar, passar para uma pessoa quando precisa. Com ele: liga/desliga da IA em cada chip,
   "Pausar tudo", assumir e devolver a conversa na Inbox, corrigir resposta em 1 clique.
2. No Treinamento: Mensagens prontas (M01–M13), Estúdio de Skills, "Cérebro completo" e "Pacote Turbo".
3. Cadastrar na Vercel o segredo que protege as chaves (já criado e guardado; a Vercel está bloqueada).

### Diferenças pequenas em relação ao visual do branch

- O cartão "Na fila segura" virou "Contatos" até a fila existir (Fase 5).
- No lugar de "Controle rápido" entrou "Para começar a atender" (três passos).
- O botão "IA Ativa" do topo dá lugar ao "Pausar tudo" (emergência). Ele e o liga/desliga de cada
  chip entram na Fase 2, junto com o atendente de IA: antes disso não haveria o que ligar.
  A busca (Ctrl+K) entra quando houver o que buscar.
- No tema claro, o cinza do texto pequeno ficou um pouco mais escuro, para dar leitura
  (o original não atingia o contraste mínimo recomendado). Pelo mesmo motivo, os textos de erro
  e de atenção ganharam um vermelho e um amarelo próprios para letra pequena.
- A Inbox desta fase tem a lista, a conversa e a ficha básica. As abas internas do branch
  (Contatos, Kanban, Coach IA), os filtros "Quentes" e "Retorno S19", a seleção em lote e o
  botão "Nova" (começar conversa) ficam para a Fase 3 (CRM completo).
- Na conversa, resposta de pessoa é azul e resposta da IA é verde, como no branch.

## 5. Migração dos dados (Fase 7)

Do Supabase antigo ("ZAP-IA Studio") para o novo ("Ienvia"), sem apagar nada no antigo:

| De (antigo) | Para (novo) | Quantidade hoje |
| --- | --- | --- |
| Contas (`zapia_users`) | Usuário + empresa (workspace) + dono | 4 |
| Negócio, configurações e treinamento (`zapia_workspaces`) | Configurações e treinamento da empresa | 4 |
| Contatos (`zapia_contacts`, `ienvia_crm_contacts`) | Contatos | 333 + 243 |
| Mensagens (`ienvia_instance_messages`) | Conversas e mensagens | 752 |
| Chips (`zapia_wa_slots`, `ienvia_channels`) | Instâncias (nascem desconectadas) | 2 |
| Destinatários de campanha (`ienvia_campanha_destinatarios`) | Só histórico, se você quiser | 928 |

Como será feito: um roteiro que pode ser rodado várias vezes sem duplicar nada, primeiro em modo
de ensaio (só conta e mostra o que faria), depois de verdade, com um relatório de conferência no final.

## 6. Pendências e cuidados

- **BANCO DE DADOS BLOQUEADO POR COTA (desde a noite de 11/11/2026).** O Supabase passou a recusar
  **todas** as chamadas dos dois projetos da organização "ZAP IA STUDIO" (o do sistema antigo e o
  novo "Ienvia") com a resposta `402 exceed_egress_quota`: a organização passou da cota de tráfego
  de saída do plano. Isso vale para login, dados e arquivos. Conferido às 19h35, às 19h53 e de novo
  às 22h20 de 11/11 (horário de Brasília), nos dois projetos. **Enquanto durar, ninguém entra no
  painel novo e o sistema antigo também fica sem banco.**
  - **Quem gastou a cota foi o sistema antigo** (medido em 12/11/2026 nos contadores do próprio
    banco, que contam desde 26/10). Em 17 dias ele fez cerca de 1,5 milhão de chamadas ao banco:
    perto de uma por segundo, dia e noite. O projeto novo fez cerca de 1.400 chamadas no total e não tem dado
    de cliente (0 contatos, 0 conversas, 0 mensagens, nenhum arquivo guardado).
    - O suspeito principal é a sincronização do sistema antigo, que relê tudo a cada vez: o
      cadastro inteiro da empresa foi lido 85.624 vezes (o maior pesa 789 kB por leitura) e a lista
      inteira de contatos, mais de 63 mil vezes (a maior pesa 565 kB).
    - Há também um programa que pergunta ao banco "tem comando para mim?" a cada 11 segundos
      (funções `pag_pegar_comando` e `pag_registrar`; 133 mil chamadas). Ele não está no código que
      foi analisado; falta saber o que é.
    - A divisão exata do consumo (por projeto e por serviço) só aparece no painel do Supabase, em
      *Organization → Usage*.
  - **O que isso muda:** levar o sistema antigo para uma conta gratuita nova não resolve, porque o
    consumo vai junto. Para o sistema novo, a saída sem custo e dentro das regras do Supabase é uma
    **organização nova na mesma conta**: cada organização tem a sua própria cota, e o limite é de 2
    projetos gratuitos ativos por pessoa (projeto pausado não conta). O banco novo é remontado a
    partir das migrações do Git. Os dois logins e as duas empresas que existem hoje no banco novo
    já foram copiados para um arquivo guardado fora do repositório, para nada se perder na mudança.
  - Para o sistema antigo voltar: (1) passar a organização para o plano Pro (US$ 25 por mês; libera
    na hora), ou (2) esperar a cota renovar no próximo ciclo de cobrança (a data aparece em
    *Organization → Billing*). Depois de um primeiro estouro, o Supabase volta a bloquear sem
    período de aviso.
  - O acesso administrativo (o que aplica migrações e roda SQL) continua funcionando. Foi por ele
    que a migração dos arquivos foi aplicada e conferida.
  - **Cuidado daqui para a frente:** fotos, áudios e vídeos gastam essa mesma cota cada vez que
    alguém abre uma conversa. Com clientes de verdade, o plano gratuito não aguenta.
- **Chave do Gemini bloqueada pelo Google (12/11/2026).** A chave do Gemini que você mandou não
  funciona mais: o Google respondeu "Your API key was reported as leaked", que é o bloqueio
  automático de uma chave que apareceu em lugar público. Procurei no código e no histórico do
  sistema antigo (a cópia que tenho) e ela não está lá; não sei onde vazou. **O que fazer:** criar
  uma chave nova em `aistudio.google.com/apikey`, apagar a antiga e não colar a nova em repositório,
  grupo ou documento público. Se essa chave também era usada no sistema antigo, a IA de lá parou.
- **Segredo que protege as chaves de IA.** Já foi criado e está guardado (fora do repositório).
  Falta cadastrá-lo na Vercel (`IENVIA_CHAVE_DOS_SEGREDOS`) quando a conta for desbloqueada; sem
  ele, o painel publicado não guarda nem usa chave nenhuma (e avisa isso na tela). Se um dia esse
  segredo se perder, as chaves guardadas deixam de abrir e cada cliente cadastra a sua de novo.
- **Senha exposta.** O repositório antigo é público e tem o usuário e a senha do painel escritos
  em dois documentos (`GUIA_PARA_IA.md` e `CONTEXTO_SISTEMA.md`), além de telefones reais.
  Recomendo trocar essa senha e tornar o repositório privado.
- **Limite de tentativas de login.** Hoje quem limita é o Supabase. Antes da virada (Fase 8) entra
  um limite próprio por usuário, para ninguém ficar tentando senhas.
- **Política de segurança de conteúdo (CSP).** Os cabeçalhos básicos já estão ativos; a política
  completa entra antes da virada.
- **O que significa "ligado" num chip (decidido).** O botão de cada chip (`is_enabled`) liga e desliga
  **só a IA** daquele chip. Com a IA desligada o chip continua recebendo e guardando as mensagens,
  e você responde à mão pela Inbox. Todo chip nasce com a IA desligada.
- **Limite de chips por conta.** Cada conta nasce podendo ter 1 chip, como no sistema antigo
  (`workspaces.max_instances`). A sua conta foi ajustada para 3. Quem muda o limite é o
  administrador, na aba Clientes SaaS (Fase 7).
- **Conta de teste no banco novo.** Existe um usuário `teste-automatico` com uma empresa
  "Teste automático (pode apagar)". Serve para conferir as telas no ambiente de verdade sem usar a
  sua conta. Será apagado antes da virada.
- **Publicação (parada em 11/11/2026).** O painel foi publicado em `https://ienvia-novo.vercel.app`
  (Instâncias e recebimento) e funcionou. Na tarde do mesmo dia a Vercel **bloqueou a conta inteira**
  por passar do limite de uso do plano gratuito (Hobby): o endereço passou a responder
  "Payment required", e os outros projetos da mesma conta também. O que este projeto usou naquele
  dia foi pouco (algumas montagens e algumas dezenas de acessos de teste); qual limite estourou e
  de onde veio o consumo só aparece no painel da Vercel, em *Usage*.
  A Inbox, o Motor de IA e o Treinamento estão no GitHub, mas **não estão no ar**. Para voltar:
  (1) passar a conta para o plano Pro (US$ 20 por mês), (2) hospedar o painel em outro lugar, ou
  (3) esperar o limite renovar (em geral, 30 dias).
  **Abrir outra conta gratuita não é saída** (corrigido em 12/11/2026: uma versão anterior deste
  plano listava "publicar em outra conta"). A política de uso aceitável da Vercel proíbe criar
  contas para contornar limites e prevê suspensão do acesso; e o plano Hobby é só para uso pessoal,
  não comercial. Com clientes pagantes, é o Pro ou outra hospedagem de qualquer forma.
  Enviar para o GitHub **não** publica sozinho: cada publicação é feita de propósito, depois dos
  testes.
  Na noite de 11/11 o bloqueio continuava: `ienvia-novo.vercel.app` e `zap-ia-studio.vercel.app`
  respondiam "Payment required" (conferido às 19h38 e de novo às 22h18, horário de Brasília).
- **Conectar os chips pelo endereço publicado.** A Evolution avisa o painel pela internet, e o
  endereço da prévia só abre para quem está na conversa. Chip conectado pela prévia não entrega
  mensagens. Se um chip foi conectado por outro endereço, basta abrir a aba Instâncias no endereço
  publicado: cada chip passa a avisar o endereço certo sozinho.
- **"Esperando você" (decidido).** O cartão da Visão geral e o filtro da Inbox fazem a mesma
  conta: conversas em que a próxima resposta é de uma pessoa (novas, passadas pela IA ou já em
  atendimento). Quando você responde, a conversa sai da conta até o cliente escrever de novo.
- **Envio ainda não conferido com um chip de verdade.** A Inbox foi conferida com o banco e a
  Evolution de verdade, a partir do painel rodando aqui (não do endereço publicado, que estava
  bloqueado), usando um chip de teste que nunca foi ligado a um WhatsApp: os avisos de mensagem
  foram entregues à mão no painel. Funcionou: conversa aparecendo, leitura, mensagem nova entrando
  sozinha, resposta ficando "sem confirmação" quando a Evolution não responde (cerca de 30
  segundos), confirmação automática quando o aviso de "mensagem enviada" chega, resolver, e
  conversa nova quando o cliente volta. Falta ver, com um chip seu conectado: uma mensagem real
  chegando, uma resposta saindo de verdade e o aviso da Evolution voltando sozinho.
- **Arquivos: o que foi conferido de verdade e o que falta.**
  - **Conferido no banco de verdade** (11/11, pelo acesso administrativo, numa operação que o banco
    desfaz inteira no final, sem deixar nada gravado): 46 verificações, todas certas. Quem é da
    empresa sobe arquivo só na pasta de envios de uma conversa da própria empresa e enxerga os
    arquivos dela; pessoa de outra empresa e visitante sem login não enxergam nem sobem nada;
    ninguém troca nem apaga arquivo; o envio lê o tipo e o tamanho que o depósito registrou; o
    recebimento de uma foto grava a mensagem, reserva a busca do arquivo e marca como guardado.
    O roteiro está em `apoio-da-reconstrucao/ferramentas/conferir-arquivos-no-banco-real.sql`.
  - **Falta, por causa do bloqueio de cota:** o mesmo caminho passando pela porta de entrada do
    Supabase (subir e abrir um arquivo pelo navegador, com uma conta logada). O roteiro está
    pronto (`conferir-arquivos-no-ambiente-real.mjs`) e para sozinho, sem fazer nada, enquanto o
    serviço estiver bloqueado.
  - **Falta, por depender de um chip seu conectado:** um arquivo de verdade chegando pelo WhatsApp
    e sendo buscado na Evolution, e um arquivo saindo de verdade para um contato.
- **Arquivos: prazo de guarda.** Cada arquivo já é gravado com a data até quando deve ficar (30
  dias, ou o prazo configurado na empresa), mas **a limpeza automática ainda não existe**: por
  enquanto nada é apagado. Quando ela entrar, tem de apagar pelo serviço de arquivos do Supabase,
  porque ele não deixa apagar arquivo direto pelo banco (conferido).
- **Arquivos: o que o navegador toca.** Áudio e vídeo usam o tocador do próprio navegador. Mensagem
  de voz do WhatsApp vem num formato (OGG/Opus) que navegadores mais antigos, principalmente no
  iPhone, não tocam. Por isso há o "Baixar" ao lado de cada áudio e vídeo. Converter o áudio no
  servidor fica para depois, se fizer falta.
- **O que a Evolution responde quando o envio falha.** A Evolution 2.3.7 devolve o mesmo erro
  ("400") para quase tudo, inclusive quando a mensagem já saiu e o problema foi depois. Por isso o
  painel só diz "não enviada" quando tem certeza (número sem WhatsApp, chip que não existe mais,
  chave recusada). No resto, fica "sem confirmação" e a pessoa decide.
- **Mensagens novas aparecem por consulta, não por conexão permanente.** A Inbox aberta pergunta ao
  painel se algo mudou: a cada 4 segundos com a pessoa usando a tela, a cada 12 depois de 2 minutos
  parada e a cada 30 depois de 15 minutos; com a aba escondida, não pergunta. É simples e
  resistente, mas cada pergunta é uma chamada ao servidor (um atendente trabalhando 8 horas faz
  até umas 7 mil por dia). Com muitos atendentes ao mesmo tempo, vale trocar pelo canal em tempo
  real do Supabase, que não gasta chamadas enquanto nada acontece.
- **Endereço de uma conversa depois do login.** Quem abre o endereço de uma conversa sem estar
  logado volta, depois do login, para a Inbox, e não direto para aquela conversa.
- **Botão verde com letra branca.** A cor da marca com letra branca não atinge o contraste mínimo
  recomendado (o teste automático não acusa porque o fundo do botão é em degradê). Ficou como no
  branch visual. Se quiser, dá para escurecer o verde dos botões ou usar letra escura.

## 7. Como saber que uma fase está pronta

1. `npm run verificar` passa inteiro (tipos, estilo de código, testes, montagem e navegador).
2. As telas novas foram comparadas com as do branch visual, no computador e no celular.
3. O que mudou no banco está em uma migração nova, testada aqui antes de ir para o banco "Ienvia",
   e aparece no resumo da entrega (regra completa na seção 2).
4. Este plano foi atualizado.
