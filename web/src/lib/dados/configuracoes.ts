import 'server-only';

import { MARCA_PADRAO, type PoliticaDeDados } from '@ienvia/shared/contas';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export interface DadosDeConfiguracoes {
  workspace: {
    id: string;
    name: string;
    brandName: string;
    brandSubtitle: string;
    status: string;
    maxInstances: number;
  };
  perfil: {
    displayName: string;
  };
  politicaDeDados: PoliticaDeDados;
  retencao: {
    expiradosPendentes: number;
    jaExcluidos: number;
  };
  falhou: boolean;
}

const POLITICA_PADRAO: PoliticaDeDados = {
  messageRetentionDays: 60,
  mediaRetentionDays: 30,
  recoveryWindowDays: 30,
  activeDataPurgeSlaDays: 7,
  backupExpiryTargetDays: 7,
};

export async function carregarConfiguracoes(workspaceId: string, userId: string): Promise<DadosDeConfiguracoes> {
  const supabase = await criarClienteServidor();
  const agoraIso = new Date().toISOString();

  const [wsRes, perfilRes, polRes, pendRes, excRes] = await Promise.all([
    supabase
      .from('workspaces')
      .select('id, name, brand_name, brand_subtitle, status, max_instances')
      .eq('id', workspaceId)
      .maybeSingle<{
        id: string;
        name: string;
        brand_name?: string | null;
        brand_subtitle?: string | null;
        status: string;
        max_instances: number | null;
      }>(),
    supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle<{ display_name: string }>(),
    supabase
      .from('workspace_data_policies')
      .select(
        'message_retention_days, media_retention_days, recovery_window_days, active_data_purge_sla_days, backup_expiry_target_days',
      )
      .eq('workspace_id', workspaceId)
      .maybeSingle<{
        message_retention_days: number;
        media_retention_days: number;
        recovery_window_days: number;
        active_data_purge_sla_days: number;
        backup_expiry_target_days: number;
      }>(),
    supabase
      .from('message_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('deletion_status', 'active')
      .lte('retention_delete_after', agoraIso),
    supabase
      .from('message_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('deletion_status', 'deleted'),
  ]);

  if (wsRes.error) console.error('[configurações] erro ao ler workspace:', wsRes.error);
  if (polRes.error) console.error('[configurações] erro ao ler política de dados:', polRes.error);

  const ws = wsRes.data;
  const pol = polRes.data;

  return {
    workspace: {
      id: ws?.id ?? workspaceId,
      name: ws?.name ?? 'Workspace',
      brandName: ws?.brand_name?.trim() || MARCA_PADRAO.nomeDaMarca,
      brandSubtitle: (ws?.brand_subtitle ?? MARCA_PADRAO.subtituloDaMarca).trim(),
      status: ws?.status ?? 'active',
      maxInstances: ws?.max_instances ?? 1,
    },
    perfil: {
      displayName: perfilRes.data?.display_name ?? '',
    },
    politicaDeDados: pol
      ? {
          messageRetentionDays: pol.message_retention_days,
          mediaRetentionDays: pol.media_retention_days,
          recoveryWindowDays: pol.recovery_window_days,
          activeDataPurgeSlaDays: pol.active_data_purge_sla_days,
          backupExpiryTargetDays: pol.backup_expiry_target_days,
        }
      : POLITICA_PADRAO,
    retencao: {
      expiradosPendentes: pendRes.count ?? 0,
      jaExcluidos: excRes.count ?? 0,
    },
    falhou: Boolean(wsRes.error),
  };
}
