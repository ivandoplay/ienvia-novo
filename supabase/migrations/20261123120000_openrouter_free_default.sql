-- ============================================================================================
-- Padrão do OpenRouter: `deepseek/deepseek-chat` → `openrouter/free`
--
-- Pedido do dono da conta (15/11/2026): o modelo que vem preenchido quando ninguém escolhe nada
-- (e o exemplo mostrado no Motor de IA) deixa de ser o DeepSeek e passa a ser o roteador gratuito
-- do OpenRouter. O `openrouter/free` ("Free Models Router") escolhe sozinho um modelo gratuito do
-- catálogo, custa zero e continua entendendo texto e foto — mas NÃO escuta áudio: transcrição de
-- áudio segue sendo só pelo Google Gemini.
--
-- Nada do que um cliente já escolheu é tocado: só muda o valor de coluna para linhas futuras e o
-- texto do JSON devolvido quando a empresa ainda não salvou nada no Motor de IA.
-- ============================================================================================

alter table public.workspace_ai_settings
  alter column openrouter_model set default 'openrouter/free';

create or replace function private.ai_settings_json(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object(
        'provider', s.provider, 'fallback_provider', s.fallback_provider,
        'second_fallback_provider', s.second_fallback_provider,
        'gemini_model', s.gemini_model, 'openrouter_model', s.openrouter_model, 'nvidia_model', s.nvidia_model,
        'temperature', s.temperature, 'max_history_messages', s.max_history_messages,
        'debounce_seconds', s.debounce_seconds, 'simulate_typing', s.simulate_typing,
        'split_long_messages', s.split_long_messages, 'pause_on_human_reply', s.pause_on_human_reply,
        'human_pause_minutes', s.human_pause_minutes,
        'admin_alert_enabled', s.admin_alert_enabled,
        'admin_alert_whatsapp', s.admin_alert_whatsapp,
        'admin_alert_events', to_jsonb(s.admin_alert_events),
        'admin_alert_include_messages', s.admin_alert_include_messages,
        'updated_at', s.updated_at)
     from public.workspace_ai_settings s where s.workspace_id = p_workspace_id),
    jsonb_build_object(
        'provider', 'gemini', 'fallback_provider', 'none',
        'second_fallback_provider', 'none',
        'gemini_model', 'gemini-3.5-flash-lite', 'openrouter_model', 'openrouter/free',
        'nvidia_model', 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        'temperature', 0.35, 'max_history_messages', 20,
        'debounce_seconds', 6, 'simulate_typing', true,
        'split_long_messages', true, 'pause_on_human_reply', true,
        'human_pause_minutes', 60,
        'admin_alert_enabled', false,
        'admin_alert_whatsapp', '',
        'admin_alert_events', jsonb_build_array('handoff','silent_handoff','uncertain_send','error','safety'),
        'admin_alert_include_messages', true,
        'updated_at', null))
$$;

revoke all on function private.ai_settings_json(uuid) from public, anon, authenticated;
