import 'server-only';

import { emailParaUsuario } from '@ienvia/shared';
import { situacaoDaCobranca } from '@ienvia/shared/contas';
import type { ContaSaasResumo, EventoDeAuditoriaSuporte } from '@ienvia/shared/contas';
import { dominioDeUsuario } from '@/lib/env';
import { criarClienteServidor } from '@/lib/supabase/servidor';

interface ContaBruta {
  id: string;
  name: string;
  status: 'active' | 'closed' | 'deleting' | 'deleted';
  max_instances: number;
  brand_name: string;
  brand_subtitle: string;
  plan_label: string;
  admin_notes: string;
  created_at: string;
  closed_at: string | null;
  last_support_at: string | null;
  owner: {
    user_id: string;
    email: string;
    display_name: string;
    last_sign_in_at?: string | null;
  } | null;
  members_count: number;
  instances_total: number;
  instances_connected: number;
  contacts_count: number;
  conversations_count: number;
  due_day: number | null;
  monthly_amount_cents: number | null;
  grace_days: number;
  paid_until: string | null;
  suspend_notice: string;
  owner_whatsapp: string;
  messages_month: number;
  ai_replies_month: number;
  last_message_at: string | null;
  pending_notices: number;
}

interface AuditoriaBruta {
  id: number;
  workspace_id: string | null;
  workspace_name: string;
  action: string;
  actor_email: string;
  details: Record<string, unknown>;
  created_at: string;
}

/** 'AAAA-MM-DD' de hoje no fuso de Brasília — o vencimento é uma data do calendário do cliente. */
function hojeEmBrasilia(): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return partes; // en-CA já sai como AAAA-MM-DD
}

export interface DadosDeContasSaas {
  contas: ContaSaasResumo[];
  auditoria: EventoDeAuditoriaSuporte[];
  falhou: boolean;
}

export async function carregarContasSaas(): Promise<DadosDeContasSaas> {
  const supabase = await criarClienteServidor();
  const dominio = dominioDeUsuario();

  const [resContas, resAudit] = await Promise.all([
    supabase.rpc('list_platform_workspaces'),
    supabase.rpc('list_platform_support_audit', { p_limit: 40 }),
  ]);

  if (resContas.error) console.error('[contas] falha ao listar clientes SaaS:', resContas.error);
  if (resAudit.error) console.error('[contas] falha ao listar auditoria de suporte:', resAudit.error);

  const contasBrutas = Array.isArray(resContas.data) ? (resContas.data as ContaBruta[]) : [];
  const auditBruta = Array.isArray(resAudit.data) ? (resAudit.data as AuditoriaBruta[]) : [];

  const contas: ContaSaasResumo[] = contasBrutas.map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    maxInstances: Number(item.max_instances ?? 1),
    brandName: item.brand_name || 'Ienvia',
    brandSubtitle: item.brand_subtitle ?? 'Atendente Universal',
    planLabel: item.plan_label || 'Padrão',
    adminNotes: item.admin_notes ?? '',
    createdAt: item.created_at,
    closedAt: item.closed_at ?? null,
    lastSupportAt: item.last_support_at ?? null,
    owner: item.owner
      ? {
          userId: item.owner.user_id,
          email: item.owner.email,
          login: emailParaUsuario(item.owner.email, dominio),
          displayName: item.owner.display_name || '',
        }
      : null,
    membersCount: Number(item.members_count ?? 0),
    instancesTotal: Number(item.instances_total ?? 0),
    instancesConnected: Number(item.instances_connected ?? 0),
    contactsCount: Number(item.contacts_count ?? 0),
    conversationsCount: Number(item.conversations_count ?? 0),
    usage: {
      messagesMonth: Number(item.messages_month ?? 0),
      aiRepliesMonth: Number(item.ai_replies_month ?? 0),
      lastMessageAt: item.last_message_at ?? null,
      lastSignInAt: item.owner?.last_sign_in_at ?? null,
      pendingNotices: Number(item.pending_notices ?? 0),
    },
    billing: (() => {
      const cobranca = {
        dueDay: item.due_day === null || item.due_day === undefined ? null : Number(item.due_day),
        monthlyAmountCents:
          item.monthly_amount_cents === null || item.monthly_amount_cents === undefined
            ? null
            : Number(item.monthly_amount_cents),
        graceDays: Number(item.grace_days ?? 3),
        paidUntil: item.paid_until ?? null,
        suspendNotice: item.suspend_notice ?? '',
        ownerWhatsapp: item.owner_whatsapp ?? '',
      };
      const { situation, daysToDue } = situacaoDaCobranca(cobranca, hojeEmBrasilia());
      return { ...cobranca, situation, daysToDue };
    })(),
  }));

  const auditoria: EventoDeAuditoriaSuporte[] = auditBruta.map((ev) => ({
    id: Number(ev.id),
    workspaceId: ev.workspace_id,
    workspaceName: ev.workspace_name || 'Plataforma',
    action: ev.action,
    actorEmail: emailParaUsuario(ev.actor_email, dominio),
    details: ev.details && typeof ev.details === 'object' ? ev.details : {},
    createdAt: ev.created_at,
  }));

  return {
    contas,
    auditoria,
    falhou: Boolean(resContas.error),
  };
}
