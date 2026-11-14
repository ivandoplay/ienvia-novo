# Motor local, Evolution, webhooks e IA — como as peças conversam

> Tudo que é "fio" do sistema: o motor que roda no aparelho do cliente, o servidor Evolution, a Edge Function que
> recebe mensagens, o porteiro Cloudflare e os provedores de IA.

---

## 1. Motor local (`motor/`) — v6.1.0

Roda **no aparelho do cliente** (PC, VPS ou celular com Termux), em Node 22+. Não é serviço nosso: é um pacote
`.zip` que o painel entrega em `GET /api/motor/pacote` (assinado com Ed25519).

### Como a pessoa liga (fluxo novo, 12/11)

```bash
# 1. baixar e extrair (o painel mostra o comando pronto)
curl -fsSL https://app.ienvia.online/api/motor/pacote -o ienvia-motor.zip && unzip ienvia-motor.zip && cd ienvia-motor

# 2. instalar (baixa Node portátil se precisar)
bash ./scripts/setup-linux.sh        # ou setup-termux.sh / setup-windows.ps1

# 3. iniciar — abre a PÁGINA LOCAL sozinho no navegador
./scripts/iniciar.sh --url https://app.ienvia.online
```

A página (`http://127.0.0.1:4599`) oferece **duas** formas de ligar o aparelho:
1. **e-mail (ou usuário) + senha da conta Ienvia** → `POST {painel}/api/motor/parear-senha`;
2. **código de pareamento** `IENV-XXXX-XXXX` (15 min, uso único) → `POST {painel}/api/motor/parear`.

Parâmetros: `--sem-pagina` (servidor/VPS, comportamento antigo), `--porta N`, `--pair` (parear direto no terminal),
`--once`, `--check-update`.

### Regras que não se mudam
- **A página local não conecta WhatsApp.** Ela só liga o aparelho à conta. Conectar chip (QR ou código de 8 dígitos)
  é **exclusivo do painel**. Se alguém pedir para "conectar os WhatsApps no motor", releia
  `docs/MOTOR-LOCAL-AUDITORIA.md` antes.
- O motor **nunca** guarda senha. Guarda `deviceToken` em `data/motor.json` (0600).
- A página escuta **só** `127.0.0.1` e exige o token local (`data/local-web.json`) no cabeçalho `x-ienvia-local`.
- Não existe login por senha do WhatsApp: o cliente Baileys só aceita QR ou código de 8 dígitos.

### Loop principal (`src/index.mjs`)
| Intervalo | O que faz |
|---|---|
| 2,5 s | `GET /api/motor/comandos` → executa e completa cada comando |
| 25 s | `POST /api/motor/pulso` (heartbeat; reconecta sessão `connected` que tenha `creds.json`) |
| 10 min | `verificarEAtualizar` → se houver versão nova: aplica, sai com **código 42** e o launcher reinicia |
| — | `401` em qualquer chamada = token revogado → encerra |

### Sessões (`src/sessoes.mjs`)
`iniciarConexao(id, {mode:'qr'|'code', phone})`. Reconecta **4 s** depois de queda (exceto `loggedOut`) e **só** se
existe `creds.json`. Comandos aceitos: `connect_qr`, `connect_code`, `disconnect`, `clear_session`, `send_text`,
`send_media`. Eventos saem por `POST /api/motor/estado`.

### Atualização assinada
`GET /api/motor/versao` devolve manifesto + assinatura Ed25519; o motor confere a **chave pública embutida**
(`src/chave-publica.mjs`) e o hash SHA-256 do zip antes de aplicar (troca atômica, preserva `data/` e `.env`).
A chave privada fica só na Vercel (`IENVIA_MOTOR_SIGNING_PRIVATE_KEY_HEX`). **Mudou o código do motor?** suba a versão
em `motor/package.json` **e** em `shared/src/motor/regras.ts` (há teste comparando).

