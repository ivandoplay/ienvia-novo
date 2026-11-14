# Prompt mestre do treinamento Ienvia — o que é, como usar, por que está escrito assim

Data: 12/11/2026 · Arquivos nesta pasta:

| Arquivo | Para que serve |
|---|---|
| `PROMPT-MESTRE-IENVIA.md` | Versão completa (~31.500 caracteres). É o prompt de verdade: entrevista em 7 etapas, padrão de humanização, especificação técnica de JSON/Markdown/zip e checklist. |
| `PROMPT-MESTRE-IENVIA.txt` | **O mesmo prompt em texto puro**, 32.865 caracteres / 505 linhas, sem os marcadores de "copie daqui". É esse que se abre no celular, se manda por WhatsApp/Drive e se cola em qualquer IA. |
| `PROMPT-MESTRE-IENVIA-versao-curta.md` | Mesma coisa em ~8.000 caracteres, para colar em tela pequena, em chat com limite de contexto ou em IA que se perde com texto longo. |
| `LEIA-ME.md` | Este documento: decisões, limites conferidos e como subir no sistema. |

---

## 1. As decisões que você tomou (e como viraram regra do prompt)

| Sua fala | O que entrou no prompt |
|---|---|
| "A primeira pergunta deve ser se a pessoa quer a completa ou apenas aquela saída de texto" | Seção 1: a IA **só** se apresenta e faz a pergunta de formato. Três opções: **Pacote Turbo completo**, **só JSON**, **só Markdown**. Regra explícita de "não escreve nada antes de terminar a entrevista". |
| "Serve para modelos que só têm linguagem e para os que são agentes que geram arquivos" | Seção 1, bloco "calibre ao tipo de IA": agente → entrega arquivos reais; modelo de texto → entrega um bloco por arquivo, com o caminho no título. O conteúdo nunca muda, só o meio. |
| "Vai servir para qualquer nicho, o que vale são as perguntas" | Nenhuma seção fixa ramo. A Etapa 2 fala de "entrega física, execução, agendamento, retirada ou online", para o prompt funcionar em delivery, clínica, oficina e varejo. O nicho sai da boca do dono, não do prompt. |
| "Logística primeiro" | Etapa 2 vem antes de produto e preço, com 24 perguntas (mínimo de 15 exigido) e fechamento obrigatório com resumo "pode dizer X / não pode dizer Y" + confirmação. |
| "Deixar cada resposta humanizada o máximo possível" | Seção 4 inteira: 12 regras + o "teste do dedo" (a frase precisa poder ser enviada no WhatsApp sem edição). Aparece também no checklist final. |
| "Acho quase impossível bater esse limite, critério é seu" | Seção 6 e 8: ordem de decisão (fundir → mover para documento → priorizar por impacto → avisar), com direito a perguntar antes se o estouro for grande. Nada de corte no meio de frase. |
| "Fica salvo numa aba do sistema para o cliente copiar e colar" | O texto é Markdown puro, sem dependência de ferramenta e sem instrução presa a um fornecedor. A versão curta cabe com folga em um documento de conhecimento (8.350 de 30.000); a completa passa do limite por ~1.500 caracteres — ver seção 4. |

## 2. Como usar

**Agora, para você testar:** abra o ChatGPT/Claude/Gemini, abra o `PROMPT-MESTRE-IENVIA.txt`, selecione tudo (Ctrl+A) e cole como primeira mensagem. No `.md`, o texto útil está entre `✂ ─── COPIE DAQUI ───` e `✂ ─── FIM DO PROMPT ───`. A IA deve responder apenas com a apresentação + a pergunta de formato.

**Para o cliente:** mande o arquivo inteiro (ou só o trecho entre os marcadores). Não precisa explicar nada antes — o prompt já se apresenta.

**Em agente com arquivos** (Claude com projetos, ChatGPT com arquivos, Cursor, Manus, etc.): cole igual. Ele vai gerar os arquivos de verdade na pasta `pacote-turbo-<negocio>/`.

## 3. O que já está conferido contra o código

Tudo abaixo saiu de `web/src/lib/ia/estudio.ts`, `treinamento.ts` e da migration `20261112002400_ai_engine_and_training.sql` — não é suposição:

