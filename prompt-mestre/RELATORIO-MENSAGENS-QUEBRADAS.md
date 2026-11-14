# Mensagens quebradas: por que a IA respondia em textão e o que foi corrigido

Data: 12/11/2026 · Pedido: "quando a IA for responder, quebrar mais a mensagem — em duas ou três mensagens, em vez de parágrafos, para ficar mais humanizado".

---

## 1. O diagnóstico (comprovado, não chutado)

**A IA já escrevia em parágrafos.** Quem juntava tudo num balão só era o motor.

A função que decide os balões fica em `web/src/lib/atendente/regras.ts`:

```ts
// ANTES
if (dividir && limpo.length > TAMANHO_PARA_DIVIDIR && /\n\s*\n/.test(limpo)) {
```

`TAMANHO_PARA_DIVIDIR = 260`. Ou seja: a resposta só era quebrada se tivesse **mais de 260 caracteres** *e* tivesse linha em branco. O caso mais comum de todos — a resposta boa, curta, de 2 ou 3 parágrafos — nunca era dividida.

Rodei a função real (fora do app, com o código copiado) em cinco casos:

| Resposta da IA | Caracteres | Balões antes |
|---|---|---|
| "Entregamos sim!" | 15 | 1 |
| "Oi, tudo bem? / Sai daqui uns 40 min. / PIX ou cartão?" | 52 | **1** ← o problema |
| "Oi! Aqui é a Bella da Pizzaria… [4 linhas]" | 149 | **1** ← o problema |
| Dois parágrafos de 250 caracteres cada | 486 | 2 |
| Três parágrafos longos | 729 | 3 |

Prova prática: a resposta de 149 caracteres, que tem saudação + horário + entrega + pergunta, chegava ao cliente como **um bloco de quatro linhas**. Era exatamente o que você estava vendo.

## 2. A correção no motor

```ts
// DEPOIS
if (dividir && /\n\s*\n/.test(limpo)) {
```

Agora **parágrafo separado vira balão separado, sempre** — curto ou comprido. O resto da função continua igual: até 3 parágrafos = até 3 balões; com mais de 3, o miolo se junta (primeiro, miolo, último) para não virar enxurrada; balão de até 4.096 caracteres; máximo de 5 balões.

O interruptor do **Motor de IA continua valendo**: desligado, a resposta inteira vai num bloco só — agora com o rótulo honesto ("Responder em mensagens separadas, como uma pessoa"). Se algum cliente preferir textão, é só desligar.

O banco não mudou: o envio já aceita de 1 a 5 partes (`p_part between 1 and 5`), então não tem migration, não tem risco de importação, e o comportamento antigo volta em uma linha se você quiser.

## 3. A instrução que a IA recebe

Corrigir o motor não bastava: se a IA escrevesse um parágrafo único comprido, não haveria o que dividir. Então o bloco `=== COMO ESCREVER ===` de `web/src/lib/ia/instrucoes.ts` ganhou três linhas:

- quando a resposta tem mais de uma ideia (saudação, informação, pergunta), separar em **2 ou 3 blocos com uma linha em branco entre eles** — cada bloco chega como mensagem separada;
- um exemplo concreto no próprio prompt ("Oi, tudo bem? ⏎⏎ Sai daqui uns 40 minutos, tá? ⏎⏎ PIX ou cartão na entrega?");
- proibição de textão de um parágrafo só e de mais de 3 blocos.

## 4. Efeito no tempo de "digitando…"

Cada balão tem seu próprio "digitando…" proporcional ao tamanho do texto (entre 1,8 s e 5,2 s, com variação aleatória). Com a resposta em três balões, o ritmo fica: digita 2 s → manda → digita 3 s → manda → digita 2 s → manda. É o que faz parecer gente. Se ficar lento demais para o seu gosto, o ajuste é nos limites de digitação em `regras.ts` (constantes `DIGITANDO_NO_MINIMO` e `DIGITANDO_NO_MAXIMO`), não na divisão.

## 5. Testes

