# Checagem honesta: "o site já foi atualizado mesmo?" (12/11/2026, 17:25 UTC)

Você perguntou se eu tinha certeza. **Não estava 100% certo — e ao conferir achei um erro meu.** Este documento
registra exatamente o que estava errado, o que foi corrigido e como isso foi provado.

## 1. O erro que eu introduzi (encontrado agora, não antes)

A rota `/api/motor/parear-senha` chamava a função do banco com a **chave de serviço** (`service_role`). Só que a
função `pair_local_executor_by_password` confere o dono da empresa com `auth.uid()` — e com a chave de serviço o
`auth.uid()` é **nulo**.

Medido:

```
auth.uid() com service_role  →  { "uid": null, "papel": null }
chamada da função como a rota fazia →  403 Workspace owner required
```

Ou seja: o fluxo "e-mail e senha" responderia **"Não foi possível ligar este aparelho agora"** para qualquer pessoa,
mesmo com a senha certa. O que eu te disse antes ("já responde, está no ar") era verdade só para o **caso de senha
errada**, que eu testei. Never testei o caminho de sucesso — foi uma falha minha.

## 2. O que foi corrigido

| Arquivo | Correção |
|---|---|
| `web/src/app/api/motor/parear-senha/route.ts` | passou a chamar a função com o **token do usuário** (o mesmo que já validou a senha), não com a chave de serviço |
| `supabase/migrations/20261122120000_local_motor_password_pairing.sql` | `EXECUTE` só para `authenticated` (estava também para `anon`) e comentário explicando o motivo |
| `motor/src/pagina-local.mjs` | passou a tratar **404** também no pareamento por código (painel desatualizado dá mensagem clara, não "código expirado") |

## 3. A prova do caminho de sucesso (logando de verdade)

Antes: `200` de mentira não existia — a rota devolvia erro.

Depois, com a conta de teste `teste-automatico@zapia.local`:

```
POST http://127.0.0.1:4701/api/motor/parear-senha   (build novo, local)
{ "executor_id": "b1b086dc-...", "workspace_id": "e123f9b6-...",
  "display_name": "Prova automatizada", "device_token": "70221af1..." }   [200]

POST https://app.ienvia.online/api/motor/parear-senha   (produção, deploy corrigido)
{ "executor_id": "687ad193-...", "display_name": "Prova em producao", "device_token": "a42ac6fd..." }   [200]
```

E o caminho de erro continua certo: senha errada → `401 {"erro":"E-mail ou senha incorretos."}`.

## 4. Cuidados que tive (e que você pode conferir)

- Criei uma senha temporária nessa conta de teste e, no fim, **restaurei a original**: o login com a senha do `.env`
  voltou a funcionar (`OK`).
- Os dois aparelhos criados pela prova (`Prova automatizada`, `Prova em producao`) foram **apagados**; sobrou apenas
  o `Aparelho 1` que já existia antes (`pending_pair`).
- A migração nova não estava no histórico do Supabase (aplicada por fora), então registrei a versão
  `20261122120000 local_motor_password_pairing` na tabela de migrações para o histórico não ficar mentindo.

## 5. Estado final verificado (17:25 UTC)

| Item | Situação |
|---|---|
| GitHub `main` | commits `644163070fe4` (motor), `dfd627e1365b` (rota), `b40fa000ae11` (migração) |
| Deploy de produção | **READY**, commit `644163070fe4` |
| `app.ienvia.online` | aponta para `ienvia-novo-avgw7l5qq…` (o deploy corrigido) |
| Pacote do motor | v**6.1.0**, assinado, `.zip` 27.005 bytes, com `src/pagina-local.mjs` |
| Rota por senha em produção | **200 no caminho de sucesso**, `401` na senha errada |
| Banco | 2 funções novas + migração registrada |
| Motor | 8/8 testes; build, `tsc` e eslint limpos |

## 6. O que ainda não está provado (honestidade)

- **A tela Conexões publicada com o texto novo**: não consegui abrir logado no navegador daqui (não tenho a sessão
  do navegador); o que conferi foi o arquivo no commit publicado (`127.0.0.1:4599` presente, `--pair` removido).
- **A página local do motor nunca foi usada com uma conta sua de verdade** — só com a conta de teste automática.
- **Nada disso foi testado com um chip real conectando WhatsApp**; o escopo aqui foi só ligar aparelho à conta.
