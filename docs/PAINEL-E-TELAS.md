# Painel — arquitetura, telas e estilo

> `web/` — Next.js **16.4.6** (App Router, Turbopack), React, TypeScript estrito. Roda na Vercel (região `gru1`).
> Tudo em português: rotas, textos, nomes de arquivo, comentários.

## 1. As três camadas (não misture)

```
web/src/app/          ← rotas e telas (Server Components por padrão)
web/src/lib/dados/    ← leitura/escrita no banco (uma função por caso de uso)
web/src/lib/<área>/   ← regra de negócio da área (sem JSX)
shared/src/           ← regra pura usada por painel E motor (sem rede, sem banco)
```

Regra: **tela não fala com o banco direto**. Tela → `acoes.ts` (server action) → `lib/dados/*` → Supabase.

## 2. Telas (rotas do App Router)

| Rota | Grupo no menu | O que faz |
|---|---|---|
| `/visao-geral` | Workspace | painel de números da operação |
| `/inbox` | Workspace | conversas do WhatsApp, contatos, Kanban, ficha e histórico por chip |
| `/campanhas` | Workspace | disparo em lote com prévia, intervalos e acompanhamento |
| `/treinamento` | Inteligência artificial | identidade do negócio, regras, FAQs, arquivos, modelos por ramo |
| `/catalogo` | Inteligência artificial | produtos com fotos + PIX que a IA pode enviar |
| `/audios` | Inteligência artificial | áudios na voz do dono, enviados como mensagem de voz |
| `/simulador` | Inteligência artificial | testar respostas da IA antes de ligar |
| `/inteligencia-artificial` | Inteligência artificial | chaves Gemini/OpenRouter/NVIDIA, modelos, fallback |
| `/instancias` | Canais e conexões | conectar chip (QR ou código de 8 dígitos), apelido, função |
| `/conexoes` | Canais e conexões | motor local: versão, download, aparelhos pareados |
| `/configuracoes` | Administração | marca, backup, dados da conta |
| `/seguranca` | Administração | anti-bloqueio, horário, alertas, contatos ignorados |
| `/contas` | Administração (**só master**) | Clientes SaaS: plano, cobrança, limite, suspender, modo suporte |
| `/login` | — | entrar com usuário ou e-mail (`shared/src/auth/usuario.ts`) |

O menu vive **só** em `web/src/lib/navegacao.ts` (`GRUPOS`, `ATALHOS_CELULAR`). `somenteMaster: true` esconde o item de
quem não é master. O menu do celular usa os atalhos + gaveta; não duplique itens em outro arquivo.

## 3. Componentes

| Pasta | O que tem |
|---|---|
| `components/casca/` | moldura do painel (`casca.tsx`, `moldura-do-painel.tsx`), busca global, menu da conta, botão de emergência da IA |
| `components/ui/` | peças reutilizáveis: `dialogo`, `interruptor`, `campo-de-texto`, `campo-de-data`, `campo-de-hora`, `icone` |
| `components/tema/` | `raiz-do-tema.tsx` — alterna escuro/claro por cookie |

Ao criar tela nova: use a moldura, importe peças de `ui/`, registre a rota no menu e na `fases.ts`.

## 4. Estilo (não invente cor)

- `styles/tokens.css` — **todas** as cores, raios, sombras e curvas. Cor nova nasce aqui.
- `styles/base.css` — reset e tipografia (fonte do sistema; o painel **não** usa Space Grotesk/Manrope/JetBrains Mono,
  essa identidade ficou na landing antiga — se for reintroduzir, é decisão do dono).
- `styles/casca.css`, `componentes.css` e uma folha por área (`inbox.css`, `contas.css`, `recursos.css`…).
- Tema escuro é o padrão; `data-theme="light"` no `<html>` liga o claro. Nunca use cor literal em JSX.
- O dono pediu explicitamente: **aprimorar, não redesenhar.** Mantenha a identidade visual.

## 5. Padrões que o projeto segue

- **Server Components** por padrão; `'use client'` só onde há estado/evento.
- Formulários usam **server actions** (`acoes.ts`) com `useActionState`.
- Erros de banco não vazam para a tela: cada `acoes.ts` traduz para uma frase em português.
- Nunca logar conteúdo de cliente (`next.config.ts` já desliga `logging.serverFunctions` porque os argumentos
  carregam chaves de IA e mensagens).
- `maxDuration = 60` está declarado em 7 rotas pesadas (inbox, simulador, crons, webhook, eventos do motor).
- Mídia **não passa pelo painel**: o navegador fala direto com o Supabase Storage (`lib/supabase/deposito.ts`);
  `/_deposito/` só existe em desenvolvimento.
- A Inbox atualiza por **Supabase Realtime Broadcast** e por uma rota leve `/api/inbox/versao` ("mudou alguma coisa?").

## 6. Telas auditadas

Cada tela tem print em celular (300 px) e computador (520 px). Galeria única:
`web/auditoria-visual/todas-as-telas/galeria.html` (commit `e994e22`). Roteiro que gera:
`web/e2e/telas-para-ver.spec.ts` (27 telas + `27-clientes-saas`).
Achados e pendências: `docs/AUDITORIA-VISUAL.md`.

## 7. Área do master (`app/(plataforma)/`)

`/contas` é a única tela: criar conta de cliente, plano, cobrança, limite de chips, suspender, entrar em **modo
suporte** auditado (`support_sessions`). Fechada em 14/11 pelo dono: "já tá bom do jeito que tá" — **não mexer**.
