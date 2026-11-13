import 'server-only';

import {
  lerSegurancaDoBanco,
  PADRAO_SEGURANCA,
  type ConfiguracaoDeSeguranca,
} from '@ienvia/shared/seguranca';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export interface NumeroIgnoradoManual {
  id: string;
  name: string;
  phone_digits: string;
  note: string;
  created_at: string;
}

export interface ContatoIgnoradoCrm {
  contact_id: string;
  display_name: string;
  phone_e164: string | null;
  ai_ignored: boolean;
  is_blocked: boolean;
}

export interface ListaIgnorados {
  manual: NumeroIgnoradoManual[];
  contacts: ContatoIgnoradoCrm[];
}

export interface ItemDaFilaSegura {
  id: string;
  instance_id: string | null;
  recipient_name: string;
  recipient_phone: string;
  rendered_body: string;
  status: 'pending' | 'sending' | 'awaiting_human_confirmation' | 'sent' | 'failed' | 'suppressed';
  suppression_reason: string | null;
  error_detail: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface ChipParaFila {
  id: string;
  display_name: string;
  engine: 'evolution' | 'baileys';
  status: string;
  purpose: string;
  connected_phone: string | null;
}

export interface DadosDaFilaSegura {
  state: {
    status: 'idle' | 'running' | 'paused' | 'completed';
    pause_reason: string | null;
    mode: 'auto_rotate' | 'single';
    fixed_instance_id: string | null;
    message_template: string;
    next_send_at: string | null;
    updated_at: string | null;
  };
  counts: {
    pending: number;
    sending: number;
    awaiting_human_confirmation: number;
    sent: number;
    failed: number;
    suppressed: number;
  };
  items: ItemDaFilaSegura[];
  daily_sent_by_chip: Record<string, number>;
  daily_limit: number;
  chips: ChipParaFila[];
}

export interface DadosDeSeguranca {
  configuracao: ConfiguracaoDeSeguranca;
  podeEditarRegras: boolean;
  ignorados: ListaIgnorados;
  fila: DadosDaFilaSegura;
  erroLeitura?: string;
}

const FILA_VAZIA: DadosDaFilaSegura = {
  state: {
    status: 'idle',
    pause_reason: null,
    mode: 'auto_rotate',
    fixed_instance_id: null,
    message_template: '',
    next_send_at: null,
    updated_at: null,
  },
  counts: { pending: 0, sending: 0, awaiting_human_confirmation: 0, sent: 0, failed: 0, suppressed: 0 },
  items: [],
  daily_sent_by_chip: {},
  daily_limit: 25,
  chips: [],
};

export async function carregarDadosDeSeguranca(workspaceId: string): Promise<DadosDeSeguranca> {
  const supabase = await criarClienteServidor();

  const [resSec, resIgn, resFila] = await Promise.all([
    supabase.rpc('read_my_security_settings', { p_workspace_id: workspaceId }),
    supabase.rpc('list_my_ignored_numbers', { p_workspace_id: workspaceId }),
    supabase.rpc('read_my_proactive_queue', { p_workspace_id: workspaceId }),
  ]);

  const secObj = (resSec.data && typeof resSec.data === 'object' ? resSec.data : null) as
    | (Record<string, unknown> & { can_edit?: boolean })
    | null;

  const ignorados = (resIgn.data && typeof resIgn.data === 'object' ? resIgn.data : { manual: [], contacts: [] }) as ListaIgnorados;
  const fila = (resFila.data && typeof resFila.data === 'object' ? resFila.data : FILA_VAZIA) as DadosDaFilaSegura;

  const erroLeitura = resSec.error || resIgn.error || resFila.error ? 'Algumas informações de segurança não puderam ser carregadas agora.' : undefined;

  return {
    configuracao: secObj
      ? lerSegurancaDoBanco(secObj)
      : { ...PADRAO_SEGURANCA, scheduleWorkDays: [...PADRAO_SEGURANCA.scheduleWorkDays], adminAlertEvents: [...PADRAO_SEGURANCA.adminAlertEvents] },
    podeEditarRegras: secObj?.can_edit === true,
    ignorados: {
      manual: Array.isArray(ignorados.manual) ? ignorados.manual : [],
      contacts: Array.isArray(ignorados.contacts) ? ignorados.contacts : [],
    },
    fila: {
      state: fila.state ?? FILA_VAZIA.state,
      counts: fila.counts ?? FILA_VAZIA.counts,
      items: Array.isArray(fila.items) ? fila.items : [],
      daily_sent_by_chip: fila.daily_sent_by_chip ?? {},
      daily_limit: typeof fila.daily_limit === 'number' ? fila.daily_limit : 25,
      chips: Array.isArray(fila.chips) ? fila.chips : [],
    },
    erroLeitura,
  };
}