- **Limites**: 100 mensagens / 100 skills op / 100 humanização / 150 objeções / 20 personas / 40 pares bom-ruim / 80 referências / 30 filtros de voz / 100 FAQs.
- **Tamanhos de campo**: `id` 60, `titulo` 160, `categoria` 80, `texto` 4.000, `nome` 200, `quando` 500, `exemploDeResposta` 2.000, `conteudoMd` 8.000, `padraoDeEntrada` 500, `estrategia` 2.000, playbook e regras canônicas 12.000, documento 30.000 (120.000 por base), zip 4 MB / 8 MB / 250 arquivos.
- **JSON de importação**: `schema: "ienvia-treinamento-v2"` com `training`, `approved_messages`, `operational_skills`, `humanization_skills`, `objections`, `brain_pack` — os nomes de campo usados no exemplo foram todos validados rodando o JSON do prompt no `json.loads` e conferindo os limites um por um.
- **Markdown**: os cabeçalhos `## M01 - …` / `## S01 - …` / `## H01 - …` / `## O001 - …` seguem a regex real de `extrairEstudioDeDocumentos`, incluindo `**Quando usar:**` e `**Exemplo de resposta:**` (que são lidos e viram `quando` e `exemploDeResposta`).
- **Playbook**: só vira `playbookCentral` o documento cujo **título** contém "playbook" — por isso o prompt exige `PLAYBOOK-CENTRAL-….md` e manda o texto do cérebro vir antes do primeiro `## M01`.
- **Estrutura do zip turbo**: usa exatamente os nomes que o importador procura (`01-negocio/*.md`, `02-comportamento/*.md`, `03-skills`, `resumo-do-treinamento.json`, `fatos-do-negocio.json`, etc.), então um zip gerado pela IA tem chance real de importar sem ajuste.
- **Marcas**: `[[CHAMAR_HUMANO]]`, `[[PARAR_CONTATO]]`, `[[ENCERRAR_CONTATO]]`, `[[PAUSA_SILENCIOSA]]` existem no motor. `[[ENVIAR_PIX]]`, `[[ENVIAR_AUDIO]]` e `[[ENVIAR_ITEM]]` também existem, mas o prompt **não** manda a IA escrevê-las em texto de mensagem pronta (elas dependem de catálogo/áudio cadastrado) — só cita como regra quando o negócio usa PIX.

## 4. Um aviso honesto: onde colocar na interface

Você falou em salvar "numa aba do sistema para o cliente copiar e colar". Hoje o sistema tem duas casas possíveis, e nenhuma é uma aba própria:

1. **Documento de conhecimento** (aba **Arquivos** do Treinamento) — limite de **30.000 caracteres por documento**. A versão completa tem ~31.500, então quase não cabe; a versão curta (~8.000) cabe 3 vezes. Se quiser a completa dentro do sistema, é preciso cortar ~1.500 caracteres ou dividir em dois documentos.
2. **Um bloco fixo na tela de Treinamento** (por exemplo, um cartão "Prompt mestre para gerar um treinamento do zero" com botão *Copiar*), fora dos documentos — aí o limite de 30.000 não se aplica, porque é texto de interface, não conteúdo do cérebro.

Minha recomendação: **versão curta como documento** (funciona hoje, sem mexer em código) + **versão completa como cartão fixo na tela**, se você quiser que ela apareça mais. Se quiser, eu implemento o cartão com botão copiar — é uma alteração pequena em `web/src/app/(painel)/treinamento/painel-de-treinamento.tsx`.

## 5. Como testar se o prompt está bom (roteiro rápido)

Uma conversa de 10 minutos revela quase tudo:

1. Cole o prompt. **Esperado:** a IA pergunta o formato e para.
2. Responda "só Markdown". **Esperado:** ela vai para a Etapa 1 com no máximo 3 perguntas e **não** já escreve o treinamento.
3. Responda de forma vaga ("entrego em todo lugar"). **Esperado:** ela insiste e pede bairros concretos.
4. Invente uma contradição ("só atendo a cidade" e depois "mando para todo o Brasil"). **Esperado:** ela pergunta qual vale.
5. Diga "me manda logo". **Esperado:** ela oferece 3 rodadas de 6 perguntas com pendências `CONFIRMAR COM O DONO`.
6. Ao final, confira o Markdown: `## M01 - …` com hífen simples, `**Quando usar:**` presente, nenhuma frase "prezado/diversos/cordialmente".

Se passar nesses seis, o prompt está fazendo o trabalho.

## 6. Depois que a IA entregar

1. Treinamento → escolher a base → **Cérebro e Pacote** → importar backup/pacote e escolher o `.json`.
   (ou aba **Arquivos** → anexar o `PLAYBOOK-CENTRAL.md` → **Extrair Estúdio dos arquivos**)
2. Conferir a **Identidade** (nome, nicho, tom, primeira pessoa) — é o que mais chega torto.
3. Testar no **Simulador**: uma pergunta de frete, uma de prazo, uma objeção de preço. Se a resposta de frete não bater com a entrevista, o problema está no `commercial_terms`.
4. Revalidar preço, prazo e região sempre que mudarem — o treinamento é foto do dia, não contrato.

## 7. Se quiser uma versão 2 do prompt

Ideias que ficam bem em uma segunda rodada:
- bloco específico por vertical (delivery, clínica, oficina, imobiliária) com perguntas exclusivas de cada uma, mantendo o miolo genérico;
- versão "cliente responde sozinho" (sem você no meio), com linguagem ainda mais didática;
- gerador de variação por região (o mesmo negócio falando com sotaque do Nordeste, Sul, etc.).
