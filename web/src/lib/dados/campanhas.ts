import 'server-only';

import type { BlocoDeCampanha, CadenciaDeCampanha, StatusDaCampanha } from '@ienvia/shared/campanhas';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export interface PastaDeMidia {
  id: string;
  name: string;
  kind: 'image' | 'audio';
  created_at: string;
}

export interface ArquivoDeMidia {
  id: string;
  folder_id: string;
  kind: 'image' | 'audio';
  object_key: string;
  file_name: string;
  content_type: string;
  byte_size: number;
  created_at: string;
}

export interface EstatisticasDaCampanha {
  total: number;
  eligible: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  suppressed: number;
  uncertain: number;
  cancelled: number;
}

export interface ResumoDeCampanha {
  id: string;
  name: string;
  status: StatusDaCampanha;
  distribution: 'fixed' | 'round_robin';
  instance_ids: string[];
  blocks: BlocoDeCampanha[];
  cadence: Partial<CadenciaDeCampanha>;
  pause_reason: string | null;
  pause_detail: string | null;
  scheduled_for: string | null;
  confirmed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  stats: EstatisticasDaCampanha;
}

export interface DestinatarioDaCampanha {
  id: string;
  contact_id: string;
  instance_id: string | null;
  instance_name: string | null;
  display_name: string;
  phone_e164: string | null;
  custom_fields: Record<string, string>;
  status: string;
  send_allowed: boolean;
  suppression_reason: string | null;
  current_step: number;
  last_error: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
}

export interface EntregaEmAtencao {
  id: string;
  recipient_id: string;
  instance_id: string;
  step_index: number;
  block_type: 'text' | 'image' | 'audio';
  status: 'awaiting_human_confirmation' | 'failed' | 'sending';
  rendered_body: string | null;
  media_file_id: string | null;
  error_detail: string | null;
  created_at: string;
}

export interface DetalheDaCampanha {
  campaign: Omit<ResumoDeCampanha, 'stats'>;
  stats: EstatisticasDaCampanha;
  recipients: DestinatarioDaCampanha[];
  attention_deliveries: EntregaEmAtencao[];
}

export interface ChipParaCampanha {
  id: string;
  display_name: string;
  engine: 'evolution' | 'baileys';
  status: string;
  purpose: string;
  connected_phone: string | null;
}

export interface DadosDasCampanhas {
  campanhas: ResumoDeCampanha[];
  chips: ChipParaCampanha[];
  pastas: PastaDeMidia[];
  arquivos: ArquivoDeMidia[];
  iaDisponivel: boolean;
  erroLeitura?: string;
}

export async function carregarDadosDasCampanhas(workspaceId: string): Promise<DadosDasCampanhas> {
  const supabase = await criarClienteServidor();

  const [resCamp, resMidia, resChips, resChaves] = await Promise.all([
    supabase.rpc('list_my_campaigns', { p_workspace_id: workspaceId }),
    supabase.rpc('list_my_campaign_media', { p_workspace_id: workspaceId }),
    supabase
      .from('instances')
      .select('id, display_name, engine, status, purpose, connected_phone')
      .eq('workspace_id', workspaceId)
      .neq('status', 'revoked')
      .in('purpose', ['campaigns', 'both'])
      .order('created_at', { ascending: true })
      .returns<ChipParaCampanha[]>(),
    supabase.rpc('read_my_ai_settings', { p_workspace_id: workspaceId }),
  ]);

  const campanhas = Array.isArray(resCamp.data) ? (resCamp.data as ResumoDeCampanha[]) : [];
  const midia = (resMidia.data && typeof resMidia.data === 'object' ? resMidia.data : { folders: [], files: [] }) as {
    folders?: PastaDeMidia[];
    files?: ArquivoDeMidia[];
  };
  const iaObj = (resChaves.data && typeof resChaves.data === 'object' ? resChaves.data : null) as {
    configured_providers?: string[];
  } | null;

  return {
    campanhas,
    chips: resChips.data ?? [],
    pastas: Array.isArray(midia.folders) ? midia.folders : [],
    arquivos: Array.isArray(midia.files) ? midia.files : [],
    iaDisponivel: Array.isArray(iaObj?.configured_providers) && iaObj.configured_providers.length > 0,
    erroLeitura: resCamp.error || resMidia.error ? 'Não foi possível ler todas as campanhas agora.' : undefined,
  };
}
