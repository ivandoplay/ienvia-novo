/**
 * Implementação em memória das tabelas e RPCs da Fase 7 (Configurações white-label,
 * política de retenção LGPD, exportação sanitizada, Clientes SaaS e Modo Suporte)
 * para o Supabase de mentira dos testes E2E do Playwright.
 */
import crypto from 'node:crypto';

export const FUNCOES_CONTAS_E_SUPORTE = [
  'update_my_workspace_branding',
  'update_my_workspace_data_policy',
  'export_my_workspace_snapshot',
  'list_platform_workspaces',
  'set_workspace_billing',
  'set_workspace_owner_whatsapp',
  'mark_workspace_paid',
  'suspend_platform_workspace',
  'reactivate_platform_workspace',
  'reset_platform_workspace',
  'owner_of_workspace',
  'log_platform_action',
  'list_platform_support_audit',
  'start_support_session',
  'end_support_session',
  'update_platform_workspace',
  'delete_platform_workspace',
  'restore_platform_workspace',
];

export const FUNCOES_SERVIDOR_FASE7 = ['provision_platform_workspace'];

const clonar = (valor) => JSON.parse(JSON.stringify(valor));

const politicaPadrao = (workspaceId) => ({
  workspace_id: workspaceId,
  message_retention_days: 60,
  media_retention_days: 30,
  recovery_window_days: 30,
  active_data_purge_sla_days: 7,
  backup_expiry_target_days: 7,
});

