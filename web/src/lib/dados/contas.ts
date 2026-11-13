import 'server-only';

import { emailParaUsuario } from '@ienvia/shared';
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
  } | null;
  members_count: number;
  instances_total: number;
  instances_connected: number;
  contacts_count: number;
  conversations_count: number;
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
