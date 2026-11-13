import crypto from 'node:crypto';

export const FUNCOES_DO_CRM = [
  'read_my_crm_catalogs',
  'read_my_crm_inbox',
  'read_my_contacts_directory',
  'read_my_kanban',
  'global_search_my_workspace',
  'save_my_contact',
  'start_or_open_my_conversation',
  'update_my_contact_flags',
  'update_my_conversation_crm',
  'bulk_update_my_conversations',
  'add_my_conversation_note',
  'save_my_crm_tag',
  'delete_my_crm_tag',
  'toggle_my_contact_tag',
  'save_my_quick_reply',
  'delete_my_quick_reply',
  'schedule_my_message',
  'cancel_my_scheduled_message',
  'delete_my_contact_and_conversation',
];

const ETAPAS_ABERTAS = ['new', 'ai', 'waiting_human', 'human', 'waiting_customer'];
const ETAPAS_QUE_ESPERAM = ['new', 'waiting_human', 'human'];
const ETAPAS_KANBAN = new Set(['novo', 'qualificando', 'em_atendimento', 'proposta', 'concluido']);

function normalizarTelefone(cru) {
  let d = String(cru ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return null;
  if (d.length >= 10 && d.length <= 11) d = `55${d}`;
  if (d.length < 8 || d.length > 15) return null;
  return { e164: `+${d}`, digitos: d, jid: `${d}@s.whatsapp.net` };
}

function nucleoTelefone(tel) {
  const d = String(tel ?? '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') return d.slice(0, 4) + d.slice(5);
  return d;
}

export function criarCrmDoBanco({ tabelas, participacoes, responder, anotarMudanca, deposito }) {
  for (const nome of ['crm_tags', 'contact_tags', 'conversation_notes', 'quick_replies', 'scheduled_messages']) {
    tabelas[nome] ??= [];
  }

  function tagsDoContato(workspaceId, contactId) {
    const ids = new Set(
      tabelas.contact_tags
        .filter((ct) => ct.workspace_id === workspaceId && ct.contact_id === contactId)
        .map((ct) => ct.tag_id),
    );
    return tabelas.crm_tags
      .filter((t) => t.workspace_id === workspaceId && ids.has(t.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ id: t.id, name: t.name, color: t.color }));
  }

  function enriquecerConversaParaLista(conversa, contato, chip) {
    const agPendentes = tabelas.scheduled_messages.filter(
      (s) => s.workspace_id === conversa.workspace_id && s.conversation_id === conversa.id && s.status === 'pending',
    ).length;
    return {
      id: conversa.id,
      contact_id: conversa.contact_id,
      stage: conversa.stage,
      crm_stage: conversa.crm_stage ?? 'novo',
      deal_value: Number(conversa.deal_value ?? 0),
      deal_status: conversa.deal_status ?? 'open',
      deal_lost_reason: conversa.deal_lost_reason ?? null,
      is_pinned: Boolean(conversa.is_pinned),
      follow_up_at: conversa.follow_up_at ?? null,
      unread_count: conversa.unread_count ?? 0,
      last_message_at: conversa.last_message_at ?? null,
      last_message_preview: conversa.last_message_preview ?? null,
      activity_at: conversa.activity_at ?? conversa.created_at ?? null,
      automation_paused: conversa.automation_paused ?? false,
      instance_id: conversa.instance_id,
      instance_name: chip?.display_name ?? null,
      contact_name: contato?.display_name ?? '',
      contact_phone: contato?.phone_e164 ?? null,
      ai_ignored: Boolean(contato?.ai_ignored),
      is_blocked: Boolean(contato?.is_blocked),
      scheduled_count: agPendentes,
      tags: contato?.id ? tagsDoContato(conversa.workspace_id, contato.id) : [],
    };
  }

  function enriquecerContatoNaConversa(conversa, contato) {
    return {
      id: contato.id,
      display_name: contato.display_name ?? '',
      phone_e164: contato.phone_e164 ?? null,
      email: contato.email ?? null,
      company: contato.company ?? null,
      document_id: contato.document_id ?? null,
      city: contato.city ?? null,
      lead_source: contato.lead_source ?? null,
      notes: contato.notes ?? null,
      ai_ignored: Boolean(contato.ai_ignored),
      is_blocked: Boolean(contato.is_blocked),
      channel: contato.channel ?? 'whatsapp',
      erased: Boolean(contato.erased_at),
      created_at: contato.created_at,
      tags: tagsDoContato(conversa.workspace_id, contato.id),
    };
  }

  function extrasDaConversa(conversa, usuario) {
    const notes = tabelas.conversation_notes
      .filter((n) => n.workspace_id === conversa.workspace_id && n.conversation_id === conversa.id)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 50)
      .map((n) => ({
        id: n.id,
        body_text: n.body_text,
        created_at: n.created_at,
        author_name: n.author_name ?? 'Equipe',
        mine: n.author_user_id === usuario.id,
      }));
    const scheduled = tabelas.scheduled_messages
      .filter((s) => s.workspace_id === conversa.workspace_id && s.conversation_id === conversa.id)
      .sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))
      .slice(0, 20)
      .map((s) => ({
        id: s.id,
        body_text: s.body_text,
        scheduled_for: s.scheduled_for,
        status: s.status,
        error_detail: s.error_detail ?? null,
      }));
    return { notes, scheduled };
  }

  function limparWorkspace(workspaceId) {
    for (const nome of ['crm_tags', 'contact_tags', 'conversation_notes', 'quick_replies', 'scheduled_messages']) {
      tabelas[nome] = tabelas[nome].filter((l) => l.workspace_id !== workspaceId);
    }
  }

  function acoesDoCrm(res, usuario, nome, corpo) {
    const erro = (status, code, message) => responder(res, status, { code, details: null, hint: null, message });
    const workspaceId = corpo.p_workspace_id;
    const participa = participacoes.some((p) => p.user_id === usuario.id && p.workspace_id === workspaceId && p.status === 'active');
    if (!participa) return erro(403, '42501', 'Workspace membership required');

    const daEmpresa = (tabela) => tabelas[tabela].filter((l) => l.workspace_id === workspaceId);
    const contatoDe = (c) => daEmpresa('contacts').find((ct) => ct.id === c.contact_id) ?? {};
    const chipDe = (c) => daEmpresa('instances').find((i) => i.id === c.instance_id) ?? {};

    if (nome === 'read_my_crm_catalogs') {
      const tags = daEmpresa('crm_tags')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ id: t.id, name: t.name, color: t.color, created_at: t.created_at }));
      const quick_replies = daEmpresa('quick_replies')
        .sort((a, b) => a.shortcut.localeCompare(b.shortcut))
        .map((q) => ({ id: q.id, shortcut: q.shortcut, title: q.title, body_text: q.body_text }));
      return responder(res, 200, { tags, quick_replies });
    }

    if (nome === 'read_my_crm_inbox') {
      let conversas = daEmpresa('conversations');
      if (corpo.p_instance_id) conversas = conversas.filter((c) => c.instance_id === corpo.p_instance_id);
      const doChip = conversas;

      if (corpo.p_tag_id) {
        const marcados = new Set(
          daEmpresa('contact_tags').filter((ct) => ct.tag_id === corpo.p_tag_id).map((ct) => ct.contact_id),
        );
        conversas = conversas.filter((c) => marcados.has(c.contact_id));
      }
      if (corpo.p_crm_stage) {
        conversas = conversas.filter((c) => (c.crm_stage ?? 'novo') === corpo.p_crm_stage);
      }
      if (corpo.p_deal_status === 'with_value') {
        conversas = conversas.filter((c) => Number(c.deal_value ?? 0) > 0);
      } else if (corpo.p_deal_status) {
        conversas = conversas.filter((c) => (c.deal_status ?? 'open') === corpo.p_deal_status);
      }

      const busca = String(corpo.p_search ?? '').trim();
      if (busca) {
        if (busca.length > 80) return erro(400, '22023', 'Search text too long');
        const proc = busca.toLowerCase();
        const telefones = (corpo.p_phones ?? []).filter((t) => /^[0-9]{4,20}$/.test(t));
        conversas = conversas.filter((c) => {
          if (c.stage === 'archived') return false;
          const ct = contatoDe(c);
          return (
            String(ct.display_name ?? '').toLowerCase().includes(proc) ||
            String(ct.company ?? '').toLowerCase().includes(proc) ||
            String(c.last_message_preview ?? '').toLowerCase().includes(proc) ||
            telefones.some((t) => String(ct.phone_e164 ?? '').includes(t))
          );
        });
      } else {
        const filtros = {
          open: (c) => ETAPAS_ABERTAS.includes(c.stage),
          unread: (c) => (c.unread_count ?? 0) > 0 && ETAPAS_ABERTAS.includes(c.stage),
          waiting: (c) => ETAPAS_QUE_ESPERAM.includes(c.stage),
          resolved: (c) => c.stage === 'resolved',
          archived: (c) => c.stage === 'archived',
        };
        const fn = filtros[corpo.p_view ?? 'open'];
        if (!fn) return erro(400, '22023', 'Unsupported inbox view');
        conversas = conversas.filter(fn);
      }

      conversas = [...conversas].sort(
        (a, b) =>
          Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) ||
          String(b.activity_at).localeCompare(String(a.activity_at)) ||
          String(b.id).localeCompare(String(a.id)),
      );
      const limite = Math.min(Math.max(Number.isInteger(corpo.p_limit) ? corpo.p_limit : 50, 1), 200);
      return responder(res, 200, {
        conversations: conversas.slice(0, limite).map((c) => enriquecerConversaParaLista(c, contatoDe(c), chipDe(c))),
        has_more: conversas.length > limite,
        counts: {
          unread: doChip.filter((c) => (c.unread_count ?? 0) > 0 && ETAPAS_ABERTAS.includes(c.stage)).length,
          waiting: doChip.filter((c) => ETAPAS_QUE_ESPERAM.includes(c.stage)).length,
        },
        archived_count: doChip.filter((c) => c.stage === 'archived').length,
      });
    }

    if (nome === 'read_my_contacts_directory') {
      let lista = daEmpresa('contacts').filter((c) => !c.erased_at);
      const estado = corpo.p_status ?? 'all';
      if (estado === 'ignored') lista = lista.filter((c) => Boolean(c.ai_ignored));
      if (estado === 'blocked') lista = lista.filter((c) => Boolean(c.is_blocked));
      if (estado === 'manual') lista = lista.filter((c) => c.channel === 'manual');
      if (corpo.p_tag_id) {
        const ids = new Set(daEmpresa('contact_tags').filter((ct) => ct.tag_id === corpo.p_tag_id).map((ct) => ct.contact_id));
        lista = lista.filter((c) => ids.has(c.id));
      }
      const busca = String(corpo.p_search ?? '').trim().toLowerCase();
      const fones = (corpo.p_phones ?? []).filter((t) => /^[0-9]{4,20}$/.test(t));
      if (busca) {
        lista = lista.filter(
          (c) =>
            String(c.display_name ?? '').toLowerCase().includes(busca) ||
            String(c.company ?? '').toLowerCase().includes(busca) ||
            String(c.city ?? '').toLowerCase().includes(busca) ||
            String(c.email ?? '').toLowerCase().includes(busca) ||
            fones.some((t) => String(c.phone_e164 ?? '').includes(t)),
        );
      }
      const total = lista.length;
      const ord = [...lista].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const off = Math.max(Number(corpo.p_offset ?? 0), 0);
      const lim = Math.min(Math.max(Number(corpo.p_limit ?? 60), 1), 200);
      const contacts = ord.slice(off, off + lim).map((c) => {
        const conv = daEmpresa('conversations')
          .filter((cv) => cv.contact_id === c.id)
          .sort((a, b) => String(b.activity_at).localeCompare(String(a.activity_at)))[0];
        return {
          id: c.id,
          display_name: c.display_name ?? '',
          phone_e164: c.phone_e164 ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          document_id: c.document_id ?? null,
          city: c.city ?? null,
          lead_source: c.lead_source ?? null,
          notes: c.notes ?? null,
          ai_ignored: Boolean(c.ai_ignored),
          is_blocked: Boolean(c.is_blocked),
          erased_at: c.erased_at ?? null,
          channel: c.channel ?? 'whatsapp',
          created_at: c.created_at,
          tags: tagsDoContato(workspaceId, c.id),
          conversation_id: conv?.id ?? null,
          last_message_at: conv?.last_message_at ?? null,
          last_message_preview: conv?.last_message_preview ?? null,
          unread_count: conv?.unread_count ?? 0,
          crm_stage: conv?.crm_stage ?? null,
          deal_value: conv ? Number(conv.deal_value ?? 0) : 0,
          deal_status: conv?.deal_status ?? null,
          is_pinned: Boolean(conv?.is_pinned),
        };
      });
      return responder(res, 200, { contacts, total });
    }

    if (nome === 'read_my_kanban') {
      let lista = daEmpresa('conversations').filter((c) => c.stage !== 'archived');
      if (corpo.p_instance_id) lista = lista.filter((c) => c.instance_id === corpo.p_instance_id);
      if (corpo.p_tag_id) {
        const ids = new Set(daEmpresa('contact_tags').filter((ct) => ct.tag_id === corpo.p_tag_id).map((ct) => ct.contact_id));
        lista = lista.filter((c) => ids.has(c.contact_id));
      }
      const busca = String(corpo.p_search ?? '').trim().toLowerCase();
      if (busca) {
        lista = lista.filter((c) => {
          const ct = contatoDe(c);
          return (
            String(ct.display_name ?? '').toLowerCase().includes(busca) ||
            String(ct.company ?? '').toLowerCase().includes(busca) ||
            String(c.last_message_preview ?? '').toLowerCase().includes(busca)
          );
        });
      }
      const cards = lista
        .sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) || String(b.activity_at).localeCompare(String(a.activity_at)))
        .slice(0, 300)
        .map((c) => {
          const ct = contatoDe(c);
          return {
            id: c.id,
            contact_id: c.contact_id,
            instance_id: c.instance_id,
            instance_name: chipDe(c).display_name ?? null,
            stage: c.stage,
            crm_stage: c.crm_stage ?? 'novo',
            deal_value: Number(c.deal_value ?? 0),
            deal_status: c.deal_status ?? 'open',
            deal_lost_reason: c.deal_lost_reason ?? null,
            is_pinned: Boolean(c.is_pinned),
            follow_up_at: c.follow_up_at ?? null,
            unread_count: c.unread_count ?? 0,
            last_message_at: c.last_message_at ?? null,
            last_message_preview: c.last_message_preview ?? null,
            contact_name: ct.display_name ?? '',
            contact_phone: ct.phone_e164 ?? null,
            contact_company: ct.company ?? null,
            ai_ignored: Boolean(ct.ai_ignored),
            tags: tagsDoContato(workspaceId, ct.id),
          };
        });
      return responder(res, 200, { cards });
    }

    if (nome === 'global_search_my_workspace') {
      const proc = String(corpo.p_search ?? '').trim().toLowerCase();
      const fones = (corpo.p_phones ?? []).filter((t) => /^[0-9]{4,20}$/.test(t));
      if (!proc) return responder(res, 200, { conversations: [], contacts: [], notes: [] });
      const conversations = daEmpresa('conversations')
        .filter((c) => {
          const ct = contatoDe(c);
          return (
            String(ct.display_name ?? '').toLowerCase().includes(proc) ||
            String(ct.company ?? '').toLowerCase().includes(proc) ||
            String(c.last_message_preview ?? '').toLowerCase().includes(proc) ||
            fones.some((t) => String(ct.phone_e164 ?? '').includes(t))
          );
        })
        .slice(0, 8)
        .map((c) => {
          const ct = contatoDe(c);
          return {
            id: c.id,
            contact_name: ct.display_name ?? '',
            contact_phone: ct.phone_e164 ?? null,
            last_message_preview: c.last_message_preview ?? null,
            last_message_at: c.last_message_at ?? null,
            crm_stage: c.crm_stage ?? 'novo',
            deal_value: Number(c.deal_value ?? 0),
          };
        });
      const contacts = daEmpresa('contacts')
        .filter(
          (ct) =>
            !ct.erased_at &&
            (String(ct.display_name ?? '').toLowerCase().includes(proc) ||
              String(ct.company ?? '').toLowerCase().includes(proc) ||
              fones.some((t) => String(ct.phone_e164 ?? '').includes(t))),
        )
        .slice(0, 8)
        .map((ct) => ({
          id: ct.id,
          display_name: ct.display_name ?? '',
          phone_e164: ct.phone_e164 ?? null,
          company: ct.company ?? null,
          conversation_id: daEmpresa('conversations').find((c) => c.contact_id === ct.id)?.id ?? null,
        }));
      const notes = daEmpresa('conversation_notes')
        .filter((n) => String(n.body_text ?? '').toLowerCase().includes(proc))
        .slice(0, 6)
        .map((n) => {
          const cv = daEmpresa('conversations').find((c) => c.id === n.conversation_id);
          const ct = cv ? contatoDe(cv) : {};
          return {
            id: n.id,
            conversation_id: n.conversation_id,
            body_text: n.body_text,
            contact_name: ct.display_name ?? ct.phone_e164 ?? 'Contato',
          };
        });
      return responder(res, 200, { conversations, contacts, notes });
    }

    if (nome === 'save_my_contact') {
      const p = corpo.p_patch ?? {};
      const fone = p.phone ? normalizarTelefone(p.phone) : null;
      if (p.phone && !fone) return erro(400, '22023', 'invalid_phone');
      const agora = new Date().toISOString();
      if (!corpo.p_contact_id) {
        const display = String(p.display_name ?? '').trim().slice(0, 120);
        if (!display) return erro(400, '22023', 'invalid_name');
        const novo = {
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          instance_id: null,
          channel: 'manual',
          external_user_id: `manual:${crypto.randomUUID()}`,
          display_name: display,
          phone_e164: fone?.e164 ?? null,
          email: p.email ? String(p.email).trim() : null,
          company: p.company ? String(p.company).trim() : null,
          document_id: p.document_id ? String(p.document_id).trim() : null,
          city: p.city ? String(p.city).trim() : null,
          lead_source: p.lead_source ? String(p.lead_source).trim() : null,
          notes: p.notes ? String(p.notes).trim() : null,
          ai_ignored: Boolean(p.ai_ignored),
          is_blocked: Boolean(p.is_blocked),
          erased_at: null,
          created_at: agora,
        };
        tabelas.contacts.push(novo);
        anotarMudanca(workspaceId);
        return responder(res, 200, { id: novo.id, updated: true });
      }
      const ct = daEmpresa('contacts').find((c) => c.id === corpo.p_contact_id && !c.erased_at);
      if (!ct) return erro(400, 'P0002', 'Contact not found');
      Object.assign(ct, {
        ...(p.display_name !== undefined ? { display_name: String(p.display_name ?? '').trim().slice(0, 120) } : {}),
        ...(p.phone !== undefined ? { phone_e164: fone?.e164 ?? null } : {}),
        ...(p.email !== undefined ? { email: String(p.email ?? '').trim() || null } : {}),
        ...(p.company !== undefined ? { company: String(p.company ?? '').trim() || null } : {}),
        ...(p.document_id !== undefined ? { document_id: String(p.document_id ?? '').trim() || null } : {}),
        ...(p.city !== undefined ? { city: String(p.city ?? '').trim() || null } : {}),
        ...(p.lead_source !== undefined ? { lead_source: String(p.lead_source ?? '').trim() || null } : {}),
        ...(p.notes !== undefined ? { notes: String(p.notes ?? '').trim() || null } : {}),
      });
      anotarMudanca(workspaceId);
      return responder(res, 200, { id: ct.id, updated: true });
    }

    if (nome === 'start_or_open_my_conversation') {
      const chip = daEmpresa('instances').find((i) => i.id === corpo.p_instance_id && i.status !== 'revoked');
      if (!chip) return erro(400, 'P0001', 'instance_unavailable');
      const fone = normalizarTelefone(corpo.p_phone);
      if (!fone) return erro(400, '22023', 'invalid_phone');
      const core = nucleoTelefone(fone.digitos);

      let ct = daEmpresa('contacts').find(
        (c) =>
          !c.erased_at &&
          ((c.instance_id === chip.id && (c.external_user_id === fone.jid || nucleoTelefone(c.phone_e164) === core)) ||
            (c.channel === 'manual' && !c.instance_id && nucleoTelefone(c.phone_e164) === core)),
      );
      const agora = new Date().toISOString();
      if (!ct) {
        ct = {
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          instance_id: chip.id,
          channel: 'whatsapp',
          external_user_id: fone.jid,
          display_name: String(corpo.p_display_name ?? '').trim().slice(0, 120),
          phone_e164: fone.e164,
          erased_at: null,
          created_at: agora,
        };
        tabelas.contacts.push(ct);
      } else if (ct.channel === 'manual' && !ct.instance_id) {
        ct.instance_id = chip.id;
        ct.channel = 'whatsapp';
        ct.external_user_id = fone.jid;
      }

      let conv = daEmpresa('conversations').find(
        (c) => c.contact_id === ct.id && c.instance_id === chip.id && !['resolved', 'archived'].includes(c.stage),
      );
      let created = false;
      if (!conv) {
        conv = {
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          contact_id: ct.id,
          instance_id: chip.id,
          stage: 'human',
          crm_stage: 'novo',
          deal_value: 0,
          deal_status: 'open',
          is_pinned: false,
          unread_count: 0,
          automation_paused: true,
          last_message_at: agora,
          activity_at: agora,
          last_message_preview: null,
          created_at: agora,
        };
        tabelas.conversations.push(conv);
        created = true;
      }
      anotarMudanca(workspaceId);
      return responder(res, 200, { conversation_id: conv.id, contact_id: ct.id, created });
    }

    if (nome === 'update_my_contact_flags') {
      const ct = daEmpresa('contacts').find((c) => c.id === corpo.p_contact_id && !c.erased_at);
      if (!ct) return erro(400, 'P0002', 'Contact not found');
      if (typeof corpo.p_ai_ignored === 'boolean') ct.ai_ignored = corpo.p_ai_ignored;
      if (typeof corpo.p_is_blocked === 'boolean') ct.is_blocked = corpo.p_is_blocked;
      anotarMudanca(workspaceId);
      return responder(res, 200, { id: ct.id, ai_ignored: Boolean(ct.ai_ignored), is_blocked: Boolean(ct.is_blocked) });
    }

    if (nome === 'update_my_conversation_crm') {
      const conv = daEmpresa('conversations').find((c) => c.id === corpo.p_conversation_id);
      if (!conv) return erro(400, 'P0002', 'Conversation not found');
      const p = corpo.p_patch ?? {};
      if (p.crm_stage !== undefined) {
        if (!ETAPAS_KANBAN.has(p.crm_stage)) return erro(400, '22023', 'invalid_crm_stage');
        conv.crm_stage = p.crm_stage;
      }
      if (p.deal_value !== undefined) conv.deal_value = Number(p.deal_value ?? 0);
      if (p.deal_status !== undefined) {
        if (!['open', 'won', 'lost'].includes(p.deal_status)) return erro(400, '22023', 'invalid_deal_status');
        conv.deal_status = p.deal_status;
      }
      if (p.deal_lost_reason !== undefined) conv.deal_lost_reason = String(p.deal_lost_reason ?? '').trim() || null;
      if (p.is_pinned !== undefined) conv.is_pinned = Boolean(p.is_pinned);
      if (p.follow_up_at !== undefined) conv.follow_up_at = p.follow_up_at;
      if (p.stage !== undefined && ['resolved', 'archived', 'human'].includes(p.stage)) conv.stage = p.stage;
      anotarMudanca(workspaceId);
      return responder(res, 200, { id: conv.id, crm_stage: conv.crm_stage ?? 'novo' });
    }

    if (nome === 'bulk_update_my_conversations') {
      const ids = Array.isArray(corpo.p_conversation_ids) ? corpo.p_conversation_ids : [];
      const convs = daEmpresa('conversations').filter((c) => ids.includes(c.id));
      const p = corpo.p_payload ?? {};
      for (const c of convs) {
        if (corpo.p_action === 'mark_read') c.unread_count = 0;
        if (corpo.p_action === 'mark_unread') c.unread_count = Math.max(c.unread_count ?? 0, 1);
        if (corpo.p_action === 'resolve') {
          c.stage = 'resolved';
          c.unread_count = 0;
        }
        if (corpo.p_action === 'archive') {
          c.stage = 'archived';
          c.unread_count = 0;
        }
        if (corpo.p_action === 'set_crm_stage' && ETAPAS_KANBAN.has(p.crm_stage)) c.crm_stage = p.crm_stage;
      }
      anotarMudanca(workspaceId);
      return responder(res, 200, { updated: convs.length });
    }

    if (nome === 'add_my_conversation_note') {
      const conv = daEmpresa('conversations').find((c) => c.id === corpo.p_conversation_id);
      if (!conv) return erro(400, 'P0002', 'Conversation not found');
      const nota = {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        conversation_id: conv.id,
        author_user_id: usuario.id,
        author_name: usuario.nome ?? 'Equipe',
        body_text: String(corpo.p_body_text ?? '').trim(),
        created_at: new Date().toISOString(),
      };
      tabelas.conversation_notes.push(nota);
      anotarMudanca(workspaceId);
      return responder(res, 200, { id: nota.id, created_at: nota.created_at });
    }

    if (nome === 'save_my_crm_tag') {
      const tagNome = String(corpo.p_name ?? '').trim();
      if (!tagNome) return erro(400, '22023', 'invalid_tag_name');
      if (daEmpresa('crm_tags').some((t) => t.id !== corpo.p_tag_id && t.name.toLowerCase() === tagNome.toLowerCase())) {
        return erro(400, '23505', 'tag_already_exists');
      }
      const tag = {
        id: corpo.p_tag_id || crypto.randomUUID(),
        workspace_id: workspaceId,
        name: tagNome,
        color: corpo.p_color || '#64748b',
        created_at: new Date().toISOString(),
      };
      if (!corpo.p_tag_id) tabelas.crm_tags.push(tag);
      else Object.assign(daEmpresa('crm_tags').find((t) => t.id === corpo.p_tag_id) ?? {}, { name: tag.name, color: tag.color });
      anotarMudanca(workspaceId);
      return responder(res, 200, { id: tag.id, name: tag.name, color: tag.color });
    }

    if (nome === 'delete_my_crm_tag') {
      tabelas.contact_tags = tabelas.contact_tags.filter((ct) => !(ct.workspace_id === workspaceId && ct.tag_id === corpo.p_tag_id));
      tabelas.crm_tags = tabelas.crm_tags.filter((t) => !(t.workspace_id === workspaceId && t.id === corpo.p_tag_id));
      anotarMudanca(workspaceId);
      return responder(res, 200, { deleted: true });
    }

    if (nome === 'toggle_my_contact_tag') {
      tabelas.contact_tags = tabelas.contact_tags.filter(
        (ct) => !(ct.workspace_id === workspaceId && ct.contact_id === corpo.p_contact_id && ct.tag_id === corpo.p_tag_id),
      );
      if (corpo.p_attach) {
        tabelas.contact_tags.push({ workspace_id: workspaceId, contact_id: corpo.p_contact_id, tag_id: corpo.p_tag_id });
      }
      anotarMudanca(workspaceId);
      return responder(res, 200, { attached: Boolean(corpo.p_attach) });
    }

    if (nome === 'save_my_quick_reply') {
      const atalho = String(corpo.p_shortcut ?? '').trim().replace(/^\/+/, '').toLowerCase();
      const bodyText = String(corpo.p_body_text ?? '').trim();
      const titulo = String(corpo.p_title ?? '').trim() || atalho;
      if (!atalho || !bodyText) return erro(400, '22023', 'invalid_quick_reply');
      if (daEmpresa('quick_replies').some((q) => q.id !== corpo.p_reply_id && q.shortcut === atalho)) {
        return erro(400, '23505', 'quick_reply_shortcut_exists');
      }
      const qr = {
        id: corpo.p_reply_id || crypto.randomUUID(),
        workspace_id: workspaceId,
        shortcut: atalho,
        title: titulo,
        body_text: bodyText,
      };
      tabelas.quick_replies.push(qr);
      anotarMudanca(workspaceId);
      return responder(res, 200, { id: qr.id, shortcut: qr.shortcut });
    }

    if (nome === 'delete_my_quick_reply') {
      tabelas.quick_replies = tabelas.quick_replies.filter((q) => !(q.workspace_id === workspaceId && q.id === corpo.p_reply_id));
      anotarMudanca(workspaceId);
      return responder(res, 200, { deleted: true });
    }

    if (nome === 'schedule_my_message') {
      const dt = new Date(corpo.p_scheduled_for);
      if (Number.isNaN(dt.getTime()) || dt.getTime() < Date.now() - 60_000) return erro(400, '22023', 'invalid_schedule_time');
      const item = {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        conversation_id: corpo.p_conversation_id,
        body_text: String(corpo.p_body_text ?? '').trim(),
        scheduled_for: dt.toISOString(),
        status: 'pending',
        error_detail: null,
      };
      tabelas.scheduled_messages.push(item);
      anotarMudanca(workspaceId);
      return responder(res, 200, { id: item.id, status: 'pending', scheduled_for: item.scheduled_for });
    }

    if (nome === 'cancel_my_scheduled_message') {
      const item = daEmpresa('scheduled_messages').find((s) => s.id === corpo.p_scheduled_id && s.status === 'pending');
      if (!item) return erro(400, 'P0002', 'Scheduled message cannot be cancelled');
      item.status = 'cancelled';
      anotarMudanca(workspaceId);
      return responder(res, 200, { id: item.id, status: 'cancelled' });
    }

    if (nome === 'delete_my_contact_and_conversation') {
      const ct = daEmpresa('contacts').find((c) => c.id === corpo.p_contact_id);
      if (!ct) return erro(400, 'P0002', 'Contact not found');
      const convIds = new Set(daEmpresa('conversations').filter((c) => c.contact_id === ct.id).map((c) => c.id));
      const msgIds = new Set(daEmpresa('messages').filter((m) => convIds.has(m.conversation_id)).map((m) => m.id));
      for (const att of daEmpresa('message_attachments')) {
        if (msgIds.has(att.message_id)) deposito.delete(att.object_key);
      }
      tabelas.message_attachments = tabelas.message_attachments.filter((a) => !msgIds.has(a.message_id));
      tabelas.messages = tabelas.messages.filter((m) => !convIds.has(m.conversation_id));
      tabelas.conversation_notes = tabelas.conversation_notes.filter((n) => !convIds.has(n.conversation_id));
      tabelas.scheduled_messages = tabelas.scheduled_messages.filter((s) => !convIds.has(s.conversation_id));
      tabelas.conversations = tabelas.conversations.filter((c) => !convIds.has(c.id));
      tabelas.contact_tags = tabelas.contact_tags.filter((t) => t.contact_id !== ct.id);
      tabelas.contacts = tabelas.contacts.filter((c) => c.id !== ct.id);
      anotarMudanca(workspaceId);
      return responder(res, 200, { deleted: true, conversations_deleted: convIds.size, object_keys: [] });
    }

    return erro(404, 'PGRST202', `Função CRM não imitada: ${nome}`);
  }

  return {
    enriquecerConversaParaLista,
    enriquecerContatoNaConversa,
    extrasDaConversa,
    limparWorkspace,
    acoesDoCrm,
  };
}
