/**
 * Implementação em memória das tabelas e RPCs da Fase 5 (Campanhas, Pastas de Mídia,
 * Fila Segura, Proteção Anti-Ban, Horário de Atendimento, Alertas e Números Ignorados)
 * para o Supabase de mentira usado pelos testes E2E do Playwright.
 */
import crypto from 'node:crypto';
import { WORKSPACE_LOJA } from './dados.mjs';

export const FUNCOES_SEGURANCA_E_CAMPANHAS = [
  'read_my_security_settings',
  'save_my_security_settings',
  'list_my_ignored_numbers',
  'add_my_ignored_number',
  'remove_my_ignored_number',
  'read_my_proactive_queue',
  'start_my_proactive_queue',
  'pause_my_proactive_queue',
  'resume_my_proactive_queue',
  'clear_my_proactive_queue',
  'resolve_my_proactive_uncertain',
  'list_my_campaign_media',
  'create_my_campaign_media_folder',
  'register_my_campaign_media_file',
  'delete_my_campaign_media_file',
  'delete_my_campaign_media_folder',
  'list_my_campaigns',
  'read_my_campaign',
  'save_my_campaign_draft',
  'prepare_my_campaign_preview',
  'confirm_my_campaign',
  'pause_my_campaign',
  'resume_my_campaign',
  'cancel_my_campaign',
  'delete_my_campaign_draft',
  'resolve_my_campaign_uncertain',
];

const PADROES_SEGURANCA = {
  antiban_preset: 'equilibrado',
  simulate_typing: true,
  min_typing_ms: 1800,
  max_typing_ms: 5200,
  split_long_messages: true,
  debounce_seconds: 6,
  pause_on_human_reply: true,
  human_pause_minutes: 60,
  max_replies_per_minute_per_contact: 6,
  proactive_min_delay_sec: 45,
  proactive_max_delay_sec: 110,
  daily_proactive_limit: 25,
  schedule_mode: 'always',
  schedule_start: '08:00',
  schedule_end: '18:00',
  schedule_work_days: [1, 2, 3, 4, 5, 6],
  schedule_timezone: 'America/Fortaleza',
  off_hours_reply_message: '',
  admin_alert_enabled: false,
  admin_alert_whatsapp: '',
  admin_alert_events: ['handoff', 'silent_handoff', 'uncertain_send', 'error', 'safety'],
  admin_alert_include_messages: true,
};

function normalizarTelefone(bruto) {
  let d = String(bruto ?? '').replace(/@.+$/, '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && (d.length === 11 || d.length === 12)) d = d.slice(1);
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) {
    const ddd = Number(d.slice(0, 2));
    if (ddd >= 11 && ddd <= 99) d = `55${d}`;
  }
  return /^[1-9][0-9]{7,14}$/.test(d) ? d : null;
}

function miolo(bruto) {
  const limpo = String(bruto ?? '').replace(/\D/g, '');
  if (/^55[1-9][0-9]9[0-9]{8}$/.test(limpo)) return `${limpo.slice(0, 4)}${limpo.slice(5)}`;
  return limpo;
}