- `web/test/atendente-regras.test.ts` — reorganizado em três testes: (a) sem parágrafo ou vazia vai num balão; (b) **parágrafo separado vira balão mesmo com resposta curta** (os dois casos que falhavam); (c) mais de três parágrafos vira três balões; (d) interruptor desligado não divide; (e) corte de 4.096 e recusa de texto absurdo.
- `web/test/instrucoes.test.ts` — teste novo garantindo que a instrução dos blocos está no system prompt.

**Execução:** o `node_modules` do projeto não está no sandbox, então rodei o conteúdo real de `dividirResposta` num bundle isolado, com os mesmos 14 asserts do teste: **14/14 passaram**.

Antes de subir, rode o de sempre para confirmar no projeto inteiro:

```bash
npm run test:unit      # vitest: shared + web
npm run check          # typegen + tsc
npm run build
```

## 6. Se quiser ir além (fica para uma segunda rodada)

1. **"Digitando…" por balão já existe** — o que dá para melhorar é a pausa entre balões (hoje é o tempo de digitação do próximo, sem respiro extra).
2. **Emoji/bloco por tipo de negócio**: hoje o treinamento pede no máximo 1 emoji. Dá para virar configuração.
3. **Dividir também resposta que usa `-` ou `1.` como lista**: hoje linha simples não divide, de propósito, para não picar lista em três mensagens.
4. **Simulador mostrar os balões separados**: hoje a tela mostra a resposta; se você quiser ver exatamente o que o cliente recebe (3 bolhas), é uma mudança pequena só na tela do simulador — o dado já está em `dividirResposta`.

## 7. Arquivos mexidos

| Arquivo | O que mudou |
|---|---|
| `web/src/lib/atendente/regras.ts` | `dividirResposta`: parágrafo separado sempre vira balão; quebra por frase para textão; `TAMANHO_PARA_DIVIDIR` obsoleto; novos `CARACTERES_PARA_QUEBRAR_FRASE` e `CARACTERES_MINIMOS_DO_BALAO` |
| `web/src/lib/ia/instrucoes.ts` | 3 linhas novas no `=== COMO ESCREVER ===` ensinando os 2–3 blocos |
| `web/src/app/(painel)/inteligencia-artificial/painel-do-motor.tsx` | rótulo e descrição do interruptor atualizados |
| `web/test/atendente-regras.test.ts` | testes atualizados + casos novos |
| `web/test/instrucoes.test.ts` | teste novo da instrução de blocos |
| `prompt-mestre/PROMPT-MESTRE-IENVIA.md` e versão curta | seção 4.1 "regra dos blocos" + item novo no checklist |

---

## 8. Segunda rodada de testes (o que eu fui verificar depois)

Depois de fechar a primeira correção, testei o caminho inteiro — resposta do modelo → leitura das marcas → divisão em balões — montando os módulos reais (`instrucoes.ts` + `regras.ts`) num bundle isolado, já que o `node_modules` do projeto não está aqui.

### 8.1 O que passou

| Cenário | Resultado |
|---|---|
| Resposta em 3 blocos curtos | 3 balões (antes: 1) |
| `[[CHAMAR_HUMANO:...]]` no fim | marca lida, removida do texto, 1 balão com o texto humano |
| `[[ENVIAR_PIX:149.90]]` + PIX ativo | marca lida, valor capturado, texto limpo |
| `**negrito**` duplo | vira `*negrito*` (1 asterisco, como o WhatsApp usa) e divide certo |
| Marca vazando para o cliente | nunca — o `lerResposta` limpa antes de dividir |
| Interruptor do Motor de IA desligado | resposta inteira num balão |
| Teste do arquivo `atendente-regras.test.ts` | 7/7 casos, rodados com os mesmos asserts |

### 8.2 O buraco que sobrou na primeira correção (e o que fiz)

A IA nem sempre obedece à instrução de escrever em blocos. Quando ela escrevia **tudo corrido num parágrafo**, não havia linha em branco nenhuma e a resposta de 215 caracteres continuava saindo como um bloco só. A primeira correção não resolvia esse caso porque só olhava parágrafos.

