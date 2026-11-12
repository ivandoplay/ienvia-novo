# Ienvia

Atendimento inteligente e CRM para WhatsApp: vários chips, atendente de IA, caixa de entrada,
campanhas e contas separadas por cliente.

Esta é a **reescrita limpa** do sistema antigo (`zap-ia-studio`). O plano completo, com as fases e
as decisões, está em [docs/PLANO.md](docs/PLANO.md). A lista do que fica e do que sai está em
[docs/O-QUE-FICA-E-O-QUE-SAI.md](docs/O-QUE-FICA-E-O-QUE-SAI.md).

**Situação:** Fase 0 (fundação) pronta. Fase 1 pronta no código e no banco: a aba **Instâncias**
(conectar chips), o recebimento das mensagens e a **Inbox** com texto e com arquivos (fotos, áudios,
vídeos, documentos e figurinhas). Fase 2 em andamento: as abas **Motor de IA** e **Treinamento** e o
**atendente de IA** (a IA responde no WhatsApp nos chips em que for ligada, passa a conversa para uma
pessoa quando precisa e para quando alguém responde) estão prontos no código e no banco. Faltam: corrigir
resposta em 1 clique, as Mensagens prontas e as Skills.
O banco voltou a funcionar em 12/11/2026, num projeto Supabase novo e só dele (`ienvia-001`). Falta a
conferência final no ar, que continua travada pelo bloqueio da conta da Vercel (publicação) desde
11/11/2026. Os detalhes e o que fazer estão no começo da seção 6 de [docs/PLANO.md](docs/PLANO.md).
As outras abas aparecem no menu e avisam em que fase ficam prontas.

## O que tem em cada pasta

```
web/        O painel (Next.js). É o que o cliente abre no navegador.
shared/     Regras usadas pelo painel e pelo motor local (código puro, sem rede).
supabase/   O banco: migrações em ordem e os testes de segurança.
docs/       O plano e a lista do que fica e do que sai.
```

O motor local do WhatsApp (pasta `motor/`) entra na Fase 4.

## Rodar no seu computador

Precisa do Node 22.12 ou mais novo (recomendado: 24).

```bash
npm install
cp web/.env.example web/.env.local   # depois preencha o endereço e a chave pública do Supabase
npm run dev                          # abre em http://localhost:3000
```

Sem o `.env.local`, o painel sobe e mostra uma tela explicando o que falta configurar.

## Conferir se está tudo certo

```bash
npm run verificar
```

Esse comando roda tudo, em ordem, e para no primeiro problema:

| Etapa | Comando sozinho | O que confere |
| --- | --- | --- |
| Tipos | `npm run check` | Erros de programação que dá para pegar sem rodar nada. |
| Estilo | `npm run lint` | Padrões do código do painel. |
| Regras e banco | `npm test` | 865 testes em 34 arquivos: login, menu, datas, chips, a Inbox, os arquivos (fotos, áudios, vídeos, documentos), a conversa com a Evolution, os avisos de mensagem, o motor de IA (provedores, chaves guardadas com cadeado), o treinamento, o atendente de IA (quando responde, quando cala, quando passa para uma pessoa) e as regras do banco (acesso, envio, eco, leitura, depósito de arquivos, a vez da IA). |
| Montagem | `npm run build` | O painel monta para produção. |
| Navegador | `npm run test:e2e` | 259 testes num navegador de verdade, em tela de computador e de celular (mais 13 que só valem para uma das duas telas). |

Na primeira vez, os testes de navegador pedem: `npx playwright install chromium`.

### Como os testes protegem os dados

- **Banco** (`supabase/tests`): sobem um Postgres de verdade na memória, aplicam as migrações e
  conferem, tabela por tabela, que uma empresa não lê os dados de outra, que visitante sem login
  não lê nada e que o navegador não consegue fazer o que é trabalho do servidor.
- **Retrato do banco real** (`impressao-digital.remoto.json`): um teste compara o banco montado a
  partir do Git com o banco real. Se alguém mudar o banco por fora, o teste acusa.
- **Navegador** (`web/e2e`): usam um "Supabase de mentira" com contas inventadas (inclusive o
  depósito de arquivos), uma "Evolution de mentira" e uma "IA de mentira" (Gemini, OpenRouter e
  NVIDIA) que respondem no mesmo formato das verdadeiras, com cópias das respostas de erro reais.
  Nenhum teste encosta no banco real, cria chip de verdade, manda mensagem para ninguém nem gasta
  chave de IA.

## Regras da casa

1. **Segredo não vai para o Git.** Só `web/.env.example` é versionado. No painel só entra a chave
   *pública* do Supabase; a chave secreta (service_role) nunca aparece no código do navegador.
2. **Migração aplicada não se edita.** Toda mudança no banco é um arquivo novo em
   `supabase/migrations/`, com teste. Só vai para o banco real depois de passar nos testes daqui;
   se a mudança apagar algum dado que já existe, o dono é consultado antes.
3. **Uma coisa, um lugar.** Menu em `web/src/lib/navegacao.ts`, moldura em
   `web/src/components/casca/`, cada tela na sua pasta em `web/src/app/`.
4. **Nada finge funcionar.** Tela que ainda não foi refeita diz isso com clareza.
5. **Tudo em português**, na tela e no código.

## Variáveis de ambiente

Explicadas uma a uma em [web/.env.example](web/.env.example).

| Variável | Para quê |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Endereço do projeto Supabase. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Chave pública do projeto. |
| `AUTH_DOMINIO_USUARIO` | (Opcional) Domínio interno dos logins por nome de usuário. Padrão: `zapia.local`. |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` | (Servidor) Endereço e chave da Evolution, para conectar chips e enviar mensagens. |
| `SUPABASE_SERVICE_ROLE_KEY` | (Servidor, segredo) Gravar os avisos da Evolution, guardar os arquivos recebidos e fazer o atendente de IA responder. |
| `IENVIA_URL_PUBLICA` | (Servidor) Endereço público do painel, para a Evolution avisar. Na Vercel não precisa. |
| `IENVIA_CHAVE_DOS_SEGREDOS` | (Servidor, segredo) Cifra as chaves de IA de cada cliente antes de gravar no banco. Sem ela, o painel não guarda nem usa chave de IA. |
| `IENVIA_ATENDENTE_ORCAMENTO_MS` | (Servidor, opcional) Tempo total que o atendente de IA tem para responder uma mensagem. Padrão: 55000 (cabe numa hospedagem que corta o pedido em 60 s). |

As chaves de IA (Google Gemini, OpenRouter e NVIDIA) **não** são variáveis de ambiente: cada dono de
conta cadastra as suas na tela Motor de IA.
