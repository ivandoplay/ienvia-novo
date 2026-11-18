import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Fila durável: falhas ficam pendentes para a próxima execução do cron. */
export async function limparArquivosDeConversasApagadas(supabase: SupabaseClient, limite = 50) {
  const resumo = { removidos: 0, pendentes: 0, falhas: 0 };
  const { data, error } = await supabase.from('inbox_deleted_file_queue')
    .select('workspace_id,object_key,attempts').order('attempts').order('created_at').limit(Math.max(1, Math.min(limite, 100)));
  if (error) return { ...resumo, falhas: 1 };
  for (const item of data ?? []) {
    const chave = String(item.object_key);
    // Nunca aceitar caminhos fora da pasta do workspace ou pastas compartilhadas.
    if (!new RegExp(`^${item.workspace_id}/[0-9a-f-]{36}/[^.].+`, 'i').test(chave) || chave.split('/').includes('..')) {
      resumo.falhas++; continue;
    }
    const { count, error: erroConsulta } = await supabase.from('message_attachments')
      .select('id', { count: 'exact', head: true }).eq('workspace_id', item.workspace_id).eq('object_key', chave);
    if (erroConsulta || count) { resumo.pendentes++; continue; }
    const { error: erroStorage } = await supabase.storage.from('midias').remove([chave]);
    if (erroStorage) {
      await supabase.from('inbox_deleted_file_queue').update({ attempts: Number(item.attempts) + 1 }).eq('workspace_id', item.workspace_id).eq('object_key', chave);
      resumo.falhas++; continue;
    }
    const { error: erroFila } = await supabase.from('inbox_deleted_file_queue').delete().eq('workspace_id', item.workspace_id).eq('object_key', chave);
    if (erroFila) resumo.pendentes++; else resumo.removidos++;
  }
  return resumo;
}
