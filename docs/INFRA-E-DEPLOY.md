# Onde cada coisa vive e como publicar (Ienvia)

> Este arquivo existe para uma pergunta nunca mais precisar ser feita: **onde roda o quê e como
> publicar**. Se alguma informação aqui envelhecer, corrija este arquivo — ele é a fonte.
> Última verificação: 13/11/2026, com deploy real feito e conferido.

---

## 1. Mapa rápido

| Peça | Onde roda | Endereço | Como publica |
|---|---|---|---|
| **Painel / App** (Next.js) | **Vercel** — projeto `ienvia-novo` | `app.ienvia.online` | `git push` na `main` de `ivandoplay/ienvia-novo` (build automático) |
| **Landing** (HTML estático) | **Cloudflare Pages** — projeto `ienvia-landing` | `ienvia.online` | `npx wrangler pages deploy` a partir de `landing/` |
| **Banco / Auth / Storage** | **Supabase** | projeto `rhcabqlwazvjcjjdknsc` | migrations em `supabase/migrations/` |
| **Motor local** (opcional, no aparelho do cliente) | máquina do cliente | `localhost` | pacote em `motor/` |

**Nunca** se publica o app pelo Cloudflare Pages, nem a landing pela Vercel. São dois alvos separados.

---

## 2. Painel (Vercel) — detalhes que importam

| Item | Valor |
|---|---|
| Conta | `jeffersonivan748-7132` |
| Projeto | `ienvia-novo` |
| Repositório | `github.com/ivandoplay/ienvia-novo` (branch `main`) |
| **Root Directory** | `web` (o monorepo tem `shared/`, `web/`, `motor/`, `supabase/`) |
| Framework | Next.js (Turbopack) |
| Node na Vercel | `26.x` (o painel Vercel manda; local usa `.nvmrc` = 24) |
| Região | `gru1` (definida em `web/vercel.json`) |
| Token salvo | `VERCEL_TOKEN_CONTA_NOVA` em `/home/user/.env` |
| Healthcheck | `GET /api/saude` → `{"ok":true,"servico":"ienvia-painel"}` |

### Publicar uma mudança de código

```bash
cd /home/user/ienvia
git add <arquivos>
git commit -m "tipo(escopo): mensagem"
git push origin main          # a Vercel builda sozinha em ~1-2 min
```

O remote **precisa** ser reconfigurado a cada sessão nova de trabalho, porque o `.git/config` (que
carrega o token na URL) é apagado entre sessões por ser caminho sensível:

```bash
cd /home/user/ienvia
git remote set-url origin "https://x-access-token:$(grep '^GITHUB_TOKEN=' /home/user/.env | cut -d= -f2-)@github.com/ivandoplay/ienvia-novo.git"
```

### Conferir se o deploy subiu e qual commit está no ar

```bash
set -a; . /home/user/.env; set +a
curl -s -H "Authorization: Bearer $VERCEL_TOKEN_CONTA_NOVA" \
  "https://api.vercel.com/v6/deployments?projectId=ienvia-novo&limit=3" \
  | python3 -c "import json,sys,datetime;[print(datetime.datetime.fromtimestamp(x['createdAt']/1000,datetime.UTC).strftime('%d/%m %H:%M'), x.get('source'), x.get('target'), x['uid'], (x.get('meta') or {}).get('githubCommitSha','')[:8], x.get('readyState')) for x in json.load(sys.stdin)['deployments']]"
```

Estados: `BUILDING` → `READY` (no ar) ou `ERROR` (build quebrou; abrir o log pelo `uid`).
`aliasAssigned: true` significa que o deploy já está respondendo no `app.ienvia.online`.

**Atenção:** a URL direta do deploy (`ienvia-novo-xxxx.vercel.app`) tem **Deployment Protection**
(SSO da Vercel) e responde 302 para o vercel.com. Para testar use sempre `app.ienvia.online`.

### Antes de dar push (o mínimo)

```bash
npx -p node@24 node node_modules/vitest/vitest.mjs run --project shared --project web
cd web && npx -p node@24 node ../node_modules/typescript/bin/tsc --noEmit
```

O Node do sandbox é **20**, abaixo do exigido (`engines: 24.x`). Com o 20 o Vitest nem imprime o
relatório (`Map.groupBy`). Por isso o `npx -p node@24 node …` em tudo.

---

## 3. Landing (Cloudflare Pages)

```bash
cd /home/user/ienvia/landing
set -a; . /home/user/.env; set +a
unset CLOUDFLARE_API_TOKEN
npx --yes wrangler@3 pages deploy . --project-name=ienvia-landing --branch=main --commit-dirty=true
```

- Projeto Pages: `ienvia-landing`; zona Cloudflare `ienvia.online`.
- `_headers` cuida de CSP, cache dos arquivos e `/app.js` com `max-age=0, must-revalidate`.
- Não existe `_redirects` de propósito: o Pages já redireciona `*.html` para a rota sem extensão.
- Índice rápido: IndexNow (`api.indexnow.org`) aceita JSON e responde 202.
- Search Console: **sem credencial** guardada → envio de sitemap depende do dono fazer login.

---

## 4. Banco (Supabase)

- Projeto: `rhcabqlwazvjcjjdknsc` · token `SUPABASE_ACCESS_TOKEN` · service role em `.env`.
- Toda mudança de schema entra em `supabase/migrations/` com data no nome.
- Limites de treinamento conferidos em `supabase/migrations/20261112002400_ai_engine_and_training.sql`.

---

## 5. Coisas que já foram decididas (não perguntar de novo)

| Pergunta | Resposta |
|---|---|
| O painel roda em Vercel, Render ou Netlify? | **Vercel** (`ienvia-novo`). O `render.yaml` e o `netlify.toml` são planos reserva, não estão em uso. |
| Push no repo publica direto? | **Sim**, na Vercel, em produção, sem aprovação manual. |
| Precisa de `vercel` conectado no chat para publicar? | **Não**: o deploy é disparado pelo `git push`; o token `VERCEL_TOKEN_CONTA_NOVA` serve só para consultar estado. |
| Onde ficam as credenciais? | `/home/user/.env` (fora do repositório, nunca versionado). |
| O que conta como "no ar"? | Deploy `READY` + commit batendo em `app.ienvia.online` + `/api/saude` 200. |
| Node local vs Vercel? | Local 24 (`.nvmrc`); Vercel 26.x. Diferença conhecida, sem efeito prático até agora. |

## 6. Armadilhas já pagas (para não repetir)

1. **`.git/config` não persiste** entre sessões → o `git remote` volta vazio; reconfigurar sempre.
2. **`npm install` no sandbox mexe no modo dos scripts** em `motor/scripts/*.sh` (755 → 644). Rodar
   `chmod +x motor/scripts/*.sh` antes de commitar, senão entra ruído no diff.
3. **Build local ≠ build da Vercel**: nomes de chunk mudam a cada build, então comparar hash de JS
   não prova nada sobre o que está no ar. A prova é o **commit do deploy**.
4. **Não subir** `auditoria/`, `landing/` e `prompt-mestre/` junto com código do app: são entregáveis
   de trabalho, ficam fora dos commits (a não ser que a decisão seja colocá-los no repo).
5. **Nunca** commitar `.env` (o `.gitignore` já bloqueia, mas vale lembrar).
