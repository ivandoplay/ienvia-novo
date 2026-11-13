import crypto from 'node:crypto';

const NAMESPACE_LEGADO = '7a1b9e20-6f3c-4e11-9d2a-000000000007';

/** Gera UUID v5 determinístico para que reexecuções não dupliquem registros. */
export function uuidDeterministico(escopo, chave) {
  const nsBytes = Buffer.from(NAMESPACE_LEGADO.replace(/-/g, ''), 'hex');
  const hash = crypto
    .createHash('sha1')
    .update(nsBytes)
    .update(`${escopo}:${String(chave)}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function normalizarEmailLegado(valor, dominioPadrao = 'zapia.local') {
  const bruto = String(valor ?? '').trim().toLowerCase();
  if (!bruto) return '';
  if (bruto.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bruto) ? bruto : '';
  }
  const limpo = bruto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]/g, '');
  return limpo ? `${limpo}@${dominioPadrao}` : '';
}

export function normalizarTelefoneE164(valor) {
  const bruto = String(valor ?? '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@c\.us$/i, '')
    .trim();
  const digitos = bruto.replace(/\D/g, '');
  if (digitos.length < 8 || digitos.length > 15) return null;
  const comDdi = digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
  if (!/^[1-9][0-9]{7,14}$/.test(comDdi)) return null;
  return {
    phone_e164: `+${comDdi}`,
    external_user_id: `${comDdi}@s.whatsapp.net`,
  };
}

function objetoAninhado(row) {
  if (!row || typeof row !== 'object') return {};
  for (const chave of ['data', 'payload', 'config', 'settings', 'state', 'json']) {
    if (row[chave] && typeof row[chave] === 'object' && !Array.isArray(row[chave])) {
      return row[chave];
    }
    if (typeof row[chave] === 'string' && row[chave].trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(row[chave]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // ignora JSON inválido
      }
    }
  }
  return {};
}

function lerCampo(row, aninhado, ...nomes) {
  for (const nome of nomes) {
    if (row?.[nome] !== undefined && row?.[nome] !== null && row?.[nome] !== '') return row[nome];
    if (aninhado?.[nome] !== undefined && aninhado?.[nome] !== null && aninhado?.[nome] !== '') return aninhado[nome];
  }
  return undefined;
}

function normalizarPapelUsuario(valor) {
  const s = String(valor ?? '').trim().toLowerCase();
  if (s === 'operator' || s === 'atendente' || s === 'member') return 'operator';
  return 'owner';
}

/**
 * Converte um retrato bruto do legado ("ZAP-IA Studio") num plano idempotente para o Ienvia.
 * Nunca escreve nem altera nada na origem.
 */
export function montarPlanoDeMigracao(legado, opcoes = {}) {
  const dominioPadrao = opcoes.dominioPadrao ?? 'zapia.local';
  const incluirCampanhas = Boolean(opcoes.incluirCampanhas);

  const rawUsers = Array.isArray(legado?.zapia_users) ? legado.zapia_users : [];
  const rawWorkspaces = Array.isArray(legado?.zapia_workspaces) ? legado.zapia_workspaces : [];
  const rawContacts = [
    ...(Array.isArray(legado?.zapia_contacts) ? legado.zapia_contacts : []),
    ...(Array.isArray(legado?.ienvia_crm_contacts) ? legado.ienvia_crm_contacts : []),
  ];
  const rawSlots = [
    ...(Array.isArray(legado?.zapia_wa_slots) ? legado.zapia_wa_slots : []),
    ...(Array.isArray(legado?.ienvia_channels) ? legado.ienvia_channels : []),
  ];
  const rawMessages = Array.isArray(legado?.ienvia_instance_messages) ? legado.ienvia_instance_messages : [];
  const rawRecipients = Array.isArray(legado?.ienvia_campanha_destinatarios)
    ? legado.ienvia_campanha_destinatarios
    : [];

  // 1) Usuários
  const usuarios = [];
  const emailsVistos = new Set();
  const usuarioPorChaveLegado = new Map();

  for (const row of rawUsers) {
    const nest = objetoAninhado(row);
    const email = normalizarEmailLegado(
      lerCampo(row, nest, 'email', 'username', 'login', 'user'),
      dominioPadrao,
    );
    const legacyId = String(lerCampo(row, nest, 'id', 'user_id', 'uid') ?? email);
    if (!email || emailsVistos.has(email)) continue;
    emailsVistos.add(email);
    const wsLegacyId = lerCampo(row, nest, 'workspace_id', 'tenant_id', 'empresa_id');
    const usuario = {
      legacyId,
      email,
      displayName: String(lerCampo(row, nest, 'name', 'display_name', 'full_name', 'nome') ?? email.split('@')[0]).slice(0, 80),
      role: normalizarPapelUsuario(lerCampo(row, nest, 'role', 'papel')),
      isMaster: Boolean(lerCampo(row, nest, 'is_master', 'is_admin', 'master')),
      legacyWorkspaceId: wsLegacyId ? String(wsLegacyId) : null,
    };
    usuarios.push(usuario);
    usuarioPorChaveLegado.set(legacyId, usuario);
    usuarioPorChaveLegado.set(email, usuario);
  }

  // 2) Workspaces + configurações/treinamento padrão
  const workspaces = [];
  const wsIdPorChave = new Map();

  for (const row of rawWorkspaces) {
    const nest = objetoAninhado(row);
    const legacyId = String(lerCampo(row, nest, 'id', 'workspace_id', 'tenant_id', 'key') ?? '');
    if (!legacyId) continue;
    const targetId = uuidDeterministico('workspace', legacyId);
    const name = String(lerCampo(row, nest, 'name', 'workspace_name', 'business_name', 'company_name', 'nome') ?? `Empresa ${legacyId.slice(0, 8)}`).trim().slice(0, 120) || 'Empresa migrada';
    const brandName = String(lerCampo(row, nest, 'brand_name', 'system_name') ?? 'Ienvia').trim().slice(0, 40) || 'Ienvia';
    const brandSubtitle = String(lerCampo(row, nest, 'brand_subtitle', 'system_subtitle') ?? 'Atendente Universal').trim().slice(0, 60);
    const maxInstances = Math.min(Math.max(Number(lerCampo(row, nest, 'max_instances', 'slot_limit') ?? 1) || 1, 0), 50);

    const ownerLegacy = lerCampo(row, nest, 'owner_id', 'user_id', 'owner_email');
    const dono =
      (ownerLegacy ? usuarioPorChaveLegado.get(String(ownerLegacy)) : null) ??
      usuarios.find((u) => u.legacyWorkspaceId === legacyId && u.role === 'owner') ??
      usuarios.find((u) => u.legacyWorkspaceId === legacyId) ??
      null;

    // Extrai treinamento básico se existir no JSON do workspace legado.
    const treinamento = {
      businessName: String(lerCampo(row, nest, 'business_name', 'company_name') ?? name).slice(0, 120),
      niche: String(lerCampo(row, nest, 'niche', 'segment', 'ramo') ?? '').slice(0, 120),
      assistantName: String(lerCampo(row, nest, 'assistant_name', 'attendant_name') ?? '').slice(0, 60),
      companySummary: String(lerCampo(row, nest, 'company_summary', 'business_description', 'about') ?? '').slice(0, 4000),
      commercialTerms: String(lerCampo(row, nest, 'commercial_terms', 'rules_commercial') ?? '').slice(0, 4000),
      goldenRules: String(lerCampo(row, nest, 'golden_rules', 'rules', 'prompt') ?? '').slice(0, 8000),
      extraInstructions: String(lerCampo(row, nest, 'extra_instructions') ?? '').slice(0, 4000),
    };

    const ws = {
      legacyId,
      targetId,
      name,
      brandName,
      brandSubtitle,
      maxInstances,
      ownerEmail: dono?.email ?? null,
      treinamento,
    };
    workspaces.push(ws);
    wsIdPorChave.set(legacyId, targetId);
  }

  // Fallback quando um usuário legado tem workspace_id que ainda não apareceu em zapia_workspaces.
  const wsDefault = workspaces[0] ?? null;

  function resolverWorkspaceId(row, nest) {
    const bruto = lerCampo(row, nest, 'workspace_id', 'tenant_id', 'empresa_id');
    if (bruto && wsIdPorChave.has(String(bruto))) return wsIdPorChave.get(String(bruto));
    return wsDefault?.targetId ?? null;
  }

  // 3) Chips / Instâncias (nascem sempre desconectados e com IA desligada!)
  const instancias = [];
  const instPorChave = new Map();
  for (const row of rawSlots) {
    const nest = objetoAninhado(row);
    const workspaceId = resolverWorkspaceId(row, nest);
    if (!workspaceId) continue;
    const legacyId = String(lerCampo(row, nest, 'id', 'slot_id', 'instance_name', 'name') ?? '');
    if (!legacyId) continue;
    const targetId = uuidDeterministico('instance', `${workspaceId}:${legacyId}`);
    if (instPorChave.has(`${workspaceId}:${legacyId}`)) continue;
    const displayName = String(lerCampo(row, nest, 'display_name', 'label', 'name', 'instance_name') ?? `Chip ${instancias.length + 1}`).trim().slice(0, 60);
    const tel = normalizarTelefoneE164(lerCampo(row, nest, 'phone', 'phone_e164', 'connected_phone', 'number'));
    const inst = {
      legacyId,
      targetId,
      workspaceId,
      displayName: displayName || 'Chip migrado',
      connectedPhone: tel?.phone_e164 ?? null,
      status: 'disconnected',
      isEnabled: false,
      channel: 'whatsapp',
      engine: 'evolution',
    };
    instancias.push(inst);
    instPorChave.set(`${workspaceId}:${legacyId}`, inst);
    const slotName = lerCampo(row, nest, 'instance_name', 'slot_key', 'name');
    if (slotName) instPorChave.set(`${workspaceId}:${String(slotName)}`, inst);
  }

  // Garante 1 instância desconectada de referência por workspace caso existam mensagens sem slot explícito.
  const instanciaFallbackPorWs = new Map();
  for (const inst of instancias) {
    if (!instanciaFallbackPorWs.has(inst.workspaceId)) {
      instanciaFallbackPorWs.set(inst.workspaceId, inst);
    }
  }

  // 4) Contatos (deduplicados por workspace + telefone)
  const contatos = [];
  const contatoPorChave = new Map();
  let contatosIgnorados = 0;

  for (const row of rawContacts) {
    const nest = objetoAninhado(row);
    const workspaceId = resolverWorkspaceId(row, nest);
    if (!workspaceId) {
      contatosIgnorados += 1;
      continue;
    }
    const tel = normalizarTelefoneE164(lerCampo(row, nest, 'phone', 'phone_e164', 'whatsapp', 'jid', 'external_user_id', 'numero'));
    const email = normalizarEmailLegado(lerCampo(row, nest, 'email'));
    const legacyId = String(lerCampo(row, nest, 'id', 'contact_id') ?? '');
    const chaveDedupe = tel ? `${workspaceId}:tel:${tel.phone_e164}` : legacyId ? `${workspaceId}:id:${legacyId}` : null;
    if (!chaveDedupe) {
      contatosIgnorados += 1;
      continue;
    }

    const displayName = String(lerCampo(row, nest, 'display_name', 'name', 'push_name', 'nome') ?? tel?.phone_e164 ?? 'Contato').trim().slice(0, 120);
    const notes = String(lerCampo(row, nest, 'notes', 'observacoes', 'obs') ?? '').slice(0, 4000);
    const company = String(lerCampo(row, nest, 'company', 'empresa') ?? '').slice(0, 120);
    const city = String(lerCampo(row, nest, 'city', 'cidade') ?? '').slice(0, 100);

    const existente = contatoPorChave.get(chaveDedupe);
    if (existente) {
      if (!existente.displayName && displayName) existente.displayName = displayName;
      if (!existente.notes && notes) existente.notes = notes;
      if (!existente.company && company) existente.company = company;
      if (!existente.city && city) existente.city = city;
      if (!existente.email && email) existente.email = email;
      if (legacyId) contatoPorChave.set(`${workspaceId}:legacy:${legacyId}`, existente);
      continue;
    }

    const targetId = uuidDeterministico('contact', chaveDedupe);
    const contato = {
      legacyId: legacyId || targetId,
      targetId,
      workspaceId,
      channel: tel ? 'whatsapp' : 'manual',
      externalUserId: tel?.external_user_id ?? null,
      phoneE164: tel?.phone_e164 ?? null,
      email: email || null,
      displayName: displayName || 'Contato migrado',
      company,
      city,
      notes,
    };
    contatos.push(contato);
    contatoPorChave.set(chaveDedupe, contato);
    if (legacyId) contatoPorChave.set(`${workspaceId}:legacy:${legacyId}`, contato);
  }

  // 5) Mensagens e conversas
  const conversasMap = new Map();
  const mensagens = [];
  const msgIdsVistos = new Set();
  let mensagensIgnoradas = 0;

  for (let idx = 0; idx < rawMessages.length; idx += 1) {
    const row = rawMessages[idx];
    const nest = objetoAninhado(row);
    const workspaceId = resolverWorkspaceId(row, nest);
    if (!workspaceId) {
      mensagensIgnoradas += 1;
      continue;
    }
    const bodyText = String(lerCampo(row, nest, 'body_text', 'body', 'text', 'message', 'content') ?? '').trim();
    if (!bodyText) {
      mensagensIgnoradas += 1;
      continue;
    }
    const rawId = lerCampo(row, nest, 'id', 'message_id', 'provider_message_id') ?? `idx-${idx}`;
    const idempotencyKey = `legado:${String(rawId).slice(0, 70)}`;
    if (msgIdsVistos.has(`${workspaceId}:${idempotencyKey}`)) continue;
    msgIdsVistos.add(`${workspaceId}:${idempotencyKey}`);

    const slotKey = lerCampo(row, nest, 'instance_id', 'slot_id', 'channel_id', 'instance_name');
    let inst = slotKey ? instPorChave.get(`${workspaceId}:${String(slotKey)}`) : null;
    if (!inst) {
      inst = instanciaFallbackPorWs.get(workspaceId) ?? null;
    }
    if (!inst) {
      const targetId = uuidDeterministico('instance', `${workspaceId}:legado-padrao`);
      inst = {
        legacyId: 'legado-padrao',
        targetId,
        workspaceId,
        displayName: 'Chip legado',
        connectedPhone: null,
        status: 'disconnected',
        isEnabled: false,
        channel: 'whatsapp',
        engine: 'evolution',
      };
      instancias.push(inst);
      instanciaFallbackPorWs.set(workspaceId, inst);
    }

    const contactLegacyId = lerCampo(row, nest, 'contact_id');
    const telMsg = normalizarTelefoneE164(
      lerCampo(row, nest, 'remote_jid', 'phone', 'phone_e164', 'from', 'to', 'whatsapp'),
    );
    let contato =
      (contactLegacyId ? contatoPorChave.get(`${workspaceId}:legacy:${String(contactLegacyId)}`) : null) ??
      (telMsg ? contatoPorChave.get(`${workspaceId}:tel:${telMsg.phone_e164}`) : null);

    if (!contato && telMsg) {
      const targetId = uuidDeterministico('contact', `${workspaceId}:tel:${telMsg.phone_e164}`);
      contato = {
        legacyId: targetId,
        targetId,
        workspaceId,
        channel: 'whatsapp',
        externalUserId: telMsg.external_user_id,
        phoneE164: telMsg.phone_e164,
        email: null,
        displayName: telMsg.phone_e164,
        company: '',
        city: '',
        notes: '',
      };
      contatos.push(contato);
      contatoPorChave.set(`${workspaceId}:tel:${telMsg.phone_e164}`, contato);
    }
    if (!contato) {
      mensagensIgnoradas += 1;
      continue;
    }

    const convKey = `${workspaceId}:${contato.targetId}:${inst.targetId}`;
    let conv = conversasMap.get(convKey);
    if (!conv) {
      conv = {
        targetId: uuidDeterministico('conversation', convKey),
        workspaceId,
        contactId: contato.targetId,
        instanceId: inst.targetId,
        stage: 'resolved',
        lastMessageAt: null,
        lastMessagePreview: null,
      };
      conversasMap.set(convKey, conv);
    }

    const directionRaw = String(lerCampo(row, nest, 'direction', 'from_me') ?? '').toLowerCase();
    const direction = directionRaw === 'outbound' || directionRaw === 'true' || directionRaw === 'out' ? 'outbound' : 'inbound';
    const occurredRaw = lerCampo(row, nest, 'occurred_at', 'created_at', 'timestamp');
    const occurredAt = occurredRaw ? new Date(occurredRaw).toISOString() : new Date().toISOString();

    if (!conv.lastMessageAt || occurredAt > conv.lastMessageAt) {
      conv.lastMessageAt = occurredAt;
      conv.lastMessagePreview = bodyText.slice(0, 120);
    }

    mensagens.push({
      targetId: uuidDeterministico('message', `${workspaceId}:${idempotencyKey}`),
      workspaceId,
      conversationId: conv.targetId,
      instanceId: inst.targetId,
      idempotencyKey,
      direction,
      sourceEngine: 'evolution',
      actorType: direction === 'inbound' ? 'contact' : 'human',
      status: direction === 'inbound' ? 'received' : 'sent',
      bodyText: bodyText.slice(0, 4096),
      occurredAt,
    });
  }

  // 6) Histórico opcional de destinatários de campanha
  const campanhasHistorico = [];
  if (incluirCampanhas && rawRecipients.length > 0) {
    const porWs = new Map();
    for (const row of rawRecipients) {
      const nest = objetoAninhado(row);
      const workspaceId = resolverWorkspaceId(row, nest);
      if (!workspaceId) continue;
      if (!porWs.has(workspaceId)) porWs.set(workspaceId, []);
      porWs.get(workspaceId).push({ row, nest });
    }
    for (const [workspaceId, itens] of porWs.entries()) {
      const inst = instanciaFallbackPorWs.get(workspaceId);
      if (!inst) continue;
      const campaignId = uuidDeterministico('campaign-legacy', workspaceId);
      const destinatarios = [];
      for (let i = 0; i < itens.length; i += 1) {
        const { row, nest } = itens[i];
        const tel = normalizarTelefoneE164(lerCampo(row, nest, 'phone', 'phone_e164', 'whatsapp', 'telefone'));
        const contato = tel ? contatoPorChave.get(`${workspaceId}:tel:${tel.phone_e164}`) : null;
        if (!contato) continue;
        const statusBruto = String(lerCampo(row, nest, 'status') ?? '').toLowerCase();
        const status = ['sent', 'delivered', 'read', 'replied', 'failed'].includes(statusBruto) ? statusBruto : 'sent';
        destinatarios.push({
          targetId: uuidDeterministico('campaign-recipient', `${campaignId}:${contato.targetId}`),
          workspaceId,
          campaignId,
          contactId: contato.targetId,
          instanceId: inst.targetId,
          status,
          idempotencyKey: `legado-dest:${campaignId}:${contato.targetId}`,
        });
      }
      if (destinatarios.length > 0) {
        campanhasHistorico.push({
          targetId: campaignId,
          workspaceId,
          name: 'Histórico legado de destinatários',
          status: 'completed',
          textBody: 'Registro histórico importado do ZAP-IA Studio.',
          destinatarios,
        });
      }
    }
  }

  return {
    usuarios,
    workspaces,
    instancias,
    contatos,
    conversas: Array.from(conversasMap.values()),
    mensagens,
    campanhasHistorico,
    resumoLeitura: {
      usuariosLidos: rawUsers.length,
      workspacesLidos: rawWorkspaces.length,
      contatosLidos: rawContacts.length,
      contatosIgnorados,
      slotsLidos: rawSlots.length,
      mensagensLidas: rawMessages.length,
      mensagensIgnoradas,
      destinatariosLidos: rawRecipients.length,
      campanhasIncluidas: incluirCampanhas,
    },
  };
}
