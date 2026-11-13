import 'server-only';

import {
  VERSAO_ATUAL_DO_MOTOR,
  executorEstaOnline,
  rotuloDaPlataforma,
} from '@ienvia/shared';
import { obterVersaoEAssinatura } from '@/lib/motor/assinatura';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export interface ExecutorLocalItem {
  id: string;
  displayName: string;
  status: 'pending_pair' | 'active' | 'offline' | 'revoked';
  online: boolean;
  platform: string;
  platformLabel: string;
  motorVersion: string | null;
  lastSeenAt: string | null;
  pairedAt: string | null;
  createdAt: string;
  chipsCount: number;
}

export interface ChipLocalResumo {
  id: string;
  displayName: string;
  status: string;
  connectedPhone: string | null;
  localExecutorId: string | null;
}

export interface DadosDasConexoes {
  falhou: boolean;
  versaoPainel: string;
  versaoDisponivel: string;
  assinaturaAtiva: boolean;
  pacoteDisponivel: boolean;
  executores: ExecutorLocalItem[];
  chipsLocais: ChipLocalResumo[];
}

interface LinhaExecutor {
  id: string;
  display_name: string;
  status: ExecutorLocalItem['status'];
  platform: string;
  motor_version: string | null;
  last_seen_at: string | null;
  paired_at: string | null;
  created_at: string;
}

interface LinhaChipLocal {
  id: string;
  display_name: string;
  status: string;
  connected_phone: string | null;
  local_executor_id: string | null;
}

export async function carregarConexoesDoMotor(workspaceId: string): Promise<DadosDasConexoes> {
  const supabase = await criarClienteServidor();
  const pacoteInfo = obterVersaoEAssinatura();

  const [execRes, chipsRes] = await Promise.all([
    supabase
      .from('local_executors')
      .select('id, display_name, status, platform, motor_version, last_seen_at, paired_at, created_at')
      .eq('workspace_id', workspaceId)
      .neq('status', 'revoked')
      .order('created_at', { ascending: false })
      .returns<LinhaExecutor[]>(),
    supabase
      .from('instances')
      .select('id, display_name, status, connected_phone, local_executor_id')
      .eq('workspace_id', workspaceId)
      .eq('engine', 'baileys')
      .neq('status', 'revoked')
      .order('created_at', { ascending: true })
      .returns<LinhaChipLocal[]>(),
  ]);

  if (execRes.error) {
    console.error('[conexoes] erro ao listar executores locais:', execRes.error);
  }
  if (chipsRes.error) {
    console.error('[conexoes] erro ao listar chips locais:', chipsRes.error);
  }

  const chipsLocais: ChipLocalResumo[] = (chipsRes.data ?? []).map((c) => ({
    id: c.id,
    displayName: c.display_name,
    status: c.status,
    connectedPhone: c.connected_phone,
    localExecutorId: c.local_executor_id,
  }));

  const contagemPorExecutor = new Map<string, number>();
  for (const chip of chipsLocais) {
    if (!chip.localExecutorId) continue;
    contagemPorExecutor.set(chip.localExecutorId, (contagemPorExecutor.get(chip.localExecutorId) ?? 0) + 1);
  }

  const agora = Date.now();
  const executores: ExecutorLocalItem[] = (execRes.data ?? []).map((e) => ({
    id: e.id,
    displayName: e.display_name,
    status: e.status,
    online: executorEstaOnline(e.status, e.last_seen_at, agora),
    platform: e.platform,
    platformLabel: rotuloDaPlataforma(e.platform),
    motorVersion: e.motor_version,
    lastSeenAt: e.last_seen_at,
    pairedAt: e.paired_at,
    createdAt: e.created_at,
    chipsCount: contagemPorExecutor.get(e.id) ?? 0,
  }));

  return {
    falhou: Boolean(execRes.error || chipsRes.error),
    versaoPainel: VERSAO_ATUAL_DO_MOTOR,
    versaoDisponivel: pacoteInfo.versao,
    assinaturaAtiva: pacoteInfo.assinado,
    pacoteDisponivel: pacoteInfo.disponivel,
    executores,
    chipsLocais,
  };
}
