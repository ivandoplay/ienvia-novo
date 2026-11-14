# Simulação: e se bater o limite da Vercel? (medido em 12/11/2026)

Não é para usar agora: é o mapa do que já existe, o que sai caro e quanto tempo levaria cada caminho.

## Resumo em três linhas

1. **O código não está preso à Vercel**: nenhum pacote `@vercel/*`, nenhum `runtime = 'edge'`, nenhum `waitUntil`.
   Só **um** arquivo usa sistema de arquivos (`src/lib/motor/pacote.ts`, o gerador do .zip do motor).
2. **Já existem rotas de saída prontas no repositório**: `netlify.toml`, `render.yaml`, suporte a Docker (VPS), o Worker
   `cloudflare/porteiro` e a Edge Function `evolution-webhook` (ACTIVE).
3. **A saída mais rápida não é trocar de plataforma**: é a que já está meio construída — o painel na **Netlify** (o site
   reserva existe e responde), com a Vercel de volta depois. Trocar de host "de verdade" leva de 4 h a 3 dias,
   dependendo do destino.

## Inventário medido (o que está de pé hoje)

| Peça | Estado real |
|---|---|
| Painel na Vercel | produção READY, região `gru1` (São Paulo) |
| Painel na **Netlify** | site `superb-tapioca-aaf330`, **de pé**: `/api/saude → {"ok":true}`, deploy de 13/11, commit `55b696f8` — conteúdo **antigo** (motor v6.0.0) |
| Painel na **Render** | `render.yaml` existe no repositório, **nunca foi criado** (`/api/saude` → 404) |
| Function `evolution-webhook` (Supabase) | **ACTIVE**, `verify_jwt: false` (é o destino principal dos webhooks) |
| Worker `cloudflare/porteiro` | código pronto no repositório; **não consegui confirmar se está publicado** — o token da Cloudflare no `.env` é recusado (`Authentication error`) |
| Keychain de IA | 3 provedores só por HTTP (`OPENROUTER`, `GEMINI`, `NVIDIA`) — nada muda ao trocar de host |
| Banco / Storage / Auth | Supabase, fora do host — **não muda nada** numa migração de front |
| Cron | 3 rotas (`agendamentos`, `campanhas`, `retencao`), cada uma com `maxDuration = 60` |

## Por que a troca é mais fácil do que parece

- O painel é **Next.js puro** com banco/arquivos/login fora dele (Supabase). O host só executa funções.
- **Zero** pacotes exclusivos da Vercel; **zero** função em Edge Runtime; **zero** streaming/SSE de longa duração.
- `after(...)` (usado em 4 lugares) é API do próprio Next — funciona igual em qualquer host de Node.
- O maior pedaço de mídia (áudios/fotos) já vai **direto do navegador para o Supabase** (`/_deposito/`), então trocar de
  host não muda o tráfego pesado.

## Os 4 pontos que exigem trabalho em QUALQUER troca

1. **Cron das 3 rotas** — cada host tem outro agendador (ou nenhum). Na Vercel grátis é 1×/dia; o Worker `porteiro` já tem
   `crons = ["* * * * *"]`, o que resolve o minuto a minuto sem host.
2. **Gerador do `.zip` do motor** (`pacote.ts` usa `node:fs`) — precisa de host com Node e com o repositório inteiro
   (o `next.config.ts` já declara `outputFileTracingIncludes` para isso). Funciona na Netlify/Render/VPS; **não** funciona
   em Cloudflare Workers.
3. **`maxDuration = 60`** em 7 arquivos — no plano grátis de alguns hosts o teto é 10 s (Netlify Functions) ou 30 s. Vai
   precisar de plano pago ou fatiar as rotas.
4. **Domínio e DNS** — `app.ienvia.online` já é CNAME para a Vercel. Trocar = apontar o CNAME para o novo host (5 min) +
   emissão de certificado. O apex (`ienvia.online`) está no Cloudflare e não muda.

## Estimativa por destino (trabalho de execução, não de espera)

| Destino | O que fazer | Tempo realista |
|---|---|---|
| **Netlify** (já tem site) | religar o deploy do site reserva, pôr as variáveis, apontar CNAME | **2–4 h** (meio dia com conferência) |
| **Render** (blueprint pronto) | criar o Blueprint, variáveis, apontar CNAME; plano grátis dorme após 15 min | **3–5 h** |
| **VPS com Docker** (Hostinger/Contabo, ~R$ 25–40/mês) | escrever Dockerfile + subir Traefik/Nginx + cron do sistema + backup; aqui o `.zip` do motor e os crons ficam mais fáceis que em serverless | **1–2 dias** (é a opção mais robusta) |
| **Cloudflare Workers/Pages** | reescrever o gerador do `.zip` (não tem `node:fs`), trocar `after()` e as rotas longas | **1–3 dias** — não recomendo como primeira saída |

## O que NÃO quebra em nenhuma das trocas

Banco, dados, arquivos, login, senhas, tokens dos chips, aparelhos pareados e o motor local. O motor só precisa continuar
alcançando `/api/motor/*` no domínio — e como ele lê `panelUrl` da configuração, um `--url` novo resolve.

## Riscos reais (o que eu olharia antes)

1. **Deriva entre Vercel e Netlify**: hoje os dois estão em commits diferentes (Netlify 13/11, Vercel 12/11 à noite). Um
   "reserva" que não recebe deploy **não é reserva** — é um museu. Vale ligar o deploy automático da Netlify na `main`.
2. **Worker `porteiro` possivelmente não publicado** — se ele for a porta de entrada dos webhooks, conferir isso é mais
   urgente que qualquer migração.
3. **Limite que costuma estourar primeiro** não é banda, é **tempo de função e número de invocações** (a Inbox consulta
   "mudou alguma coisa?" a cada poucos segundos — o que mais consome). Vale medir isso antes de decidir mudar de casa.
