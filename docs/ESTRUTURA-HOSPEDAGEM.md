# Como a estrutura está funcionando hoje (medido em 12/11/2026)

Tudo abaixo foi conferido na fonte (API da Supabase, API da Vercel, DNS e requisições reais ao ar), não de memória.

## Resumo em uma linha
O site institucional fica na **Cloudflare**; o painel roda na **Vercel** (região São Paulo); o banco, o login e os
arquivos ficam na **Supabase** (São Paulo); os WhatsApps são dirigidos por um **motor local** no seu computador/celular
e, quando usam Evolution, dependem de um **servidor PageUp**.

## Mapa

| Peça | Quem hospeda | Detalhe medido |
|---|---|---|
| `ienvia.online` (site institucional) | **Cloudflare** | `server: cloudflare`, IPs proxied 172.67.142.182 / 104.21.46.227. `www` responde 200. |
| `app.ienvia.online` (painel) | **Vercel** — projeto `ienvia-novo` | `CNAME → cname.vercel-dns.com`, verificado. Build a partir de `web/`, framework Next.js. |
| Funções do painel | Vercel, região **gru1 (São Paulo)** | `x-vercel-id: pdx1::gru1::…` — o pedido entra por um ponto próximo e executa em São Paulo. |
| Banco de dados | **Supabase** projeto `IENVIA-001` | Postgres **17.11**, região **sa-east-1 (São Paulo)**, status `ACTIVE_HEALTHY`. |
| Arquivos/mídias enviados | **Supabase Storage** | bucket privado `midias` (limite 25 MB por arquivo), 81 objetos, 24 MB. |
| Login (e-mail/senha, sessões) | **Supabase Auth** | Mesmo projeto; é o que a nova página do motor usa. |
| WhatsApp — motor oficial | **Seu aparelho** (motor local) | Roda no PC/celular (Termux), fala com o painel por `/api/motor/*`. |
| WhatsApp — Evolution (alternativo) | **PageUp** (`pool-evolution-api-067.cloud2.pageup.dev.br`) | Servidor de terceiros, fora da nossa infraestrutura. |

## Números do banco agora

- Tamanho total: **20 MB** (o plano grátis da Supabase dá 500 MB).
- 46 tabelas em `public`, **todas com RLS ligado**, 52 políticas.
- 27 migrações em `supabase/migrations` (a última é a do pareamento por senha).
- Dados: 3 empresas, 3 vínculos de usuário, 1 aparelho local, 4 chips, 24 contatos, 575 mensagens (+699 na partição
  `messages_2026_11_13`), 545 eventos de webhook, 172 eventos de auditoria.
- Maiores tabelas: `messages` (520 kB), `objects` (416 kB), `schema_migrations` (336 kB), `webhook_events` (328 kB).

## Deploy

- Projeto: `ienvia-novo` (`prj_xh77MMsGuQkGtDKyAB2yuaTPl0QM`), root `web/`, domínio `app.ienvia.online` + alias `ienvia-novo-dusky.vercel.app`.
- **Deploy de 16/11/2026:** commit `e9bb3df` (`READY`, `aliasAssigned`, `app.ienvia.online`
  respondendo). O mesmo commit foi publicado no reserva Netlify (`superb-tapioca-aaf330`, 45 s,
  `ready`) e o travamento manual voltou a ficar ligado.
- O texto abaixo é do deploy anterior: **commit `e54610b`** (o do motor com página inicial). `/api/motor/versao` em produção serve
  **6.1.0 assinado** e `/api/motor/parear-senha` responde JSON de verdade (`401 E-mail ou senha incorretos`), ou seja,
  a entrada por senha do motor **já está funcionando no ar**.
- Não há deploy manual: cada push na `main` dispara o build.
- Região das funções: `gru1` (São Paulo), definida em `web/vercel.json`. Aceita apenas, sem PITR.

## Observações honestas (o que vale olhar)

1. **Site institucional apenas na Cloudflare** — não é Vercel/PageUp. Bom para o marketing; só registrar que é uma
   peça separada da infraestrutura do painel.
2. **Evolution na PageUp é dependência de terceiro.** Se cair, os chips Evolution param; os chips do motor local não.
   Os 4 chips existentes: vale confirmar quantos são de cada tipo.
3. **Backup:** `walg_enabled: true`, `pitr_enabled: false` e a lista de backups voltou vazia — no plano grátis da
   Supabase isso significa que não há restauração para um ponto no tempo. Para dados de clientes reais, isso é o ponto
   mais frágil da estrutura hoje.
4. **Cron:** existem três rotas de cron (`/api/cron/agendamentos`, `campanhas`, `retencao`) e um `CRON_SECRET`
   configurado. No plano grátis da Vercel, cron só roda uma vez por dia; vale conferir se os agendamentos precisam de
   mais frequência.
5. **Chaves duplicadas na Vercel:** há `SUPABASE_*` e `NEXT_PUBLIC_SUPABASE_*` para o mesmo projeto (algumas
   `production`, outras `production,preview,development`). Não quebra, mas confunde na hora de trocar chave.
