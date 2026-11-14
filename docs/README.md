# Ienvia — mapa para quem vai mexer (pessoa ou IA)

> **Leia este arquivo antes de qualquer coisa.** Ele existe para você (ou outra IA) não perder tempo nem repetir
> erros já resolvidos. Ordem sugerida: este arquivo → `docs/ESTRUTURA-HOSPEDAGEM.md` → `docs/INFRA-E-DEPLOY.md` →
> `docs/REGRAS-DA-CASA.md` → o documento da área que você vai tocar.
>
> Última revisão: 12/11/2026, com tudo medido (testes, deploy e banco conferidos na fonte).

---

## 1. O que é o sistema

Atendimento e CRM para WhatsApp, multiempresa: várias empresas (workspaces) no mesmo banco, cada uma com seus chips,
contatos, conversas, IA e equipe. O cliente entra em `app.ienvia.online`, conecta o WhatsApp (Evolution na nuvem **ou**
motor local no aparelho dele) e a IA pode atender sozinha, com repasse para uma pessoa.

Duas audiências, um só código:
- **cliente** (dono da empresa) — usa o painel em `app.ienvia.online`;
- **master da plataforma** — a mesma pessoa dona do produto, com a área "Clientes SaaS".

## 2. Peças e onde vivem (resumo; detalhe em `ESTRUTURA-HOSPEDAGEM.md`)

| Peça | Pasta | Roda em |
|---|---|---|
| Painel ( Next.js 16, App Router) | `web/` | Vercel, região `gru1`, domínio `app.ienvia.online` |
| Site institucional (estático) | `landing/` | Cloudflare Pages, `ienvia.online` |
| Regras puras compartilhadas | `shared/` | importado por `web/` e por testes; **sem rede, sem banco** |
| Banco + Auth + Storage + Edge Function | `supabase/` | Supabase `IENVIA-001` (Postgres 17, `sa-east-1`) |
| Motor local do WhatsApp | `motor/` | máquina do cliente (PC, VPS ou Termux) |
| Porteiro de webhooks | `cloudflare/porteiro/` | Cloudflare Worker (filtro na borda + failover) |

## 3. Os cinco lugares que você vai usar

| Preciso… | Vá para |
|---|---|
| saber como rodar, testar e conferir | `docs/REGRAS-DA-CASA.md` |
| saber onde fazer deploy e com qual token | `docs/INFRA-E-DEPLOY.md` |
| mexer no banco (migração, RPC, RLS) | `docs/BANCO-DE-DADOS.md` |
| mexer em tela do painel | `docs/PAINEL-E-TELAS.md` |
| mexer em IA, chips, webhooks, motor local | `docs/MOTOR-E-INTEGRACOES.md` |
| auditá ou achar bug (o que já foi medido) | `docs/AUDITORIA-VISUAL.md`, `docs/MOTOR-LOCAL-AUDITORIA.md`, `docs/CHECAGEM-DEPLOY-MOTOR.md` |

## 4. As dez coisas que fazem alguém perder um dia aqui

1. **Node 24 é obrigatório.** Com Node 20 o `vitest` quebra de um jeito confuso (`Map.groupBy is not a function`) e
   dezenas de testes de banco caem como se fossem bug de código. Há `.nvmrc` com `24`. Confira `node -v` antes.
2. **`npm ci` na raiz é obrigatório** em qualquer ambiente novo — sem ele, `vitest: not found`. O `motor/` tem
   `node_modules` próprio.
3. **`tsc --noEmit` isolado mente** (`Cannot find name 'PageProps'`) porque o Next gera tipos no build. Rode
   `npm run build -w web` antes de checar tipos.
4. **Migração aplicada não se edita.** Mudança no banco = arquivo novo em `supabase/migrations/` com data/hora. Se
   mexer numa migração antiga, o teste de esquema acusa (comparando com o retrato do banco real).
