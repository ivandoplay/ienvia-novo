# Laboratório do Instagram — endereço fixo, no ar

> Endereço: **https://lab-instagram.ivanjeffersong8.workers.dev**

O laboratório saiu do ambiente temporário e virou um **Cloudflare Worker**: endereço fixo, sem
depender do sandbox e sem consumir Vercel (que está com soft block por fair use) nem Supabase
(organização com restrição de serviço). Guarda os eventos em KV por 7 dias.

## O que já foi provado de verdade (13/11/2026)

| Teste | Resultado |
|---|---|
| Desafio do webhook com token correto | ✅ devolveu o `hub.challenge` |
| Desafio com token errado | ✅ 403 |
| POST com assinatura HMAC válida | ✅ 200 e evento gravado |
| POST com assinatura falsa | ✅ 401 e registrado como `erro_assinatura` |
| DM de texto gravada com remetente, texto e `mid` | ✅ |
| Resposta de story reconhecida | ✅ `respondendoStory: true` |
| Painel HTML | ✅ 200 |
| Botão "Conectar Instagram" monta o OAuth certo | ✅ redireciona para `instagram.com/oauth/authorize` com `redirect_uri` correto |
| Envio pela API | código pronto — falta token real |

## Passo 1 — cadastrar o redirect no painel da Meta

No seu app (`1603838434378477`) → **API do Instagram → login unificado**:

1. **URL de redirecionamento** → registrar exatamente:

```
https://lab-instagram.ivanjeffersong8.workers.dev/oauth/callback
```

2. **Permissões** → deixar marcadas as do Instagram:
   - `instagram_basic`
   - `instagram_manage_messages` ← essencial
   - `instagram_manage_comments` (opcional)

## Passo 2 — conectar

Abra o painel e clique no botão azul:

👉 **https://lab-instagram.ivanjeffersong8.workers.dev**

- **Conectar Instagram** → usa os escopos novos (`instagram_business_*`)
- Se aparecer *"Invalid scope"*, use **Tentar com escopo antigo** → usa `instagram_basic`,
  `instagram_manage_messages` etc., que é o que a sua tela mostra

Depois de autorizar, o painel passa a mostrar **conectado**, o IGSID e a validade do token.

## Passo 3 — webhook

No painel da Meta → **Webhooks**:

| Campo | Valor |
|---|---|
| URL de retorno de chamada | `https://lab-instagram.ivanjeffersong8.workers.dev/webhook` |
| Token de verificação | `ienvia-teste-2026` |

Assinar os campos: **`messages`** (obrigatório), `messaging_postbacks`, e `comments` se quiser testar comentário→DM.

## Passo 4 — teste de verdade

1. Outra conta manda DM para o seu Instagram.
2. O painel mostra a mensagem, o IGSID e o `mid`.
3. Use o formulário "Enviar DM de teste" com o IGSID de quem mandou.
4. A resposta deve chegar no Instagram.

## Rotas disponíveis

| Rota | Serve para |
|---|---|
| `/` | painel |
| `/oauth/iniciar` | login do Instagram (escopos novos) |
| `/oauth/iniciar?escopo=antigo` | login com os escopos do caminho antigo |
| `/oauth/callback` | retorno do OAuth (cadastrar na Meta) |
| `/webhook` | webhook da Meta (GET verifica, POST recebe) |
| `/enviar` | envio de DM de teste (formulário do painel) |
| `/renovar` | renova o token por mais 60 dias |
| `/saude` | estado em JSON |
| `/eventos` | últimos 200 eventos em JSON |
| `/limpar` | apaga eventos e conexão |

## Segurança

- O **App Secret** está nas variáveis do Worker (não no código, não no repositório).
- Assinatura HMAC de todo POST é conferida; o que não confere é descartado com 401.
- O painel **não tem senha** — quem tiver a URL vê as mensagens que chegarem. É laboratório de teste;
  quando terminar, use `/limpar` e troque o App Secret.

## Limites conhecidos

- KV é eventualmente consistente: um evento recém-gravado pode demorar até ~60s para aparecer no painel.
- Token guardado no KV expira em 60 dias (mesmo prazo do token da Meta).
- Não guarda o corpo cru de todos os eventos — só o essencial (remetente, texto, mid, flags).

---

## Anexo: o problema do ativo (13/11/2026)

O token SUAT gerado em 13/11 é **válido e não expira**, com escopos
`instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `instagram_content_publish`.
Mas ele **não enxerga o @ienvia.oficial**. Diagnóstico feito pelo `/api-sistema` e pelo Graph:

| Verificação | Resultado |
|---|---|
| `debug_token` | `type: SYSTEM_USER`, `expires_at: 0` (não expira), `is_valid: true` |
| `me` | `ienvia System User` |
| `me/assigned_instagram_accounts` | **1 conta: `17841457992900733` = @ivan.dnr1** |
| `17841410791678547` (o ID do painel, @ienvia.oficial) | "object does not exist, cannot be loaded due to missing permissions" |
| `/me/accounts` (Páginas) | vazio |
| `business_id/owned_instagram_accounts` | exige `business_management` (o token não tem) |

**Conclusão:** o token está preso ao @ivan.dnr1 porque foi esse o ativo marcado ao gerar.
O @ienvia.oficial precisa ser **anexado ao usuário do sistema** e o token **regerado**.

Ordem correta (no Business Suite, não no painel de desenvolvedor):

1. Configurações do negócio → **Usuários → Usuários do sistema** → `ienvia System User`
2. **Adicionar ativos → Contas do Instagram → @ienvia.oficial** → acesso total
3. Se a conta não aparecer: **Contas → Contas do Instagram → Adicionar** e conectar o @ienvia.oficial ao portfólio
4. Só então: painel do app → configuração do login unificado → **Gerar token** de novo
5. Colar o token novo aqui → `/api-sistema` deve mostrar o ID `17841410791678547`

**Regra que fica:** `gerar token` só inclui os ativos marcados **naquele momento**. Anexar ativo
depois não atualiza token antigo — é preciso gerar outro. Isso vale também para o produto final.