### Testes do motor
`cd motor && npm test` → 8 testes (`test/motor-runtime.test.mjs`, `test/pagina-local.test.mjs`): assinatura, zip
(membership e Zip-Slip), config, página local (403 sem token, senha não vai para o disco, escape de HTML).

---

## 2. Evolution (nuvem) — o outro caminho de chip

- Cliente em `web/src/lib/evolution/cliente.ts`; avisos em `aviso.ts` / `processar-aviso.ts`.
- Servidor atual: `EVOLUTION_API_URL` (hoje um servidor **PageUp**, terceiro — ver `ESTRUTURA-HOSPEDAGEM.md`).
- Regra: só criar/apagar instâncias cujo nome começa com `ienvia-`.
- **Armadilha conhecida:** `POST /message/sendText` em chip desconectado **não responde** (trava até o timeout) →
  envio incerto. Nunca reenviar sozinho; o banco tem estado "incerto" para isso.

## 3. Webhooks — três portas, uma verdade

```
Evolution ──► Cloudflare Worker "porteiro" ──► Edge Function evolution-webhook  (principal)
                     │                              ↑
                     └── failover ──► /api/webhooks/evolution (Vercel)  ou  Netlify/Render
```

- O Worker (`cloudflare/porteiro/`) descarta na borda eventos inúteis e evita acordar o banco.
- A Edge Function (`supabase/functions/evolution-webhook/`, **ACTIVE**, `verify_jwt: false`) é o destino principal;
  ela usa service_role e não tem sessão de usuário.
- A rota `web/src/app/api/webhooks/evolution/route.ts` é a reserva (usa `after()` para processar depois de responder).
- **Deduplicação** por `p_event_id` no Postgres: nenhuma mensagem é gravada ou respondida duas vezes. É isso que
  permite failover sem duplicar.
- Cada chip tem segredo próprio (`private.evolution_webhook_auth`).

## 4. IA

| Peça | Onde |
|---|---|
| Provedores (HTTP puro: Gemini, OpenRouter, NVIDIA) | `web/src/lib/ia/provedores.ts` |
| Cofre das chaves do cliente (AES-GCM com `IENVIA_CHAVE_DOS_SEGREDOS`) | `web/src/lib/ia/cofre.ts`, tabela `private.workspace_ai_secrets` |
| Regras do atendente (quando responde, quando cala, quando repassa) | `shared/src/` + `supabase` (`claim_ai_turn`, `ai_turns`) |
| Orçamento de tempo por resposta | `IENVIA_ATENDENTE_ORCAMENTO_MS` (padrão 55000, cabe nos 60 s da hospedagem) |
| Ensino pela conversa | `web/src/lib/ia/ensino.ts`, RPCs de revisão de base |

As chaves de IA **não** são variáveis de ambiente: cada cliente cadastra as suas na tela **Motor de IA**.

## 5. Mídia

- O navegador envia/recebe arquivos **direto** do Supabase Storage (`lib/supabase/deposito.ts`), bucket privado
  `midias` (limite 25 MB por arquivo).
- O painel só serve arquivos por rota quando o arquivo é da Inbox (`/api/inbox/midia/...`) ou da biblioteca
  (`/api/recursos/midia/...`), sempre conferindo permissão.
- Para o WhatsApp, áudio vai como **PTT (voz)**; conversão em `web/src/lib/audio/`.

## 6. Quando algo "não chega"

Ordem de investigação (já economizou horas):
1. O chip está `connected`? (`instances.status`, e `last_seen_at` do aparelho local)
2. O webhook chegou? (`webhook_events` tem o evento? qual porta recebeu?)
3. A mensagem foi gravada? (`messages` da partição do dia)
4. A IA respondeu ou calou por regra? (`ai_turns`: `claim`, motivo)
5. O envio saiu? (`outbox_jobs`: `sent` / `incerto` / `erro`)

Cada passo tem teste de banco correspondente em `supabase/tests/` — se um deles falhar, o bug está ali.