5. **O retrato do banco é o juiz.** `supabase/tests/impressao-digital.remoto.json` guarda o md5 de cada categoria do
   banco real. Depois de aplicar migração no Supabase, **regenere** esse arquivo (ver `BANCO-DE-DADOS.md`), senão o
   teste `esquema.test.ts` falha e você vai caçar bug onde não tem.
6. **A conta de serviço não é dona de nada.** `service_role` faz `auth.uid()` virar `null`. Se sua rota chama uma
   função que confere dono, chame com o **token do usuário**. (Foi exatamente um bug real em 12/11.)
7. **`app.ienvia.online` devolve 200 (não 404) para rota que não existe** — porque o Next serve a página de erro.
   Para saber se uma rota existe, olhe o **corpo** da resposta, não só o status.
8. **Segredo só em `/home/user/.env`** (fora do repositório) e nas variáveis da Vercel. Nunca no código, nunca em doc,
   nunca em resposta no chat.
9. **Teste com banco falso tem limite**: `web/e2e` usa Supabase/Evolution/IA de mentira. Passar ali não prova que
   funciona com o banco real — foi assim que o bug do `service_role` passou.
10. **Tudo em português**: telas, mensagens de erro, nomes de função e comentários. Não traduza nada para inglês.

## 5. Estado atual (o que está pronto e o que não está)

- **Telas**: 27 telas no painel + área do master. Todas com print em `web/auditoria-visual/` (no GitHub) e a galeria
  `todas-as-telas/galeria.html` no commit `e994e22`.
- **Banco**: 27 migrações, 46 tabelas com RLS, 52 políticas, 4 funções do master, motor local completo.
- **Testes**: 1031 testes (vitest, 54 arquivos), 8 do motor local, Playwright 381 + 54 de telas.
- **Motor local**: v6.1.0, página inicial própria (`127.0.0.1:4599`), pareamento por código **ou** e-mail/senha.
- **Fases do plano**: veja `docs/PLANO.md`; pendências abertas em `docs/AUDITORIA-VISUAL.md` (seção "Pendências").

## 6. Como este conjunto de documentos é organizado

```
docs/
├── README.md                     ← índice e por onde começar (você está aqui)
├── REGRAS-DA-CASA.md             ← como trabalhar: comandos, testes, estilo, o que não fazer
├── INFRA-E-DEPLOY.md             ← onde roda o quê e como publicar (tokens, domínios, regiões)
├── ESTRUTURA-HOSPEDAGEM.md       ← inventário medido da infra + custos/limites
├── BANCO-DE-DADOS.md             ← tabelas, RPCs, RLS, migrações, retrato do esquema
├── PAINEL-E-TELAS.md             ← arquitetura do front, menu, componentes, estilos
├── MOTOR-E-INTEGRACOES.md        ← motor local, Evolution, webhooks, IA, mídia
├── PLANO.md                      ← o plano de fases e as decisões do dono
├── O-QUE-FICA-E-O-QUE-SAI.md     ← lista de cortes aprovada
├── DOCUMENTACAO-DO-PROJETO.md    ← documento histórico longo (linha do tempo detalhada)
├── AUDITORIA-VISUAL.md           ← auditoria tela por tela + pendências
├── MOTOR-LOCAL-AUDITORIA.md      ← auditoria do motor local com medidas
├── CHECAGEM-DEPLOY-MOTOR.md      ← verificação de deploy (e o bug que foi achado)
├── SIMULACAO-LIMITE-VERCEL.md    ← plano B se a Vercel estourar
├── INSTAGRAM-ESTADO-E-PAUSA.md, PLANO-INSTAGRAM.md  ← Instagram (pausado)
└── auditoria-visual/motor/*.png  ← prints da página do motor
```

Regra de manutenção: **este índice e os cinco documentos temáticos são a fonte**. Documento antigo que conflitar
com eles está velho — corrija o antigo ou aponte para o novo, nunca deixe os dois discordarem em silêncio.
