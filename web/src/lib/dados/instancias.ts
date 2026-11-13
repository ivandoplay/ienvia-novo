import 'server-only';

import { executorEstaOnline } from '@ienvia/shared';
import type { FuncaoDoChip } from '@/lib/instancias/regras';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export interface ExecutorResumo {
  id: string;
  nome: string;
  online: boolean;
  status: string;
}

/** Um chip como a tela de Instâncias mostra. */
export interface Chip {
  id: string;
  apelido: string;
  funcao: FuncaoDoChip;
  /** Estado guardado no banco: disconnected, connecting, connected, paused ou error. */
  estado: string;
  /** Número conectado, no formato +5585999990000. */
  telefone: string | null;
  motor: 'evolution' | 'baileys' | 'meta';
  iaLigada: boolean;
  executorId: string | null;
  executorNome: string | null;
  executorOnline: boolean;
  pairingQr: string | null;
  pairingCode: string | null;
}

interface LinhaDeChip {
  id: string;
  display_name: string;
  purpose: FuncaoDoChip;
  status: string;
  connected_phone: string | null;
  engine: Chip['motor'];
  is_enabled: boolean;
  local_executor_id: string | null;
  pairing_qr: string | null;
  pairing_code: string | null;
}

interface LinhaExecutor {
  id: string;
  display_name: string;
  status: string;
  last_seen_at: string | null;
}

/**
 * Executores locais do workspace disponíveis para vincular a chips Baileys.
 */
export async function listarExecutoresLocais(workspaceId: string): Promise<ExecutorResumo[]> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('local_executors')
    .select('id, display_name, status, last_seen_at')
    .eq('workspace_id', workspaceId)
    .neq('status', 'revoked')
    .order('created_at', { ascending: false })
    .returns<LinhaExecutor[]>();

  if (error) {
    console.error('[instâncias] não foi possível ler os executores locais:', error);
    return [];
  }

  const agora = Date.now();
  return (data ?? []).map((e) => ({
    id: e.id,
    nome: e.display_name,
    status: e.status,
    online: executorEstaOnline(e.status, e.last_seen_at, agora),
  }));
}

/**
 * Chips do workspace, do mais antigo para o mais novo. Chips removidos não aparecem.
 * Passa pelo RLS: só entram chips da empresa de quem está logado.
 */
export async function listarChips(workspaceId: string): Promise<{ chips: Chip[]; executores: ExecutorResumo[]; falhou: boolean }> {
  const supabase = await criarClienteServidor();
  const [{ data, error }, executores] = await Promise.all([
    supabase
      .from('instances')
      .select('id, display_name, purpose, status, connected_phone, engine, is_enabled, local_executor_id, pairing_qr, pairing_code')
      .eq('workspace_id', workspaceId)
      .neq('status', 'revoked')
      .order('created_at', { ascending: true })
      .returns<LinhaDeChip[]>(),
    listarExecutoresLocais(workspaceId),
  ]);

  if (error) {
    console.error('[instâncias] não foi possível ler os chips:', error);
    return { chips: [], executores, falhou: true };
  }

  const mapaExecutores = new Map(executores.map((e) => [e.id, e]));

  return {
    falhou: false,
    executores,
    chips: (data ?? []).map((linha) => {
      const exec = linha.local_executor_id ? mapaExecutores.get(linha.local_executor_id) : undefined;
      return {
        id: linha.id,
        apelido: linha.display_name,
        funcao: linha.purpose,
        estado: linha.status,
        telefone: linha.connected_phone,
        motor: linha.engine,
        iaLigada: linha.is_enabled,
        executorId: linha.local_executor_id,
        executorNome: exec?.nome ?? null,
        executorOnline: exec?.online ?? false,
        pairingQr: linha.pairing_qr,
        pairingCode: linha.pairing_code,
      };
    }),
  };
}
