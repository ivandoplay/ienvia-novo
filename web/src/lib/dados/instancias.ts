import 'server-only';

import type { FuncaoDoChip } from '@/lib/instancias/regras';
import { criarClienteServidor } from '@/lib/supabase/servidor';

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
}

interface LinhaDeChip {
  id: string;
  display_name: string;
  purpose: FuncaoDoChip;
  status: string;
  connected_phone: string | null;
  engine: Chip['motor'];
  is_enabled: boolean;
}

/**
 * Chips do workspace, do mais antigo para o mais novo. Chips removidos não aparecem.
 * Passa pelo RLS: só entram chips da empresa de quem está logado.
 */
export async function listarChips(workspaceId: string): Promise<{ chips: Chip[]; falhou: boolean }> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('instances')
    .select('id, display_name, purpose, status, connected_phone, engine, is_enabled')
    .eq('workspace_id', workspaceId)
    .neq('status', 'revoked')
    .order('created_at', { ascending: true })
    .returns<LinhaDeChip[]>();

  if (error) {
    console.error('[instâncias] não foi possível ler os chips:', error);
    return { chips: [], falhou: true };
  }

  return {
    falhou: false,
    chips: (data ?? []).map((linha) => ({
      id: linha.id,
      apelido: linha.display_name,
      funcao: linha.purpose,
      estado: linha.status,
      telefone: linha.connected_phone,
      motor: linha.engine,
      iaLigada: linha.is_enabled,
    })),
  };
}
