# Instagram — estado da pausa (14/11/2026)

> Decisão: **parar a frente do Instagram por enquanto.** Bloqueio é burocrático (Meta), não técnico.
> Este arquivo existe para o "depois" não custar redescobrir nada.

## Onde paramos

O laboratório existe, está no ar e **funciona** — o que falta é uma credencial válida da Meta.

| Peça | Estado |
|---|---|
| Worker no ar | ✅ `https://lab-instagram.ivanjeffersong8.workers.dev` |
| Webhook (desafio + assinatura HMAC) | ✅ testado e aprovado |
| Recebimento de DM | ✅ testado com payload assinado |
| Story reply reconhecida | ✅ testado |
| Envio pela API | ✅ código pronto (não exercitado com token real) |
| Conta do Instagram conectada | ❌ **não conectada** — bloqueio |
| App publicado (Live) | ❌ em modo desenvolvimento |

Como não há conta conectada, **nada chega no laboratório**. Ele pode ficar no ar sem risco.

## Os dois erros que travaram

1. **`Invalid platform app`** — o Instagram Login exige o *Instagram App ID*, não o App ID do Facebook
   (`1603838434378477`). Ficam em *Instagram → Configuração da API com login do Instagram →
   configurações do login*.
2. **Usuário do sistema** — a tela de função do app recusa usuário do sistema
   ("does not resolve to a valid user ID"). Não é necessário em modo de desenvolvimento:
   o `@ienvia.oficial` já é **Testador do Instagram** no app, o que basta para autorizar.

## O que retomar (na ordem, ~15 minutos)

1. Olhar a tela *Instagram → Configuração da API* e responder: **existe "ID do app do Instagram" ali?**
   - **Sim** → pegar ID + segredo → `.env` (`IG_APP_ID`, `IG_APP_SECRET`) → botão **Conectar Instagram**
   - **Não** → apps novos só têm Unified Login → usar botão **Conectar pelo Facebook**
     (exige o `@ienvia.oficial` vinculado a uma **Página do Facebook**)
2. Conectar e conferir no painel se aparece `@ienvia.oficial` com IGSID `17841410791678547`.
3. Mandar DM de outra conta e ver chegar.
4. Se não chegar: testar a hipótese do `instachat` — *"em modo de desenvolvimento o webhook não
   entrega eventos; precisa estar Ao vivo"*. Confirmar ou derrubar antes de publicar nada.

## Credenciais guardadas

`/home/user/.env` (chmod 600, fora do repositório):

- `META_APP_ID`, `META_APP_SECRET` — app "ienvia" (`1603838434378477`)
- `META_SYSTEM_USER_TOKEN` — SUAT válido, **não expira**, mas preso ao `@ivan.dnr1`
- `IG_BUSINESS_ID=17841410791678547` (`@ienvia.oficial`), `IG_USERNAME`
- `FB_LOGIN_CONFIG_ID=1860494201629499`
- `IG_VERIFY_TOKEN=ienvia-teste-2026`

> Pendência de higiene: o App Secret passou pelo chat. Regenerar em
> *Configurações → Básico → Redefinir* quando retomar (10 segundos, anula o valor exposto).

## O que o laboratório ensinou (vale para o produto, não só para o teste)

1. O conector é a parte **fácil**. O cadastro na Meta é o gargalo.
2. `gerar token` só inclui os ativos marcados **naquele momento** — anexar depois exige token novo.
3. Cada workspace precisa de **credencial própria** (modelo BYOA) — decisão que já está na §11 do
   `PLANO-INSTAGRAM.md` e continua válida.
4. Webhook precisa de **URL fixa**. Sandbox e preview não servem. (Foi por isso que virou Worker.)
5. Sem conta conectada, nada chega e **nenhum erro aparece** — é o problema silencioso que vai exigir
   alerta de saúde da conexão no produto.

## Pastas

| Caminho | O que é | Ação |
|---|---|---|
| `ienvia/laboratorio-instagram/worker.js` | o laboratório (Cloudflare Worker) | manter — é a base do conector |
| `ienvia/laboratorio-instagram/COMO-CONECTAR.md` | passo a passo + diagnóstico | manter |
| `ienvia/laboratorio-instagram/laboratorio-instagram.mjs` | versão local (Node) | manter como referência |
| `referencias/instachat` | clone do projeto MIT para comparação | **pode apagar** (10 MB) |

Para apagar o clone: `rm -rf /home/user/referencias/instachat`
Para tirar o laboratório do ar: remover o Worker `lab-instagram` no painel da Cloudflare
(ou reaproveitar ele como base do conector do Ienvia).
