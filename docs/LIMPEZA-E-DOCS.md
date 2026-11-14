# Limpeza do workspace e documentação — 12/11/2026

## 1. Limpeza (168 MB → 38 MB, sem perder nada)

| O que saiu | Tamanho | Por quê era seguro |
|---|---|---|
| `ienvia/web/auditoria-visual/ienvia-todas-as-telas.zip` | 29 MB | cópia compactada dos mesmos PNGs que já estão no GitHub |
| `ienvia/web/auditoria-visual/todas-as-telas/` | 32 MB | duplicata exata da galeria já publicada (commit `e994e22`) |
| `ienvia/auditoria-visual/` (raiz) | 25 MB | 126 arquivos versionados no Git (auditoria antiga) |
| `ienvia/auditoria/` | 5.8 MB | versionada no Git (Lighthouse + prints da landing) |
| `ienvia/web/auditoria-visual/{correcoes-12-11,clientes-saas}` | 6.6 MB | versionadas; e há prints novos da galeria |
| `.npm/` (cache do npm) | 244 MB | cache, recriado sozinho |
| `test-results/`, `*.zip` grandes | ~1 MB | artefatos de teste |

Preservado de propósito: prints da página do motor (voltaram para `ienvia/docs/auditoria-visual/motor/`),
`apoio-da-reconstrucao/` (25 MB, material do dono), `referencias/`, `uploads/`, `.env`.

`.gitignore` ganhou regra para provas visuais pesadas não voltarem ao snapshot.

## 2. Documentação criada (tudo em `ienvia/docs/`, já no GitHub)

| Arquivo | Para quê |
|---|---|
| `README.md` | **índice**: por onde começar + as 10 coisas que custam um dia + onde está cada coisa |
| `REGRAS-DA-CASA.md` | comandos, versão de Node, onde pôr cada arquivo, o que cada suíte protege e o ponto cego dela, checklist final |
| `BANCO-DE-DADOS.md` | 46 tabelas por área, 159 RPCs (convenção de nome), como migrar, como regerar o retrato, funções do motor |
| `PAINEL-E-TELAS.md` | as três camadas, as 14 rotas, componentes, estilo por tokens, padrões |
| `MOTOR-E-INTEGRACOES.md` | motor local v6.1 (página, loop, comandos, atualização assinada), Evolution, webhooks/failover, IA, mídia, ordem de investigação de bug |
| `ESTRUTURA-HOSPEDAGEM.md` | (já existia) infra medida |
| `SIMULACAO-LIMITE-VERCEL.md` | (já existia) plano B de hospedagem |
| `AUDITORIA-VISUAL.md`, `MOTOR-LOCAL-AUDITORIA.md`, `CHECAGEM-DEPLOY-MOTOR.md` | auditorias com medidas |

`README.md` da raiz agora aponta para `docs/README.md` na primeira linha útil.

## 3. Bugs reais encontrados e corrigidos nesta rodada

| # | Problema | Como apareceu | Correção |
|---|---|---|---|
| 1 | `npm run check` **quebrava** (`TS6142 --jsx is not set`, depois `TS2812`, `TS18048`, `TS2339`) | rodei `npm run check` de verdade com Node 24 | `shared/tsconfig.json` ganhou `jsx` + `lib dom`; 3 tipos de teste corrigidos |
| 2 | `VERSAO_ATUAL_DO_MOTOR` ainda era `6.0.0` enquanto `motor/package.json` era `6.1.0` | teste `motor-painel` comparava os dois | versão unificada em 6.1.0 + teste do `shared` ajustado |
| 3 | **Brecha**: `list_my_owner_workspaces()` executável por `anon` (visitante sem login) | `esquema.test.ts` ("visitante não tem permissão em nenhuma função") | `revoke ... from anon` na migração **e no banco de produção** |
| 4 | Retrato do banco (`impressao-digital.remoto.json`) desatualizado → teste de esquema falhava | `esquema.test.ts` | retrato regerado a partir do banco real (206 funções) |
| 5 | Node 20 no ambiente fazia 53 testes caírem como se fossem bug | `npm test` antes de instalar Node 24 | documentado em `REGRAS-DA-CASA.md`; nada a corrigir no código |

## 4. Estado final medido

- `npm run check`: **0 erros**. `npm run lint`: limpo.
- `npm test`: **1031/1031** em 54 arquivos.
- `motor`: **8/8**.
- GitHub `main`: commit `7ea9218080c6` (docs + correções).
- Produção (`app.ienvia.online`): deploy automático no push; pacote do motor v6.1.0 assinado.
