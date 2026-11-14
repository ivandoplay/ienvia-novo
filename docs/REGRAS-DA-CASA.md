# Regras da casa — como trabalhar neste projeto

> Complementa o `README.md` da raiz. Aqui está o **como**: comandos exatos, o que cada teste protege e o que nunca
> fazer. Se você é uma IA chegando agora: leia `docs/README.md` primeiro, depois este.

## 1. Preparar o ambiente

```bash
node -v            # PRECISA ser 24.x (há .nvmrc). Com Node 20 os testes quebram de forma confusa.
npm ci             # na raiz, obrigatório (instala shared, web, supabase)
(cd motor && npm ci)   # o motor tem dependências próprias (Baileys, pino, qrcode)
```

Para o painel rodar:

```bash
cp web/.env.example web/.env.local   # preencher NEXT_PUBLIC_SUPABASE_URL e a chave pública
npm run dev                          # http://localhost:3000
```

Sem `.env.local` o painel sobe mostrando o que falta — isso é intencional, não é erro.

## 2. Os comandos

| Comando | O que faz | Tempo típico |
|---|---|---|
| `npm run check` | tipos (`shared`, `web`, `supabase`) | ~30 s |
| `npm run lint` | eslint do painel | ~15 s |
| `npm test` | 1031 testes (54 arquivos): `shared`, `web`, `banco` | ~80 s |
| `npm run test:unit` | só regras (sem banco) | ~10 s |
| `npm run test:db` | só banco (Postgres em memória + migrações) | ~60 s |
| `npm run build` | monta o painel (`web`) | ~45 s |
| `npm run test:e2e` | Playwright (precisa `npx playwright install chromium`) | ~5 min |
| `npm run verificar` | **tudo em ordem**, para no primeiro erro | ~7 min |
| `(cd motor && npm test)` | 8 testes do motor local | ~2 s |

**Regra de bolso:** antes de dizer que algo está pronto, rode `npm run verificar`. Se não pode rodar tudo, diga
exatamente o que rodou e o que não rodou — este projeto valoriza prova, não afirmação.

### Playwright no Linux (sandbox/CI)

```bash
npx playwright install chromium
sudo apt-get install -y libnspr4 libnss3 libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcups2 libgbm1 libxkbcommon0
```
Sem essas bibliotecas o Chromium morre com `error while loading shared libraries` — não é bug do projeto.

## 3. Como o código está organizado (e onde pôr o quê)

| Preciso… | Lugar certo |
|---|---|
| regra de negócio pura (sem rede/banco) | `shared/src/<área>/` |
| consulta/escrita no banco pela tela | `web/src/lib/dados/<área>.ts` |
| ação de servidor (`'use server'`) | `web/src/app/(painel)/<tela>/acoes.ts` |
| componente de tela | `web/src/app/(painel)/<tela>/` |
| moldura, menu lateral, tema | `web/src/components/casca/`, `web/src/lib/navegacao.ts` |
| estilo | `web/src/styles/<área>.css` (uma folha por área) |
| rota de API | `web/src/app/api/<nome>/route.ts` |
| chamada à Evolution | `web/src/lib/evolution/` |
| IA (provedores, cofre de chaves) | `web/src/lib/ia/` |
| regra do motor local no servidor | `web/src/lib/motor/` |
| função SQL nova | `supabase/migrations/<data>_<nome>.sql` |
| teste de banco | `supabase/tests/<área>.test.ts` |
| teste de regra | `shared/test/` ou `web/test/` |
| teste de navegador | `web/e2e/<área>.spec.ts` |

## 4. Cinco regras que não se quebram

1. **Migração aplicada não se edita.** Sempre um arquivo novo, com timestamp maior que o último. Se precisar corrigir
   algo já aplicado, escreva uma migração que **corrige** (`create or replace`, `revoke`, `drop ... if exists`).
2. **Nada de segredo no Git.** Só `web/.env.example`. A chave `service_role` nunca aparece em código de cliente
   (nada que chegue ao navegador). Segredos moram em `/home/user/.env` e nas variáveis da Vercel.
3. **Uma coisa, um lugar.** Menu só em `navegacao.ts`; moldura só em `components/casca/`; cores e espaçamentos só nas
   folhas de estilo (nada de estilo inline novo em JSX).
4. **Nada finge funcionar.** Tela que ainda não existe diz "em que fase fica pronta". Botão que não faz nada é bug.
5. **Tudo em português** — tela, erro, comentário, nome de variável de domínio.

## 5. O que cada suíte protege (e o ponto cego de cada uma)

| Suíte | Protege | Ponto cego |
|---|---|---|
| `shared/test` | regras puras (versões, datas, formatação, validações) | não vê banco nem tela |
| `web/test` | regras de tela e de servidor com dublês | não vê integração real |
| `supabase/tests` | RLS, permissões, funções, isolamento entre empresas, esquema | roda em Postgres em memória; não vê a função de borda |
| `web/e2e` | fluxos de tela com Supabase/Evolution/IA **de mentira** | **não prova nada contra o banco real** |
| `motor/test` | atualização assinada, zip, config, página local | não conecta WhatsApp de verdade |

Consequência prática: **um fluxo que só existe no mundo real precisa de prova manual** (ex.: pareamento por senha,
que em 12/11 passou nos testes mas falhava em produção por causa do `service_role`). Quando testar manualmente,
registre o comando e a resposta em `docs/` — foi assim que o `CHECAGEM-DEPLOY-MOTOR.md` salvou o dia seguinte.

## 6. Git e publicação

- Repositório: `github.com/ivandoplay/ienvia-novo` (privado), branch `main`.
- **Nunca `push --force`.** Nunca commitar `.env`, `node_modules`, `data/` do motor ou print pesado.
- O clone do sandbox pode ficar com histórico divergente do remoto. Se acontecer, **não** faça `reset --hard` em cima
  de trabalho não publicado: publique o arquivo pela API do GitHub (`PUT /repos/.../contents/...`), como foi feito em
  12/11, ou clone num diretório novo.
- Publicar = `git push` na `main` (a Vercel builda sozinha). Detalhes e tokens: `INFRA-E-DEPLOY.md`.

## 7. Checklist antes de dizer "está pronto"

- [ ] `node -v` = 24
- [ ] `npm run check` limpo (rodando **depois** do build, para os tipos do Next existirem)
- [ ] `npm run lint` limpo
- [ ] `npm test` 100% (ou justificar por escrito o que falhou e por quê)
- [ ] `(cd motor && npm test)` 100% se tocou em `motor/`
- [ ] Se mudou o banco: migração nova + retrato regerado + aplicado no Supabase + aviso no resumo
- [ ] Se mudou tela: print novo (celular e computador) em `web/auditoria-visual/`
- [ ] Se mudou versão do motor: `motor/package.json` **e** `shared/src/motor/regras.ts` (as duas!)
- [ ] Segredo nenhum no diff
- [ ] Resumo em português dizendo o que foi provado e o que não foi