export function criarContasESuporteDoBanco({
  usuarios,
  workspaces,
  participacoes,
  tabelas,
  senhaPadrao,
  responder,
}) {
  const usuariosIniciais = clonar(usuarios);
  const workspacesIniciais = clonar(workspaces);
  const participacoesIniciais = clonar(participacoes);

  let auditSeq = 1;
  let senhasPorUsuario = new Map(usuarios.map((u) => [u.id, senhaPadrao]));
  let politicasPorWorkspace = new Map(workspaces.map((w) => [w.id, politicaPadrao(w.id)]));
  let sessoesSuporte = [];
  let auditoria = [];
  // Cobrança por cliente (o que o master combina): vencimento, valor, carência, pago até e aviso.
  let cobrancaPorWorkspace = new Map();
  let avisosDeSuspensao = [];
  const cobrancaPadrao = () => ({
    due_day: null,
    monthly_amount_cents: null,
    grace_days: 3,
    paid_until: null,
    suspend_notice: '',
    owner_whatsapp: '',
  });

  function reiniciarFase7() {
    usuarios.splice(0, usuarios.length, ...clonar(usuariosIniciais));
    workspaces.splice(0, workspaces.length, ...clonar(workspacesIniciais));
    participacoes.splice(0, participacoes.length, ...clonar(participacoesIniciais));
    senhasPorUsuario = new Map(usuarios.map((u) => [u.id, senhaPadrao]));
    politicasPorWorkspace = new Map(workspaces.map((w) => [w.id, politicaPadrao(w.id)]));
    cobrancaPorWorkspace = new Map();
    avisosDeSuspensao = [];
    sessoesSuporte = [];
    auditoria = [];
    auditSeq = 1;
  }

  function registrarAuditoria({ workspaceId, actorUserId, action, details = {} }) {
    const ws = workspaces.find((w) => w.id === workspaceId) ?? null;
    const ator = usuarios.find((u) => u.id === actorUserId) ?? null;
    auditoria.unshift({
      id: auditSeq++,
      workspace_id: workspaceId ?? null,
      workspace_name: ws?.name ?? 'Plataforma',
      action,
      actor_email: ator?.email ?? '',
      details,
      created_at: new Date().toISOString(),
    });
  }

  function sessoesAtivas(usuarioId) {
    const agoraIso = new Date().toISOString();
    return sessoesSuporte.filter(
      (s) => s.admin_user_id === usuarioId && s.ended_at === null && s.expires_at > agoraIso,
    );
  }

  function temSuporteAtivo(usuarioId, workspaceId) {
    return sessoesAtivas(usuarioId).some((s) => s.workspace_id === workspaceId);
  }

  function workspacesEmSuporte(usuarioId) {
    return sessoesAtivas(usuarioId).map((s) => s.workspace_id);
  }

  function papelEfetivo(usuario, workspaceId) {
    const direta = participacoes.find(
      (p) => p.user_id === usuario.id && p.workspace_id === workspaceId && p.status === 'active',
    );
    if (direta) return direta.role;
    if (usuario.master && temSuporteAtivo(usuario.id, workspaceId)) return 'owner';
    return null;
  }

  function ehDonoOuSuporte(usuario, workspaceId) {
    return papelEfetivo(usuario, workspaceId) === 'owner';
  }

  function verificarSenha(usuario, senhaInformada) {
    return senhasPorUsuario.get(usuario.id) === senhaInformada;
  }

  function atualizarSenha(usuario, novaSenha) {
    senhasPorUsuario.set(usuario.id, novaSenha);
  }

  function lerPerfil(usuario) {
    return usuario.nome ? [{ id: usuario.id, display_name: usuario.nome }] : [];
  }

  function salvarPerfil(usuario, corpo) {
    const itens = Array.isArray(corpo) ? corpo : [corpo];
    for (const item of itens) {
      if (item && item.id === usuario.id && typeof item.display_name === 'string') {
        usuario.nome = item.display_name.trim();
      }
    }
    return { id: usuario.id, display_name: usuario.nome };
  }

  function criarUsuarioAdmin(corpo) {
    const email = String(corpo?.email ?? '').trim().toLowerCase();
    if (!email) return { erro: { status: 400, corpo: { msg: 'Email obrigatório' } } };
    if (usuarios.some((u) => u.email.toLowerCase() === email)) {
      return { erro: { status: 422, corpo: { msg: 'User already registered', error_code: 'email_exists' } } };
    }
    const id = crypto.randomUUID();
    const novo = {
      id,
      email,
      nome: String(corpo?.user_metadata?.display_name ?? '').trim(),
      master: false,
    };
    usuarios.push(novo);
    senhasPorUsuario.set(id, String(corpo?.password ?? senhaPadrao));
    return { usuario: novo };
  }

  /** Troca a senha de um usuário direto pelo admin (é o que o master faz em "Senha nova"). */
  function trocarSenhaAdmin(userId, novaSenha) {
    const usuario = usuarios.find((u) => u.id === userId);
    if (!usuario) return false;
    senhasPorUsuario.set(userId, novaSenha);
    return true;
  }

  function removerUsuarioAdmin(userId) {
    const idx = usuarios.findIndex((u) => u.id === userId);
    if (idx === -1) return false;
    usuarios.splice(idx, 1);
    senhasPorUsuario.delete(userId);
    return true;
  }

  function acoesDoServidor(res, nome, corpo) {
    const erro = (status, code, message) => responder(res, status, { code, details: null, hint: null, message });
    if (nome === 'provision_platform_workspace') {
      const actor = usuarios.find((u) => u.id === corpo.p_actor_user_id);
      if (!actor?.master) return erro(403, '42501', 'Platform master required');
      const owner = usuarios.find((u) => u.id === corpo.p_owner_user_id);
      if (!owner) return erro(404, 'P0002', 'Owner user not found');

      const ws = {
        id: crypto.randomUUID(),
        name: String(corpo.p_workspace_name ?? '').trim().replace(/\s+/g, ' '),
        status: 'active',
        max_instances: Number(corpo.p_max_instances ?? 1),
        brand_name: String(corpo.p_brand_name ?? 'Ienvia').trim() || 'Ienvia',
        brand_subtitle: String(corpo.p_brand_subtitle ?? 'Atendente Universal').trim(),
        plan_label: String(corpo.p_plan_label ?? 'Padrão').trim() || 'Padrão',
        admin_notes: String(corpo.p_admin_notes ?? '').trim(),
        created_at: new Date().toISOString(),
        closed_at: null,
        last_support_at: null,
      };
      workspaces.push(ws);
      politicasPorWorkspace.set(ws.id, politicaPadrao(ws.id));
      participacoes.push({
        user_id: owner.id,
        workspace_id: ws.id,
        role: 'owner',
        status: 'active',
        created_at: new Date().toISOString(),
      });
      if (corpo.p_owner_display_name) owner.nome = String(corpo.p_owner_display_name).trim();
      registrarAuditoria({
        workspaceId: ws.id,
        actorUserId: actor.id,
        action: 'platform_workspace_created',
        details: { name: ws.name, max_instances: ws.max_instances, plan_label: ws.plan_label },
      });
      return responder(res, 200, ws);
    }
    return erro(404, 'PGRST202', `Função de servidor não imitada: ${nome}`);
  }

  function acoes(res, usuario, nome, corpo) {
    const erro = (status, code, message) => responder(res, status, { code, details: null, hint: null, message });

    if (nome === 'update_my_workspace_branding') {
      const wsId = String(corpo?.p_workspace_id ?? '');
      if (!ehDonoOuSuporte(usuario, wsId)) return erro(403, '42501', 'Workspace owner required');
      const ws = workspaces.find((w) => w.id === wsId);
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      if (ws.status !== 'active') return erro(400, 'P0001', 'Workspace is not active');
      ws.name = String(corpo.p_workspace_name ?? '').trim().replace(/\s+/g, ' ');
      ws.brand_name = String(corpo.p_brand_name ?? '').trim().replace(/\s+/g, ' ');
      ws.brand_subtitle = String(corpo.p_brand_subtitle ?? '').trim().replace(/\s+/g, ' ');
      registrarAuditoria({
        workspaceId: wsId,
        actorUserId: usuario.id,
        action: 'workspace_branding_updated',
        details: { name: ws.name, brand_name: ws.brand_name, brand_subtitle: ws.brand_subtitle },
      });
      return responder(res, 200, {
        id: ws.id,
        name: ws.name,
        brand_name: ws.brand_name,
        brand_subtitle: ws.brand_subtitle,
      });
    }

    if (nome === 'update_my_workspace_data_policy') {
      const wsId = String(corpo?.p_workspace_id ?? '');
      if (!ehDonoOuSuporte(usuario, wsId)) return erro(403, '42501', 'Workspace owner required');
      const pol = {
        workspace_id: wsId,
        message_retention_days: Number(corpo.p_message_retention_days ?? 60),
        media_retention_days: Number(corpo.p_media_retention_days ?? 30),
        recovery_window_days: Number(corpo.p_recovery_window_days ?? 30),
        active_data_purge_sla_days: Number(corpo.p_active_data_purge_sla_days ?? 7),
        backup_expiry_target_days: Number(corpo.p_backup_expiry_target_days ?? 7),
      };
      politicasPorWorkspace.set(wsId, pol);
      return responder(res, 200, pol);
    }

    if (nome === 'export_my_workspace_snapshot') {
      const wsId = String(corpo?.p_workspace_id ?? '');
      if (!ehDonoOuSuporte(usuario, wsId)) return erro(403, '42501', 'Workspace owner required');
      const ws = workspaces.find((w) => w.id === wsId && w.status !== 'deleted');
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      const msgs = tabelas.messages.filter((m) => m.workspace_id === wsId);
      const instancias = tabelas.instances
        .filter((i) => i.workspace_id === wsId && i.status !== 'revoked')
        .map((i) => ({
          id: i.id,
          display_name: i.display_name,
          channel: i.channel ?? 'whatsapp',
          engine: i.engine,
          purpose: i.purpose,
          status: i.status,
          connected_phone: i.connected_phone,
          is_enabled: i.is_enabled,
          created_at: i.created_at,
        }));
      return responder(res, 200, {
        format: 'ienvia-workspace-export-v1',
        exported_at: new Date().toISOString(),
        counts: {
          messages_total: msgs.length,
          messages_included: Math.min(msgs.length, 5000),
          messages_truncated: msgs.length > 5000,
        },
        workspace: {
          id: ws.id,
          name: ws.name,
          brand_name: ws.brand_name,
          brand_subtitle: ws.brand_subtitle,
          status: ws.status,
          max_instances: ws.max_instances,
          created_at: ws.created_at,
        },
        data_policy: politicasPorWorkspace.get(wsId) ?? politicaPadrao(wsId),
        instances: instancias,
        contacts: tabelas.contacts.filter((c) => c.workspace_id === wsId && !c.erased_at),
        conversations: tabelas.conversations.filter((c) => c.workspace_id === wsId),
        messages: msgs.slice(0, 5000),
      });
    }

    if (!usuario.master) return erro(403, '42501', 'Platform master required');

    if (nome === 'list_platform_workspaces') {
      const lista = workspaces
        .filter((w) => w.status !== 'deleted')
        .map((w) => {
          const donoPart = participacoes.find(
            (p) => p.workspace_id === w.id && p.role === 'owner' && p.status === 'active',
          );
          const dono = donoPart ? usuarios.find((u) => u.id === donoPart.user_id) : null;
          const chips = tabelas.instances.filter((i) => i.workspace_id === w.id && i.status !== 'revoked');
          const ultimoSuporte =
            sessoesSuporte
              .filter((s) => s.workspace_id === w.id)
              .map((s) => s.started_at)
              .sort()
              .pop() ?? w.last_support_at ?? null;
          return {
            id: w.id,
            name: w.name,
            status: w.status,
            max_instances: w.max_instances,
            brand_name: w.brand_name ?? 'Ienvia',
            brand_subtitle: w.brand_subtitle ?? 'Atendente Universal',
            plan_label: w.plan_label ?? 'Padrão',
            admin_notes: w.admin_notes ?? '',
            created_at: w.created_at,
            closed_at: w.closed_at ?? null,
            last_support_at: ultimoSuporte,
            owner: dono
              ? {
                  user_id: dono.id,
                  email: dono.email,
                  display_name: dono.nome ?? '',
                  last_sign_in_at: dono.last_sign_in_at ?? null,
                }
              : null,
            members_count: participacoes.filter((p) => p.workspace_id === w.id && p.status === 'active').length,
            instances_total: chips.length,
            instances_connected: chips.filter((i) => i.status === 'connected').length,
            contacts_count: tabelas.contacts.filter((c) => c.workspace_id === w.id && !c.erased_at).length,
            conversations_count: tabelas.conversations.filter((c) => c.workspace_id === w.id && c.stage !== 'archived').length,
            due_day: cobrancaPorWorkspace.get(w.id)?.due_day ?? null,
            monthly_amount_cents: cobrancaPorWorkspace.get(w.id)?.monthly_amount_cents ?? null,
            grace_days: cobrancaPorWorkspace.get(w.id)?.grace_days ?? 3,
            paid_until: cobrancaPorWorkspace.get(w.id)?.paid_until ?? null,
            suspend_notice: cobrancaPorWorkspace.get(w.id)?.suspend_notice ?? '',
            owner_whatsapp: cobrancaPorWorkspace.get(w.id)?.owner_whatsapp ?? '',
            messages_month: tabelas.messages.filter((m) => m.workspace_id === w.id).length,
            ai_replies_month: tabelas.messages.filter(
              (m) => m.workspace_id === w.id && m.actor_type === 'ai' && m.direction === 'outbound',
            ).length,
            last_message_at: tabelas.messages.filter((m) => m.workspace_id === w.id).map((m) => m.created_at ?? m.occurred_at).sort().pop() ?? null,
            pending_notices: avisosDeSuspensao.filter((a) => a.workspace_id === w.id && a.status === 'pending').length,
          };
        })
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return responder(res, 200, lista);
    }

    if (nome === 'list_platform_support_audit') {
      const limite = Math.min(Math.max(Number(corpo?.p_limit ?? 40), 1), 200);
      return responder(res, 200, auditoria.slice(0, limite));
    }

    if (nome === 'set_workspace_billing') {
      const atual = cobrancaPorWorkspace.get(corpo.p_workspace_id) ?? cobrancaPadrao();
      cobrancaPorWorkspace.set(corpo.p_workspace_id, {
        ...atual,
        due_day: corpo.p_due_day ?? null,
        monthly_amount_cents: corpo.p_monthly_amount_cents ?? null,
        grace_days: Number(corpo.p_grace_days ?? 3),
        paid_until: corpo.p_paid_until ?? null,
        suspend_notice: String(corpo.p_suspend_notice ?? '').trim(),
      });
      registrarAuditoria({
        workspaceId: corpo.p_workspace_id,
        actorUserId: usuario.id,
        action: 'platform_workspace_billing_updated',
        details: { due_day: corpo.p_due_day, paid_until: corpo.p_paid_until },
      });
      return responder(res, 200, { ok: true });
    }

    if (nome === 'set_workspace_owner_whatsapp') {
      const digitos = String(corpo.p_whatsapp ?? '').replace(/\D/g, '');
      if (digitos && (digitos.length < 10 || digitos.length > 15)) {
        return erro(400, '22023', 'Invalid whatsapp number');
      }
      const atual = cobrancaPorWorkspace.get(corpo.p_workspace_id) ?? cobrancaPadrao();
      cobrancaPorWorkspace.set(corpo.p_workspace_id, { ...atual, owner_whatsapp: digitos });
      return responder(res, 200, { ok: true, whatsapp: digitos });
    }

    if (nome === 'mark_workspace_paid') {
      const atual = cobrancaPorWorkspace.get(corpo.p_workspace_id) ?? cobrancaPadrao();
      const hoje = new Date();
      const base = atual.paid_until && new Date(`${atual.paid_until}T12:00:00Z`) > hoje ? new Date(`${atual.paid_until}T12:00:00Z`) : hoje;
      base.setUTCMonth(base.getUTCMonth() + 1);
      const ate = base.toISOString().slice(0, 10);
      cobrancaPorWorkspace.set(corpo.p_workspace_id, { ...atual, paid_until: ate });
      registrarAuditoria({
        workspaceId: corpo.p_workspace_id,
        actorUserId: usuario.id,
        action: 'platform_workspace_paid',
        details: { paid_until: ate },
      });
      return responder(res, 200, { ok: true, paid_until: ate });
    }

    if (nome === 'suspend_platform_workspace') {
      const ws = workspaces.find((w) => w.id === corpo.p_workspace_id && w.status !== 'deleted');
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      ws.status = 'closed';
      ws.closed_at = ws.closed_at ?? new Date().toISOString();
      const chips = tabelas.instances.filter((i) => i.workspace_id === ws.id && i.is_enabled !== false);
      for (const chip of chips) chip.is_enabled = false;
      const aviso = String(corpo.p_notice ?? '').trim();
      const cobranca = cobrancaPorWorkspace.get(ws.id) ?? cobrancaPadrao();
      let enfileirado = false;
      if (aviso) {
        const chip = tabelas.instances.find((i) => i.workspace_id === ws.id && i.status !== 'revoked');
        avisosDeSuspensao.push({
          id: `aviso-${avisosDeSuspensao.length + 1}`,
          workspace_id: ws.id,
          instance_id: chip?.id ?? null,
          number_key: cobranca.owner_whatsapp || chip?.logical_number_key || '',
          body_text: aviso,
          status: 'pending',
          created_at: new Date().toISOString(),
        });
        enfileirado = true;
      }
      registrarAuditoria({
        workspaceId: ws.id,
        actorUserId: usuario.id,
        action: 'platform_workspace_suspended',
        details: { reason: corpo.p_reason, chips_disabled: chips.length, notice_queued: enfileirado },
      });
      return responder(res, 200, { ok: true, status: ws.status, chips_disabled: chips.length, notice_queued: enfileirado });
    }

    if (nome === 'reactivate_platform_workspace') {
      const ws = workspaces.find((w) => w.id === corpo.p_workspace_id);
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      if (ws.deletion_started_at) return erro(400, '22023', 'Workspace is being deleted');
      ws.status = 'active';
      ws.closed_at = null;
      let cancelados = 0;
      for (const aviso of avisosDeSuspensao) {
        if (aviso.workspace_id === ws.id && aviso.status === 'pending') {
          aviso.status = 'cancelled';
          cancelados += 1;
        }
      }
      registrarAuditoria({
        workspaceId: ws.id,
        actorUserId: usuario.id,
        action: 'platform_workspace_reactivated',
        details: { notices_cancelled: cancelados },
      });
      return responder(res, 200, { ok: true, status: ws.status, notices_cancelled: cancelados });
    }

    if (nome === 'reset_platform_workspace') {
      const ws = workspaces.find((w) => w.id === corpo.p_workspace_id);
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      if (String(corpo.p_confirmation ?? '').trim().toLowerCase() !== ws.name.trim().toLowerCase()) {
        return erro(400, '22023', 'Confirmation does not match workspace name');
      }
      const apagar = (lista) => {
        const antes = lista.length;
        for (let i = lista.length - 1; i >= 0; i -= 1) if (lista[i].workspace_id === ws.id) lista.splice(i, 1);
        return antes - lista.length;
      };
      const mensagens = apagar(tabelas.messages);
      const conversas = apagar(tabelas.conversations);
      const contatos = apagar(tabelas.contacts);
      const campanhas = apagar(tabelas.campaigns ?? []);
      registrarAuditoria({
        workspaceId: ws.id,
        actorUserId: usuario.id,
        action: 'platform_workspace_reset',
        details: { messages_deleted: mensagens, conversations_deleted: conversas, contacts_deleted: contatos },
      });
      return responder(res, 200, {
        ok: true,
        messages_deleted: mensagens,
        conversations_deleted: conversas,
        contacts_deleted: contatos,
        campaigns_deleted: campanhas,
      });
    }

    if (nome === 'owner_of_workspace') {
      const donoPart = participacoes.find(
        (p) => p.workspace_id === corpo.p_workspace_id && p.role === 'owner' && p.status === 'active',
      );
      const dono = donoPart ? usuarios.find((u) => u.id === donoPart.user_id) : null;
      return responder(res, 200, dono ? { user_id: dono.id, email: dono.email, display_name: dono.nome ?? '' } : null);
    }

    if (nome === 'log_platform_action') {
      registrarAuditoria({
        workspaceId: corpo.p_workspace_id,
        actorUserId: usuario.id,
        action: corpo.p_action,
        details: corpo.p_details ?? {},
      });
      return responder(res, 200, { ok: true });
    }

    if (nome === 'update_platform_workspace') {
      const ws = workspaces.find((w) => w.id === corpo.p_workspace_id && w.status !== 'deleted');
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      ws.name = String(corpo.p_name ?? ws.name).trim().replace(/\s+/g, ' ');
      ws.status = corpo.p_status === 'closed' ? 'closed' : 'active';
      ws.max_instances = Number(corpo.p_max_instances ?? ws.max_instances);
      ws.plan_label = String(corpo.p_plan_label ?? ws.plan_label ?? 'Padrão').trim() || 'Padrão';
      ws.admin_notes = String(corpo.p_admin_notes ?? '').trim();
      ws.closed_at = ws.status === 'closed' ? ws.closed_at ?? new Date().toISOString() : null;
      registrarAuditoria({
        workspaceId: ws.id,
        actorUserId: usuario.id,
        action: 'platform_workspace_updated',
        details: { name: ws.name, status: ws.status, max_instances: ws.max_instances, plan_label: ws.plan_label },
      });
      return responder(res, 200, {
        id: ws.id,
        name: ws.name,
        status: ws.status,
        max_instances: ws.max_instances,
        plan_label: ws.plan_label,
        admin_notes: ws.admin_notes,
        closed_at: ws.closed_at,
      });
    }

    if (nome === 'delete_platform_workspace') {
      const ws = workspaces.find((w) => w.id === corpo.p_workspace_id);
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      const motivo = String(corpo.p_motivo ?? '').trim();
      if (motivo.length < 3 || motivo.length > 500) return erro(400, '22023', 'Invalid reason');
      ws.status = 'closed';
      ws.closed_at = ws.closed_at ?? new Date().toISOString();
      ws.deletion_started_at = ws.deletion_started_at ?? new Date().toISOString();
      registrarAuditoria({
        workspaceId: ws.id,
        actorUserId: usuario.id,
        action: 'platform_workspace_deleted',
        details: { name: ws.name, status: ws.status, reason: motivo },
      });
      return responder(res, 200, {
        id: ws.id,
        name: ws.name,
        status: ws.status,
        closed_at: ws.closed_at,
        deletion_started_at: ws.deletion_started_at,
        contacts: 0,
        conversations: 0,
        instances: 0,
      });
    }

    if (nome === 'restore_platform_workspace') {
      const ws = workspaces.find((w) => w.id === corpo.p_workspace_id);
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      if (ws.status === 'active' && !ws.deletion_started_at) {
        return responder(res, 200, { id: ws.id, status: ws.status, restored: false });
      }
      ws.status = 'active';
      ws.closed_at = null;
      ws.deletion_started_at = null;
      registrarAuditoria({
        workspaceId: ws.id,
        actorUserId: usuario.id,
        action: 'platform_workspace_restored',
        details: { name: ws.name, status: ws.status },
      });
      return responder(res, 200, { id: ws.id, name: ws.name, status: ws.status, restored: true });
    }

    if (nome === 'start_support_session') {
      const ws = workspaces.find(
        (w) => w.id === corpo.p_workspace_id && (w.status === 'active' || w.status === 'closed'),
      );
      if (!ws) return erro(404, 'P0002', 'Workspace not found');
      const reason = String(corpo.p_reason ?? '').trim().replace(/\s+/g, ' ');
      const agora = new Date();
      for (const prev of sessoesAtivas(usuario.id)) {
        prev.ended_at = agora.toISOString();
        registrarAuditoria({
          workspaceId: prev.workspace_id,
          actorUserId: usuario.id,
          action: 'support_session_ended',
          details: { auto_replaced: true },
        });
      }
      const nova = {
        id: crypto.randomUUID(),
        admin_user_id: usuario.id,
        workspace_id: ws.id,
        reason,
        started_at: agora.toISOString(),
        expires_at: new Date(agora.getTime() + 4 * 3600_000).toISOString(),
        ended_at: null,
      };
      sessoesSuporte.push(nova);
      ws.last_support_at = nova.started_at;
      registrarAuditoria({
        workspaceId: ws.id,
        actorUserId: usuario.id,
        action: 'support_session_started',
        details: { reason, expires_at: nova.expires_at, workspace_name: ws.name },
      });
      return responder(res, 200, {
        session_id: nova.id,
        workspace_id: ws.id,
        workspace_name: ws.name,
        workspace_status: ws.status,
        brand_name: ws.brand_name,
        brand_subtitle: ws.brand_subtitle,
        reason: nova.reason,
        started_at: nova.started_at,
        expires_at: nova.expires_at,
      });
    }

    if (nome === 'end_support_session') {
      const ativas = sessoesAtivas(usuario.id);
      const agoraIso = new Date().toISOString();
      for (const s of ativas) {
        s.ended_at = agoraIso;
        registrarAuditoria({
          workspaceId: s.workspace_id,
          actorUserId: usuario.id,
          action: 'support_session_ended',
          details: { auto_replaced: false },
        });
      }
      return responder(res, 200, { ended: ativas.length });
    }

    return erro(404, 'PGRST202', `Função não imitada: ${nome}`);
  }

  function consultarTabela(recurso, usuario, searchParams) {
    if (recurso === 'workspaces') {
      const permitidos = new Set([
        ...participacoes.filter((p) => p.user_id === usuario.id && p.status === 'active').map((p) => p.workspace_id),
        ...workspacesEmSuporte(usuario.id),
      ]);
      const eqId = searchParams.get('id');
      return workspaces.filter((w) => permitidos.has(w.id) && (!eqId || eqId === `eq.${w.id}`));
    }
    if (recurso === 'workspace_data_policies') {
      const permitidos = new Set([
        ...participacoes.filter((p) => p.user_id === usuario.id && p.status === 'active').map((p) => p.workspace_id),
        ...workspacesEmSuporte(usuario.id),
      ]);
      const eqWs = searchParams.get('workspace_id');
      return [...politicasPorWorkspace.values()].filter(
        (p) => permitidos.has(p.workspace_id) && (!eqWs || eqWs === `eq.${p.workspace_id}`),
      );
    }
    if (recurso === 'support_sessions') {
      if (!usuario.master) return [];
      return sessoesSuporte
        .filter((s) => s.admin_user_id === usuario.id)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
        .map((s) => ({
          ...s,
          workspaces: workspaces.find((w) => w.id === s.workspace_id) ?? null,
        }));
    }
    return null;
  }

  return {
    acoes,
    acoesDoServidor,
    consultarTabela,
    reiniciarFase7,
    temSuporteAtivo,
    workspacesEmSuporte,
    papelEfetivo,
    verificarSenha,
    atualizarSenha,
    lerPerfil,
    salvarPerfil,
    criarUsuarioAdmin,
    removerUsuarioAdmin,
    trocarSenhaAdmin,
  };
}
