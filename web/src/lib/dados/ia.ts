import 'server-only';

import { lerMotor, type MotorDeIa } from '@/lib/ia/regras';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * O Motor de IA da empresa: provedor, modelos, comportamento e se as chaves estão cadastradas.
 * Passa pelas regras do banco: quem não participa da empresa não lê; o final da chave só vai para o dono.
 */
export async function lerMotorDeIa(workspaceId: string): Promise<{ motor: MotorDeIa | null; falhou: boolean }> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_ai_settings', { p_workspace_id: workspaceId });
  if (error) {
    console.error('[motor de ia] não foi possível ler as configurações:', error);
    return { motor: null, falhou: true };
  }
  return { motor: lerMotor(data), falhou: false };
}
