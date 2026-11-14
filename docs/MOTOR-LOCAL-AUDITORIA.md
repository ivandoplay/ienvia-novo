# Motor local — auditoria com medidas (12/11/2026)

Objetivo declarado pelo usuário: **o motor deve iniciar com uma página (site local ou PWA), pedir o código de
pareamento OU usuário/senha da conta, e conectar os WhatsApps. A parte de conta/chip fica exclusiva no nosso site
(ienvia.online / app.ienvia.online); só o "ligar o motor ao sistema" pode rodar local.**

## Como está hoje (medido, não deduzido)

| # | Medida | Resultado |
|---|---|---|
| 1 | Existe página/servidor local no motor? | **Não.** `grep createServer\|listen(` em `motor/src/*.mjs` → **0 ocorrências**. O motor é 100% CLI. |
| 2 | Rodar `node src/index.mjs` sem parear | imprime `[motor] Aparelho ainda não pareado.` + `Execute: node src/index.mjs --url ... --pair ...` e sai com **exit 1**. |
| 3 | Conteúdo do `.zip` servido por `/api/motor/pacote` | **13 arquivos, 80 KB** (`package.json`, `src/` 7 arquivos, `scripts/` 5). Sem interface, sem página. |
| 4 | Rodar o comando que o site manda (Linux/Termux) | `setup-linux.sh` → exit 0 (instala deps). `./scripts/iniciar.sh --url ... --pair IENV-ABCD-2345` → `[motor] Pareando...` → `Erro fatal: Código inválido ou expirado.` **exit 1**. Fluxo funciona, mas é tudo terminal. |
| 5 | Motor guarda senha / 2FA / SMS? | **Não.** Nenhuma referência a senha em `motor/src` (só o erro de zip protegido por senha). O motor só conhece: código `IENV-XXXX-XXXX` → `deviceToken`. |
| 6 | "usuário e senha" no motor | Não existe. O único login por senha no projeto é o **Supabase auth do painel** (`signInWithPassword`, 2 ocorrências em `web/src`). |
| 7 | O que o site exige para gerar o código | **Login no painel + papel `owner`** (`acoes.ts:31-33`), nome do aparelho, código válido **15 min**, uso único. |
| 8 | Onde o motor busca o pareamento | `panelUrl` fixo (`--url` ou `data/motor.json`) → `POST {painel}/api/motor/parear`. Não há descoberta automática de domínio. |
| 9 | Onde o produto vive | `ienvia.online` = **site institucional** (200, Cloudflare) → manda para `app.ienvia.online` = **painel** (307 → `/login` quando não logado). `/conexoes` exige login (307 → `/login?voltar=%2Fconexoes`). |

## Conclusão da trilha "site exclusivo"

A exigência "a conexão dos chips fica exclusiva no nosso site" **já está cumprida**: nada de conectar WhatsApp
acontece no motor. O motor recebe comandos (`connect_qr`, `connect_code`, `disconnect`, `send_text`, `send_media`)
que o painel enfileira — ou seja, **quem manda conectar é o site**; o motor só executa o QR/código e devolve o
resultado. Não há nada a "tirar" do motor.

O que **não existe** é a parte que o usuário pediu: **o motor começar numa página local** em vez de um comando de
terminal. Isso é o trabalho real a fazer.

## O que eu vou construir (pendente de 1 resposta)

1. **Servidor local no motor** (`127.0.0.1`, porta livre, aberto automático no navegador) com:
   - campo **Código de pareamento** (`IENV-XXXX-XXXX`);
   - campo **e-mail/usuário + senha** (da conta Ienvia) como caminho alternativo;
   - botão "Ligar o motor" → grava `data/motor.json` → loop de pulso começa;
   - **status ao vivo**: aparelho, chips, conectado/desconectado, última mensagem, versão;
   - zero referência a QR/chip nessa página (isso continua só no site).
2. **Fallback sem interface**: se não houver navegador (VPS), a página também responde em modo texto e o
   `--pair` atual continua funcionando.
3. **Proteção**: escuta só em `127.0.0.1` + token local por arquivo, porque qualquer página aberta em
   `localhost` pode ser chamada por outros programas da máquina.

## Dúvida bloqueante (salva aqui em vez de ficar só no chat)