Fechei com **quebra por frase**, para parágrafo único acima de `CARACTERES_PARA_QUEBRAR_FRASE` (220):

- divide **só nas frases** (ponto seguido de espaço), então `R$ 89,90`, `18h30` e `Rua São João, 123` nunca quebram no meio;
- divide em **2 ou 3 blocos equilibrados**, não em "primeiro gigante, último de duas palavras";
- nenhum bloco sai com menos de `CARACTERES_MINIMOS_DO_BALAO` (40) — bloco nanico gruda no vizinho;
- **lista numerada** (um item por linha) fica inteira: o corte por frase estragaria a lista;
- texto sem pontuação (ou com menos de 3 frases) não é picado — melhor um bloco são do que três pedaços quebrados.

Conferido nos dois sentidos: texto corrido de 283 caracteres → 2 blocos equilibrados, terminando em ponto; `palavra palavra palavra…` de 239 caracteres → 1 bloco (não estraga).

### 8.3 O que ainda não consegui verificar aqui

1. **Envio real pelo WhatsApp** — precisa de instância conectada; o código até o `start_ai_message` está coberto, o envio físico não.
2. **Simulador** — ele não usa `dividirResposta`; mostra a resposta inteira. Se quiser ver na tela exatamente as 3 bolhas que o cliente recebe, é uma mudança pequena e isolada na tela do simulador.
3. **Movimento de saída de mensagens no painel** — incluindo o caso de 3 balões + PIX simultâneos (o motor reserva 2 dos 5 espaços para o PIX).

### 8.4 Antes de subir

```bash
npm run test:unit && npm run check && npm run build
```

`npm run test:unit` roda o arquivo de teste de verdade no projeto. Aqui rodei o mesmo arquivo com os mesmos asserts (7/7) e o pipeline completo montado à mão; `tsc` completo e build exigem o `node_modules`, que não está neste sandbox.

---

## 9. Terceira rodada: simulador mostrando os balões + verificação de verdade no projeto

### 9.1 Simulador agora mostra as bolhas

Antes, o simulador exibia a resposta inteira num balão único: você testava uma coisa e o cliente recebia outra. Agora:

- `MensagemSimulador` ganhou o campo opcional `baloes: string[]` (`shared/src/simulador/regras.ts`);
- a ação do simulador calcula os balões com **a mesma função do atendimento real**, respeitando o interruptor do Motor de IA (`acoes.ts`);
- a tela desenha **uma bolha por balão**, com a legenda "Na conversa de verdade, a IA manda isso em N mensagens separadas". Mensagens antigas (sem `baloes`) continuam aparecendo inteiras.

Para isso, `dividirResposta` precisou ser importável de um componente de cliente. O `@/lib/atendente/regras` importava `type Fala` de `@/lib/ia/provedores`, que tem `server-only` na primeira linha — o que derrubaria o build. A `Fala` (que é só `{ de, texto }`) passou a ser declarada dentro de `regras`, que segue sem `server-only`; `atendente.ts` reexporta o tipo, então quem já importava de lá não muda nada.

### 9.2 Verificação completa, agora sim, no projeto

Instalei as dependências no sandbox e rodei a suíte real. O Node do ambiente é o 20, abaixo do exigido (`engines: 24.x`) — com o 20 o Vitest nem consegue imprimir o relatório (`Map.groupBy`). Rodei com Node 24 via `npx -p node@24`:

| Comando | Resultado |
|---|---|
| `next typegen` | tipos de rota gerados |
| `tsc --noEmit` | **0 erros** |
| `vitest run --project shared --project web` | **635 testes, 35 arquivos, 0 falhas** |
| `eslint .` | sem erros |
| `next build` | build concluído |

Um teste meu falhou na primeira rodada (maiúscula em `Cada bloco…`) e foi corrigido — vale registrar, porque mostra que os testes novos estavam realmente rodando.

### 9.3 O que continua sem verificação

1. **Envio físico pelo WhatsApp** — precisa de instância conectada e número real.
2. **Clicar no simulador na tela** — o build e os testes passam, mas eu não abri a tela logado no painel.
