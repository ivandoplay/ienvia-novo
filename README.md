# Ienvia

Atendimento inteligente e CRM para WhatsApp: vários chips, atendente de IA, caixa de entrada,
campanhas e contas separadas por cliente.

**Quem vai mexer no código (pessoa ou IA): comece por [docs/README.md](docs/README.md)** — é o índice que
aponta as regras da casa, a infra, o banco, as telas e o motor, com os erros que já custaram tempo.

Para saber **onde fica cada arquivo e o que cada função faz**, use
[docs/MAPA-DO-CODIGO.md](docs/MAPA-DO-CODIGO.md): é o mapa arquivo por arquivo, com as telas, os dados,
as ações de servidor, as rotas de API, as RPCs do banco, os dublês de teste e as armadilhas.

Esta é a **reescrita limpa** do sistema antigo (`zap-ia-studio`). O plano completo, com as fases e
as decisões, está em [docs/PLANO.md](docs/PLANO.md). A lista do que fica e do que sai está em
[docs/O-QUE-FICA-E-O-QUE-SAI.md](docs/O-QUE-FICA-E-O-QUE-SAI.md). Para ver tudo num lugar só (como o
trabalho é feito, o que já foi feito e testado, o que falta e o que é cada arquivo), leia
[docs/DOCUMENTACAO-DO-PROJETO.md](docs/DOCUMENTACAO-DO-PROJETO.md).

## Estado atual e continuidade

O resumo mantido está em **[docs/CONTINUIDADE.md](docs/CONTINUIDADE.md)**. Ele substitui resumos antigos de fases e explicita o que ainda não foi comprovado.

- Organização e recuperação: [docs/ORGANIZACAO.md](docs/ORGANIZACAO.md).
- Índice único dos testes: [tests/README.md](tests/README.md).
- Motor publicado: 6.4.1; alterações de documentação não mudam a versão do motor.
- Código, testes e documentos ficam no Git. Credenciais, sessões, listas e evidências pesadas ficam fora dele.
- Histórico de imagens não foi reescrito: artefatos antigos continuam no histórico Git; a cópia local foi arquivada privadamente.

## O que tem em cada pasta

```
web/         O painel (Next.js) e a rota reserva de webhooks.
shared/      Regras usadas pelo painel e pelo motor local (código puro, sem rede).
supabase/    O banco (migrações + testes de segurança) e a Edge Function `evolution-webhook`.
cloudflare/  Porteiro Cloudflare Worker (`porteiro/`) com filtro na borda e failover automático.
docs/        O plano, a lista do que fica e do que sai e a documentação do projeto.
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
| Regras e banco | `npm test` | 901 testes em 36 arquivos: login, menu, datas, chips, a Inbox, os arquivos (fotos, áudios, vídeos, documentos), a conversa com a Evolution, os avisos de mensagem, o motor de IA (provedores, chaves guardadas com cadeado), o treinamento, o atendente de IA (quando responde, quando cala, quando passa para uma pessoa), ensinar a IA pela conversa e as regras do banco (acesso, envio, eco, leitura, depósito de arquivos, a vez da IA, a revisão das bases de treinamento). |
| Montagem | `npm run build` | O painel monta para produção. |
| Navegador | `npm run test:e2e` | 279 testes num navegador de verdade, em tela de computador e de celular (mais 15 que só valem para uma das duas telas). |

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
| `IENVIA_URL_PUBLICA` | (Servidor) Endereço público do painel. Na Netlify (`URL`) e na Render (`RENDER_EXTERNAL_URL`) vem sozinho. |
| `IENVIA_WEBHOOK_URL` | (Servidor, recomendado) URL direta do webhook gravada nos chips (ex.: o porteiro Cloudflare Worker ou a Supabase Edge Function). Se vazia, usa `${IENVIA_URL_PUBLICA}/api/webhooks/evolution`. |
| `IENVIA_CHAVE_DOS_SEGREDOS` | (Servidor, segredo) Cifra as chaves de IA de cada cliente antes de gravar no banco. Sem ela, o painel não guarda nem usa chave de IA. |
| `IENVIA_ATENDENTE_ORCAMENTO_MS` | (Servidor, opcional) Tempo total que o atendente de IA tem para responder uma mensagem. Padrão: 55000 (cabe numa hospedagem que corta o pedido em 60 s). |

As chaves de IA (Google Gemini, OpenRouter e NVIDIA) **não** são variáveis de ambiente: cada dono de
conta cadastra as suas na tela Motor de IA.
