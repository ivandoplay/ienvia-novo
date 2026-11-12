# Porteiro Ienvia (Cloudflare Worker)

Porta de entrada única e gratuita (100 mil requisições/dia no plano Free, sem cartão) para os webhooks da Evolution API.

## Como funciona

1. Descarta na borda eventos que o Ienvia não usa (`PRESENCE_UPDATE`, `CHATS_UPDATE`, etc.) e requisições sem `Bearer`, sem acordar o Supabase nem o painel.
2. Encaminha eventos válidos (`MESSAGES_UPSERT`, `SEND_MESSAGE`, `CONNECTION_UPDATE`) primeiro para `DESTINO_PRINCIPAL` (Supabase Edge Function `evolution-webhook`).
3. Se o destino principal responder `402`, `404`, `429`, `5xx` ou demorar acima de `TIMEOUT_MS`, tenta automaticamente cada URL de `DESTINOS_RESERVA` (Netlify e/ou Render). A deduplicação por `p_event_id` no Postgres garante que nenhuma mensagem é gravada ou respondida duas vezes.

## Variáveis na Cloudflare

- `DESTINO_PRINCIPAL`: `https://SEU_PROJETO.supabase.co/functions/v1/evolution-webhook`
- `DESTINOS_RESERVA`: `https://SEU_PAINEL.netlify.app/api/webhooks/evolution,https://SEU_PAINEL.onrender.com/api/webhooks/evolution`
- `TIMEOUT_MS` (opcional): `12000`

Depois de publicar, coloque a URL do Worker (ex.: `https://ienvia-porteiro.SEU-SUBDOMINIO.workers.dev`) em `IENVIA_WEBHOOK_URL` nas variáveis do painel (Netlify/Render) e clique em conferir/reconectar os chips.