export function criarCampanhasESegurancaDoBanco({ tabelas, participacoes, responder, deposito }) {
  const configs = new Map();
  const ignorados = [];
  const pastas = [];
  const arquivosMidia = [];
  const destinatariosCamp = [];
  const entregasCamp = [];
  const alertasAdmin = [];

  function garantirEstadoFila(workspaceId) {
    let estado = tabelas.proactive_queue_state.find((s) => s.workspace_id === workspaceId);
    if (!estado) {
      estado = {
        workspace_id: workspaceId,
        status: 'idle',
        pause_reason: null,
        mode: 'auto_rotate',
        fixed_instance_id: null,
        message_template: '',
        next_send_at: null,
        updated_at: null,
      };
      tabelas.proactive_queue_state.push(estado);
    }
    return estado;
  }

  function semeadoInicial() {
    configs.clear();
    ignorados.length = 0;
    pastas.length = 0;
    arquivosMidia.length = 0;
    destinatariosCamp.length = 0;
    entregasCamp.length = 0;
    alertasAdmin.length = 0;

    // Reseta campanhas & fila para os valores iniciais de dados.mjs
    tabelas.proactive_queue_state = [
      {
        workspace_id: WORKSPACE_LOJA,
        status: 'running',
        pause_reason: null,
        mode: 'auto_rotate',
        fixed_instance_id: null,
        message_template: 'Olá {{primeiro_nome}}!',
        next_send_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    tabelas.proactive_queue_items = [
      {
        id: 'q1000000-0000-4000-8000-000000000001',
        workspace_id: WORKSPACE_LOJA,
        instance_id: null,
        recipient_name: 'Carlos',
        recipient_phone: '5585999000001',
        rendered_body: 'Olá Carlos!',
        status: 'pending',
        suppression_reason: null,
        error_detail: null,
        sent_at: null,
        created_at: new Date().toISOString(),
      },
      {
        id: 'q1000000-0000-4000-8000-000000000002',
        workspace_id: WORKSPACE_LOJA,
        instance_id: null,
        recipient_name: 'Paula',
        recipient_phone: '5585999000002',
        rendered_body: 'Olá Paula!',
        status: 'pending',
        suppression_reason: null,
        error_detail: null,
        sent_at: null,
        created_at: new Date().toISOString(),
      },
      {
        id: 'q1000000-0000-4000-8000-000000000003',
        workspace_id: WORKSPACE_LOJA,
        instance_id: null,
        recipient_name: 'Marcos',
        recipient_phone: '5585999000003',
        rendered_body: 'Olá Marcos!',
        status: 'sending',
        suppression_reason: null,
        error_detail: null,
        sent_at: null,
        created_at: new Date().toISOString(),
      },
    ];
    tabelas.campaigns = [
      { workspace_id: WORKSPACE_LOJA, id: 'k1000000-0000-4000-8000-000000000001', name: 'Promoção Loja', status: 'running', distribution: 'fixed', instance_ids: [], blocks: [], cadence: {}, pause_reason: null, pause_detail: null, scheduled_for: null, confirmed_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { workspace_id: WORKSPACE_LOJA, id: 'k1000000-0000-4000-8000-000000000002', name: 'Rascunho Loja', status: 'draft', distribution: 'fixed', instance_ids: [], blocks: [], cadence: {}, pause_reason: null, pause_detail: null, scheduled_for: null, confirmed_at: null, started_at: null, finished_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ];
  }

  semeadoInicial();

  function cfgDoWorkspace(workspaceId) {
    if (!configs.has(workspaceId)) configs.set(workspaceId, { ...PADROES_SEGURANCA });
    return configs.get(workspaceId);
  }

  function motivoSupressao(workspaceId, telefoneBruto) {
    const d = normalizarTelefone(telefoneBruto);
    if (!d) return 'invalid_phone';
    const core = miolo(d);
    if (ignorados.some((i) => i.workspace_id === workspaceId && i.phone_core === core)) return 'ignored';
    const ct = tabelas.contacts.find((c) => c.workspace_id === workspaceId && !c.erased_at && c.phone_e164 && miolo(c.phone_e164) === core);
    if (ct?.opted_out) return 'opted_out';
    if (ct?.is_blocked || ct?.ai_ignored) return 'blocked';
    const proprio = tabelas.instances.some(
      (i) => i.workspace_id === workspaceId && i.status !== 'revoked' && i.connected_phone && miolo(i.connected_phone) === core,
    );
    if (proprio) return 'own_chip';
    return null;
  }

  function listarIgnorados(workspaceId) {
    return {
      manual: ignorados
        .filter((i) => i.workspace_id === workspaceId)
        .map(({ id, name, phone_digits, note, created_at }) => ({ id, name, phone_digits, note, created_at })),
      contacts: tabelas.contacts
        .filter((c) => c.workspace_id === workspaceId && !c.erased_at && (c.ai_ignored || c.is_blocked))
        .map((c) => ({
          contact_id: c.id,
          display_name: c.display_name || '',
          phone_e164: c.phone_e164 || null,
          ai_ignored: Boolean(c.ai_ignored),
          is_blocked: Boolean(c.is_blocked),
        })),
    };
  }

  function lerFila(workspaceId) {
    const state = garantirEstadoFila(workspaceId);
    const cfg = cfgDoWorkspace(workspaceId);
    const items = tabelas.proactive_queue_items.filter((i) => i.workspace_id === workspaceId);
    const chips = tabelas.instances.filter(
      (i) => i.workspace_id === workspaceId && i.status !== 'revoked' && ['campaigns', 'both'].includes(i.purpose),
    );
    const counts = { pending: 0, sending: 0, awaiting_human_confirmation: 0, sent: 0, failed: 0, suppressed: 0 };
    const daily_sent_by_chip = {};
    for (const it of items) {
      if (it.status in counts) counts[it.status] += 1;
      if (it.status === 'sent' && it.instance_id) {
        daily_sent_by_chip[it.instance_id] = (daily_sent_by_chip[it.instance_id] ?? 0) + 1;
      }
    }
    return {
      state: { ...state },
      counts,
      items: [...items].reverse().slice(0, 100),
      daily_sent_by_chip,
      daily_limit: cfg.daily_proactive_limit,
      chips: chips.map((c) => ({
        id: c.id,
        display_name: c.display_name,
        engine: c.engine,
        status: c.status,
        purpose: c.purpose,
        connected_phone: c.connected_phone,
      })),
    };
  }

  function statsCampanha(campId) {
    const recs = destinatariosCamp.filter((r) => r.campaign_id === campId);
    const dels = entregasCamp.filter((d) => d.campaign_id === campId);
    return {
      total: recs.length,
      eligible: recs.filter((r) => r.send_allowed).length,
      queued: recs.filter((r) => ['pending', 'queued', 'sending'].includes(r.status)).length,
      sent: recs.filter((r) => ['sent', 'delivered', 'read', 'replied'].includes(r.status)).length,
      delivered: recs.filter((r) => Boolean(r.delivered_at)).length,
      read: recs.filter((r) => Boolean(r.read_at)).length,
      replied: recs.filter((r) => Boolean(r.replied_at)).length,
      failed: recs.filter((r) => r.status === 'failed').length,
      suppressed: recs.filter((r) => r.status === 'suppressed').length,
      uncertain: dels.filter((d) => d.status === 'awaiting_human_confirmation').length,
      cancelled: recs.filter((r) => r.status === 'cancelled').length,
    };
  }

  function detalheCampanha(workspaceId, campId) {
    const camp = tabelas.campaigns.find((c) => c.workspace_id === workspaceId && c.id === campId);
    if (!camp) return null;
    const recs = destinatariosCamp
      .filter((r) => r.campaign_id === campId)
      .map((r) => {
        const chip = tabelas.instances.find((i) => i.id === r.instance_id);
        return { ...r, instance_name: chip?.display_name ?? null };
      });
    const attention = entregasCamp.filter(
      (d) => d.campaign_id === campId && ['awaiting_human_confirmation', 'failed', 'sending'].includes(d.status),
    );
    return {
      campaign: { ...camp },
      stats: statsCampanha(campId),
      recipients: recs,
      attention_deliveries: attention,
    };
  }

  function acoes(res, usuario, nome, corpo) {
    const erro = (status, code, message) => responder(res, status, { code, details: null, hint: null, message });
    const workspaceId = corpo.p_workspace_id;
    const membro = participacoes.find((p) => p.user_id === usuario.id && p.workspace_id === workspaceId && p.status === 'active');
    if (!membro) return erro(403, '42501', 'Workspace membership required');
    const ehDono = membro.role === 'owner';

    if (nome === 'read_my_security_settings') {
      return responder(res, 200, { ...cfgDoWorkspace(workspaceId), can_edit: ehDono, updated_at: new Date().toISOString() });
    }
    if (nome === 'save_my_security_settings') {
      if (!ehDono) return erro(403, '42501', 'Workspace owner required');
      const entrada = corpo.p_settings ?? {};
      if (entrada.admin_alert_enabled && !String(entrada.admin_alert_whatsapp ?? '').trim()) {
        return erro(400, 'P0001', 'admin_alert_whatsapp_required');
      }
      const atual = cfgDoWorkspace(workspaceId);
      Object.assign(atual, entrada);
      return responder(res, 200, { ...atual, can_edit: true, updated_at: new Date().toISOString() });
    }

    if (nome === 'list_my_ignored_numbers') {
      return responder(res, 200, listarIgnorados(workspaceId));
    }
    if (nome === 'add_my_ignored_number') {
      const tel = normalizarTelefone(corpo.p_phone);
      if (!tel) return erro(400, '22023', 'Invalid phone number');
      const core = miolo(tel);
      const existente = ignorados.find((i) => i.workspace_id === workspaceId && i.phone_core === core);
      if (existente) {
        existente.name = String(corpo.p_name ?? '').trim() || existente.name;
        existente.note = String(corpo.p_note ?? '').trim();
      } else {
        ignorados.unshift({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          name: String(corpo.p_name ?? '').trim() || `+${tel}`,
          phone_digits: tel,
          phone_core: core,
          note: String(corpo.p_note ?? '').trim(),
          created_at: new Date().toISOString(),
        });
      }
      for (const it of tabelas.proactive_queue_items) {
        if (it.workspace_id === workspaceId && it.status === 'pending' && miolo(it.recipient_phone) === core) {
          it.status = 'suppressed';
          it.suppression_reason = 'ignored';
        }
      }
      return responder(res, 200, listarIgnorados(workspaceId));
    }
    if (nome === 'remove_my_ignored_number') {
      if (corpo.p_id) {
        const idx = ignorados.findIndex((i) => i.workspace_id === workspaceId && i.id === corpo.p_id);
        if (idx >= 0) ignorados.splice(idx, 1);
      }
      if (corpo.p_contact_id) {
        const ct = tabelas.contacts.find((c) => c.workspace_id === workspaceId && c.id === corpo.p_contact_id);
        if (ct) ct.ai_ignored = false;
      }
      return responder(res, 200, listarIgnorados(workspaceId));
    }

    if (nome === 'read_my_proactive_queue') {
      return responder(res, 200, lerFila(workspaceId));
    }
    if (nome === 'start_my_proactive_queue') {
      if (tabelas.proactive_queue_items.some((i) => i.workspace_id === workspaceId && i.status === 'awaiting_human_confirmation')) {
        return erro(400, 'P0001', 'uncertain_send_pending');
      }
      const mode = corpo.p_mode === 'single' ? 'single' : 'auto_rotate';
      const chips = tabelas.instances.filter(
        (i) => i.workspace_id === workspaceId && i.status === 'connected' && ['campaigns', 'both'].includes(i.purpose),
      );
      if (mode === 'single' && !chips.some((c) => c.id === corpo.p_instance_id)) {
        return erro(400, 'P0001', 'chip_not_connected');
      }
      if (mode === 'auto_rotate' && chips.length === 0) {
        return erro(400, 'P0001', 'chip_not_connected');
      }
      const recs = Array.isArray(corpo.p_recipients) ? corpo.p_recipients : [];
      const tpl = String(corpo.p_message_template ?? '').trim();
      let eligible = 0;
      let suppressed = 0;
      const vistos = new Set();
      for (const r of recs) {
        const tel = normalizarTelefone(r.phone);
        if (!tel) {
          suppressed += 1;
          continue;
        }
        const core = miolo(tel);
        if (vistos.has(core)) continue;
        vistos.add(core);
        const sup = motivoSupressao(workspaceId, tel);
        const rName = String(r.name ?? '').trim();
        const primeiro = rName.split(/\s+/)[0] || 'olá';
        const body = tpl
          .replace(/\{\{\s*nome\s*\}\}/gi, rName || 'olá')
          .replace(/\{\{\s*primeiro_nome\s*\}\}/gi, primeiro)
          .replace(/\{\{\s*telefone\s*\}\}/gi, tel);
        tabelas.proactive_queue_items.push({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          instance_id: mode === 'single' ? corpo.p_instance_id : null,
          recipient_name: rName,
          recipient_phone: tel,
          rendered_body: body,
          status: sup ? 'suppressed' : 'pending',
          suppression_reason: sup,
          error_detail: null,
          sent_at: null,
          created_at: new Date().toISOString(),
        });
        if (sup) suppressed += 1;
        else eligible += 1;
      }
      const st = garantirEstadoFila(workspaceId);
      st.mode = mode;
      st.fixed_instance_id = mode === 'single' ? corpo.p_instance_id : null;
      st.message_template = tpl;
      st.status = eligible > 0 ? 'running' : 'completed';
      st.pause_reason = null;
      st.updated_at = new Date().toISOString();
      return responder(res, 200, { eligible, suppressed, state: st });
    }
    if (nome === 'pause_my_proactive_queue') {
      const st = garantirEstadoFila(workspaceId);
      st.status = 'paused';
      st.pause_reason = 'manual';
      st.updated_at = new Date().toISOString();
      return responder(res, 200, lerFila(workspaceId));
    }
    if (nome === 'resume_my_proactive_queue') {
      if (tabelas.proactive_queue_items.some((i) => i.workspace_id === workspaceId && i.status === 'awaiting_human_confirmation')) {
        return erro(400, 'P0001', 'uncertain_send_pending');
      }
      const st = garantirEstadoFila(workspaceId);
      st.status = 'running';
      st.pause_reason = null;
      st.updated_at = new Date().toISOString();
      return responder(res, 200, lerFila(workspaceId));
    }
    if (nome === 'clear_my_proactive_queue') {
      tabelas.proactive_queue_items = tabelas.proactive_queue_items.filter(
        (i) => i.workspace_id !== workspaceId || ['sent', 'awaiting_human_confirmation'].includes(i.status),
      );
      const st = garantirEstadoFila(workspaceId);
      st.status = 'idle';
      st.pause_reason = null;
      return responder(res, 200, lerFila(workspaceId));
    }
    if (nome === 'resolve_my_proactive_uncertain') {
      const it = tabelas.proactive_queue_items.find(
        (i) => i.workspace_id === workspaceId && i.id === corpo.p_item_id && i.status === 'awaiting_human_confirmation',
      );
      if (!it) return erro(404, 'P0002', 'Uncertain item not found');
      it.status = corpo.p_confirmed_sent ? 'sent' : 'failed';
      it.sent_at = corpo.p_confirmed_sent ? new Date().toISOString() : null;
      it.error_detail = corpo.p_confirmed_sent ? null : 'Confirmado manualmente que não saiu';
      const st = garantirEstadoFila(workspaceId);
      if (st.pause_reason === 'uncertain_send') st.pause_reason = 'manual';
      return responder(res, 200, lerFila(workspaceId));
    }

    if (nome === 'list_my_campaign_media') {
      return responder(res, 200, {
        folders: pastas.filter((p) => p.workspace_id === workspaceId),
        files: arquivosMidia.filter((a) => a.workspace_id === workspaceId),
      });
    }
    if (nome === 'create_my_campaign_media_folder') {
      const nova = {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        name: String(corpo.p_name ?? '').trim(),
        kind: corpo.p_kind === 'audio' ? 'audio' : 'image',
        created_at: new Date().toISOString(),
      };
      pastas.unshift(nova);
      return responder(res, 200, nova);
    }
    if (nome === 'register_my_campaign_media_file') {
      const folder = pastas.find((p) => p.workspace_id === workspaceId && p.id === corpo.p_folder_id);
      if (!folder) return erro(404, 'P0002', 'Folder not found');
      const novo = {
        id: corpo.p_file_id || crypto.randomUUID(),
        workspace_id: workspaceId,
        folder_id: folder.id,
        kind: folder.kind,
        object_key: corpo.p_object_key,
        file_name: corpo.p_file_name,
        content_type: corpo.p_content_type,
        byte_size: Number(corpo.p_byte_size ?? 0),
        created_at: new Date().toISOString(),
      };
      arquivosMidia.push(novo);
      return responder(res, 200, novo);
    }
    if (nome === 'delete_my_campaign_media_file') {
      const idx = arquivosMidia.findIndex((a) => a.workspace_id === workspaceId && a.id === corpo.p_file_id);
      if (idx < 0) return erro(404, 'P0002', 'Media file not found');
      const [rem] = arquivosMidia.splice(idx, 1);
      deposito.delete(rem.object_key);
      return responder(res, 200, { object_key: rem.object_key });
    }
    if (nome === 'delete_my_campaign_media_folder') {
      const idx = pastas.findIndex((p) => p.workspace_id === workspaceId && p.id === corpo.p_folder_id);
      if (idx < 0) return erro(404, 'P0002', 'Folder not found');
      pastas.splice(idx, 1);
      const keys = [];
      for (let i = arquivosMidia.length - 1; i >= 0; i -= 1) {
        if (arquivosMidia[i].folder_id === corpo.p_folder_id) {
          keys.push(arquivosMidia[i].object_key);
          deposito.delete(arquivosMidia[i].object_key);
          arquivosMidia.splice(i, 1);
        }
      }
      return responder(res, 200, { object_keys: keys });
    }

    if (nome === 'list_my_campaigns') {
      const lista = tabelas.campaigns
        .filter((c) => c.workspace_id === workspaceId)
        .map((c) => ({ ...c, stats: statsCampanha(c.id) }));
      return responder(res, 200, lista);
    }
    if (nome === 'read_my_campaign') {
      const det = detalheCampanha(workspaceId, corpo.p_campaign_id);
      if (!det) return erro(404, 'P0002', 'Campaign not found');
      return responder(res, 200, det);
    }
    if (nome === 'save_my_campaign_draft') {
      const ids = Array.isArray(corpo.p_instance_ids) ? corpo.p_instance_ids : [];
      const chipsValidos = ids.filter((id) =>
        tabelas.instances.some((i) => i.workspace_id === workspaceId && i.id === id && i.status !== 'revoked' && ['campaigns', 'both'].includes(i.purpose)),
      );
      if (chipsValidos.length === 0) return erro(400, 'P0001', 'campaign_chip_required');

      let camp = corpo.p_campaign_id
        ? tabelas.campaigns.find((c) => c.workspace_id === workspaceId && c.id === corpo.p_campaign_id)
        : null;
      if (camp && !['draft', 'awaiting_confirmation'].includes(camp.status)) {
        return erro(400, 'P0001', 'campaign_locked');
      }
      const agora = new Date().toISOString();
      if (!camp) {
        camp = {
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          name: corpo.p_name,
          status: 'draft',
          distribution: corpo.p_distribution === 'round_robin' ? 'round_robin' : 'fixed',
          instance_ids: chipsValidos,
          blocks: corpo.p_blocks ?? [],
          cadence: corpo.p_cadence ?? {},
          pause_reason: null,
          pause_detail: null,
          scheduled_for: corpo.p_scheduled_for || null,
          confirmed_at: null,
          started_at: null,
          finished_at: null,
          created_at: agora,
          updated_at: agora,
        };
        tabelas.campaigns.unshift(camp);
      } else {
        Object.assign(camp, {
          name: corpo.p_name,
          status: 'draft',
          distribution: corpo.p_distribution === 'round_robin' ? 'round_robin' : 'fixed',
          instance_ids: chipsValidos,
          blocks: corpo.p_blocks ?? [],
          cadence: corpo.p_cadence ?? {},
          scheduled_for: corpo.p_scheduled_for || null,
          updated_at: agora,
        });
        for (let i = destinatariosCamp.length - 1; i >= 0; i -= 1) {
          if (destinatariosCamp[i].campaign_id === camp.id) destinatariosCamp.splice(i, 1);
        }
      }

      const vistos = new Set();
      let idx = 0;
      for (const r of corpo.p_recipients ?? []) {
        const tel = normalizarTelefone(r.phone);
        if (!tel) continue;
        const core = miolo(tel);
        if (vistos.has(core)) continue;
        vistos.add(core);
        const instId = chipsValidos[idx % chipsValidos.length];
        idx += 1;
        const sup = motivoSupressao(workspaceId, tel);
        destinatariosCamp.push({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          campaign_id: camp.id,
          contact_id: crypto.randomUUID(),
          instance_id: instId,
          display_name: String(r.name ?? '').trim(),
          phone_e164: `+${tel}`,
          custom_fields: r.fields ?? {},
          status: sup ? 'suppressed' : 'pending',
          send_allowed: !sup,
          suppression_reason: sup,
          current_step: 0,
          last_error: null,
          sent_at: null,
          delivered_at: null,
          read_at: null,
          replied_at: null,
        });
      }
      return responder(res, 200, detalheCampanha(workspaceId, camp.id));
    }

    if (nome === 'prepare_my_campaign_preview') {
      const camp = tabelas.campaigns.find((c) => c.workspace_id === workspaceId && c.id === corpo.p_campaign_id);
      if (!camp) return erro(404, 'P0002', 'Campaign not found');
      if (!['draft', 'awaiting_confirmation'].includes(camp.status)) return erro(400, 'P0001', 'campaign_locked');

      for (const b of camp.blocks ?? []) {
        if (b.type === 'text' && (!Array.isArray(b.texts) || !b.texts.some((t) => String(t).trim()))) {
          return erro(400, 'P0001', 'empty_text_block');
        }
        if ((b.type === 'image' || b.type === 'audio') && !arquivosMidia.some((f) => f.workspace_id === workspaceId && f.folder_id === b.folder_id && f.kind === b.type)) {
          return erro(400, 'P0001', 'media_folder_empty');
        }
      }

      const recs = destinatariosCamp.filter((r) => r.campaign_id === camp.id);
      let eligible = 0;
      let suppressed = 0;
      const samples = [];
      for (const r of recs) {
        const sup = motivoSupressao(workspaceId, r.phone_e164);
        r.send_allowed = !sup;
        r.suppression_reason = sup;
        r.status = sup ? 'suppressed' : 'pending';
        if (sup) suppressed += 1;
        else {
          eligible += 1;
          if (samples.length < 5) {
            samples.push({
              recipient_id: r.id,
              name: r.display_name,
              phone: r.phone_e164,
              custom_fields: r.custom_fields,
            });
          }
        }
      }
      if (eligible === 0) return erro(400, 'P0001', 'no_eligible_recipients');
      camp.status = 'awaiting_confirmation';
      camp.updated_at = new Date().toISOString();
      return responder(res, 200, {
        eligible,
        suppressed,
        samples,
        detail: detalheCampanha(workspaceId, camp.id),
      });
    }

    if (nome === 'confirm_my_campaign') {
      const camp = tabelas.campaigns.find((c) => c.workspace_id === workspaceId && c.id === corpo.p_campaign_id);
      if (!camp) return erro(404, 'P0002', 'Campaign not found');
      if (camp.status !== 'awaiting_confirmation') return erro(400, 'P0001', 'preview_required_before_confirm');
      const temConectado = (camp.instance_ids ?? []).some((id) =>
        tabelas.instances.some((i) => i.workspace_id === workspaceId && i.id === id && i.status === 'connected'),
      );
      if (!temConectado) return erro(400, 'P0001', 'chip_not_connected');

      const agora = new Date().toISOString();
      camp.scheduled_for = corpo.p_scheduled_for || camp.scheduled_for;
      camp.confirmed_at = agora;
      camp.status = camp.scheduled_for && camp.scheduled_for > agora ? 'scheduled' : 'running';
      camp.started_at = camp.status === 'running' ? agora : null;
      for (const r of destinatariosCamp) {
        if (r.campaign_id === camp.id && r.send_allowed && r.status === 'pending') r.status = 'queued';
      }
      return responder(res, 200, detalheCampanha(workspaceId, camp.id));
    }

    if (nome === 'pause_my_campaign') {
      const camp = tabelas.campaigns.find((c) => c.workspace_id === workspaceId && c.id === corpo.p_campaign_id);
      if (!camp) return erro(404, 'P0002', 'Campaign not found');
      camp.status = 'paused';
      camp.pause_reason = 'manual';
      camp.pause_detail = 'Pausada manualmente.';
      return responder(res, 200, detalheCampanha(workspaceId, camp.id));
    }

    if (nome === 'resume_my_campaign') {
      const camp = tabelas.campaigns.find((c) => c.workspace_id === workspaceId && c.id === corpo.p_campaign_id);
      if (!camp) return erro(404, 'P0002', 'Campaign not found');
      if (entregasCamp.some((d) => d.campaign_id === camp.id && d.status === 'awaiting_human_confirmation')) {
        return erro(400, 'P0001', 'uncertain_send_pending');
      }
      camp.status = 'running';
      camp.pause_reason = null;
      camp.pause_detail = null;
      return responder(res, 200, detalheCampanha(workspaceId, camp.id));
    }

    if (nome === 'cancel_my_campaign') {
      const camp = tabelas.campaigns.find((c) => c.workspace_id === workspaceId && c.id === corpo.p_campaign_id);
      if (!camp) return erro(404, 'P0002', 'Campaign not found');
      camp.status = 'cancelled';
      for (const r of destinatariosCamp) {
        if (r.campaign_id === camp.id && ['pending', 'queued'].includes(r.status)) r.status = 'cancelled';
      }
      return responder(res, 200, detalheCampanha(workspaceId, camp.id));
    }

    if (nome === 'delete_my_campaign_draft') {
      const idx = tabelas.campaigns.findIndex((c) => c.workspace_id === workspaceId && c.id === corpo.p_campaign_id);
      if (idx >= 0) tabelas.campaigns.splice(idx, 1);
      return responder(res, 200, { ok: true });
    }

    if (nome === 'resolve_my_campaign_uncertain') {
      const del = entregasCamp.find(
        (d) => d.workspace_id === workspaceId && d.campaign_id === corpo.p_campaign_id && d.id === corpo.p_delivery_id && d.status === 'awaiting_human_confirmation',
      );
      if (!del) return erro(404, 'P0002', 'Uncertain delivery not found');
      del.status = corpo.p_confirmed_sent ? 'sent' : 'failed';
      del.error_detail = corpo.p_confirmed_sent ? null : 'Confirmado manualmente que não saiu';
      const rec = destinatariosCamp.find((r) => r.id === del.recipient_id);
      if (rec) rec.status = corpo.p_confirmed_sent ? 'sent' : 'failed';
      const camp = tabelas.campaigns.find((c) => c.id === corpo.p_campaign_id);
      if (camp && camp.pause_reason === 'uncertain_send') {
        camp.pause_reason = 'manual';
        camp.pause_detail = 'Envio conferido; clique em Retomar se quiser continuar.';
      }
      return responder(res, 200, detalheCampanha(workspaceId, corpo.p_campaign_id));
    }

    return erro(404, 'PGRST202', `Função não imitada: ${nome}`);
  }

  function simularEnvioIncerto(workspaceId, alvo = 'fila') {
    if (alvo === 'campanha') {
      const camp = tabelas.campaigns.find((c) => c.workspace_id === workspaceId && ['running', 'paused', 'scheduled'].includes(c.status));
      if (!camp) return false;
      const rec = destinatariosCamp.find((r) => r.campaign_id === camp.id) ?? null;
      camp.status = 'paused';
      camp.pause_reason = 'uncertain_send';
      camp.pause_detail = 'Um envio ficou sem confirmação do WhatsApp.';
      entregasCamp.push({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        campaign_id: camp.id,
        recipient_id: rec?.id ?? crypto.randomUUID(),
        instance_id: camp.instance_ids[0] ?? crypto.randomUUID(),
        step_index: 0,
        block_type: 'text',
        status: 'awaiting_human_confirmation',
        rendered_body: 'Mensagem de campanha sem confirmação de rede',
        media_file_id: null,
        error_detail: 'timeout_evolution',
        created_at: new Date().toISOString(),
      });
      return true;
    }

    const st = garantirEstadoFila(workspaceId);
    st.status = 'paused';
    st.pause_reason = 'uncertain_send';
    tabelas.proactive_queue_items.push({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      instance_id: null,
      recipient_name: 'Cliente Incerto',
      recipient_phone: '5585999776655',
      rendered_body: 'Olá Cliente, tudo bem?',
      status: 'awaiting_human_confirmation',
      suppression_reason: null,
      error_detail: 'timeout_evolution',
      sent_at: null,
      created_at: new Date().toISOString(),
    });
    return true;
  }

  return {
    acoes,
    reiniciarFase5: semeadoInicial,
    simularEnvioIncerto,
    registrarAlerta(payload) {
      alertasAdmin.push(payload);
    },
    listarAlertas() {
      return [...alertasAdmin];
    },
  };
}