"usuário e senha da conta" — **de qual conta?** Se for a do Ienvia (mesmo e-mail/senha do painel), eu construo.
Se for a do WhatsApp, é preciso avisar: o WhatsApp não tem login por senha em nenhum cliente (Web, Desktop, API) —
só QR Code ou código de 8 dígitos. Se for a do Instagram, é o pareamento que ficou pausado em 14/11.

---

## O que foi construído (12/11/2026) — decisão do usuário: "os dois caminhos na mesma página"

### Motor local — `motor/src/pagina-local.mjs` (novo, 470 linhas)
- Servidor HTTP próprio escutando **só em `127.0.0.1`** (porta `4599`, ou `--porta N`), aberto no navegador
  automaticamente (`xdg-open` / `open` / `start`), com o token local em `data/local-web.json` (permissão 600).
- Duas abas: **E-mail e senha** e **Código de pareamento**, como o usuário pediu.
- Endereços do painel descobertos sozinho (`app.ienvia.online` → `ienvia.online`) — a pessoa não digita URL.
- Proteção: todo `POST /api/*` exige o cabeçalho `x-ienvia-local` com o token; sem ele, **403**.
- Nenhuma menção a QR/chip: conectar WhatsApp continua exclusivamente no painel.
- Depois de ligar, a página mostra aparelho, painel e "recebendo comandos", com botão "Ligar outro aparelho".

### Motor local — `motor/src/index.mjs`
- Sem pareamento: em vez de `exit 1` com uma linha de erro, **abre a página** e espera o pareamento
  (função `esperarPareamento`, fecha sozinha quando `data/motor.json` aparece).
- Novos parâmetros: `--sem-pagina` (VPS/servidor, comportamento antigo) e `--porta N`.
- `--pair` continua funcionando para quem preferir terminal.

### Painel — `/api/motor/parear-senha` (novo)
- Valida e-mail/usuário + senha pelo **Supabase Auth** (`grant_type=password`, mesmo caminho do `/login`).
- Se a pessoa administra mais de uma empresa, devolve `precisaEscolherConta` + lista para a página mostrar o seletor.
- Cria o aparelho via RPC nova e devolve `device_token`; **a senha não é gravada em lugar nenhum**.
- 429 do Supabase vira "Muitas tentativas seguidas"; erro de credencial vira a mesma mensagem para
  usuário inexistente e senha errada.
- Rota liberada no `proxy.ts` (o matcher já exclui `api/motor/`, conferido).

### Banco — `20261122120000_local_motor_password_pairing.sql` (aplicada em produção)
- `pair_local_executor_by_password(workspace_id, display_name, token_sha256)`: exige `auth.uid()` + dono do
  workspace, recusa token repetido, teto de 20 aparelhos por workspace em 24h, grava auditoria
  (`local_executor_paired_by_password`).
- `list_my_owner_workspaces()`: devolve `[{id,name}]` das empresas em que a pessoa é dona.
- `EXECUTE` só para `authenticated` (revogado de `anon`, conferido em `proacl`).

### Painel — tela Conexões / Motor
- Comandos passam a ser `./scripts/iniciar.sh --url <painel>` (sem `--pair`) e o texto explica as duas formas.
- Os três guias (Windows, Linux, Termux) ganharam o passo "na página que abrir, ligue com e-mail e senha
  **ou** com o código".
- `README.txt` do `.zip` reescrito com o fluxo novo.

### Provas
- `motor`: **8/8** testes (`test/pagina-local.test.mjs` cobre 403 sem token, gravação do pareamento por senha,
  senha nunca gravada em disco, token reaproveitado com permissão 600, escape de HTML).
- `web`: build OK, `tsc --noEmit` **0 erros**, `eslint` limpo.
- Prints: `web/auditoria-visual/motor/pagina-senha.png`, `pagina-codigo.png`, `pagina-erro.png`.

### Depende de deploy
- Enquanto o painel publicado for anterior a este commit, a aba **"E-mail e senha"** responde
  "O painel X ainda não tem a entrada por senha. Use o código de pareamento" (404 tratado).
- A versão do motor passa de **6.0.0 → 6.1.0**; o auto-update só entrega 6.1.0 depois do deploy.
