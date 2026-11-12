import 'server-only';

import { lerBase, lerListaDeBases, type BaseDeTreinamento, type ListaDeBases } from '@/lib/ia/treinamento';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * As bases de treinamento da empresa (a padrão primeiro), com os chips que usam cada uma.
 * Passa pelas regras do banco: quem não participa da empresa não lê.
 */
export async function lerBasesDeTreinamento(workspaceId: string): Promise<{ lista: ListaDeBases | null; falhou: boolean }> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_ai_agents', { p_workspace_id: workspaceId });
  if (error) {
    console.error('[treinamento] não foi possível ler as bases:', error);
    return { lista: null, falhou: true };
  }
  return { lista: lerListaDeBases(data), falhou: false };
}

/**
 * Uma base inteira. O conteúdo dos arquivos de conhecimento só vem quando pedido
 * (para montar as instruções da IA); a tela de edição não precisa dele.
 */
export async function lerBaseDeTreinamento(
  workspaceId: string,
  baseId: string,
  comConteudoDosArquivos = false,
): Promise<{ base: BaseDeTreinamento | null; falhou: boolean }> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_ai_agent', {
    p_workspace_id: workspaceId,
    p_agent_id: baseId,
    p_include_content: comConteudoDosArquivos,
  });
  if (error) {
    // P0002 = a base não existe (ou não é desta empresa): não é uma falha do banco.
    if (error.code === 'P0002') return { base: null, falhou: false };
    console.error('[treinamento] não foi possível ler a base:', error);
    return { base: null, falhou: true };
  }
  return { base: lerBase(data), falhou: false };
}
