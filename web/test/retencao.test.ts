import { describe, expect, test, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { executarLimpezaDeRetencao } from '@/lib/dados/retencao';

describe('executarLimpezaDeRetencao', () => {
  test('remove arquivos vencidos no Storage e confirma exclusão no banco', async () => {
    const rpc = vi.fn(async (nome: string) => {
      if (nome === 'claim_expired_message_attachments') {
        return {
          data: [
            { id: 'anexo-1', workspace_id: 'ws-1', object_key: 'ws-1/conv-1/msg-1/foto.jpg' },
            { id: 'anexo-2', workspace_id: 'ws-1', object_key: 'ws-1/conv-1/msg-2/doc.pdf' },
          ],
          error: null,
        };
      }
      if (nome === 'complete_expired_message_attachments_cleanup') {
        return { data: { deleted: 2 }, error: null };
      }
      return { data: null, error: null };
    });
    const remove = vi.fn(async () => ({ data: [], error: null }));

    const supabaseFalso = {
      rpc,
      storage: { from: () => ({ remove }) },
    } as never;

    const res = await executarLimpezaDeRetencao(supabaseFalso, 20);
    expect(res).toEqual({ encontrados: 2, apagados: 2, falhasNoDeposito: 0 });
    expect(remove).toHaveBeenCalledWith(['ws-1/conv-1/msg-1/foto.jpg', 'ws-1/conv-1/msg-2/doc.pdf']);
    expect(rpc).toHaveBeenCalledWith('complete_expired_message_attachments_cleanup', {
      p_ids: ['anexo-1', 'anexo-2'],
    });
  });

  test('libera de volta para active quando um arquivo falha ao apagar no Storage', async () => {
    const rpc = vi.fn(async (nome: string) => {
      if (nome === 'claim_expired_message_attachments') {
        return {
          data: [
            { id: 'a-ok', workspace_id: 'ws-1', object_key: 'k-ok' },
            { id: 'a-falha', workspace_id: 'ws-1', object_key: 'k-falha' },
          ],
          error: null,
        };
      }
      if (nome === 'complete_expired_message_attachments_cleanup') {
        return { data: { deleted: 1 }, error: null };
      }
      return { data: 1, error: null };
    });

    const remove = vi.fn(async (chaves: string[]) => {
      if (chaves.length > 1) return { data: null, error: { message: 'batch error' } };
      if (chaves[0] === 'k-falha') return { data: null, error: { message: 'network timeout' } };
      return { data: [], error: null };
    });

    const supabaseFalso = {
      rpc,
      storage: { from: () => ({ remove }) },
    } as never;

    const res = await executarLimpezaDeRetencao(supabaseFalso, 20);
    expect(res).toEqual({ encontrados: 2, apagados: 1, falhasNoDeposito: 1 });
    expect(rpc).toHaveBeenCalledWith('release_expired_message_attachments', { p_ids: ['a-falha'] });
    expect(rpc).toHaveBeenCalledWith('complete_expired_message_attachments_cleanup', { p_ids: ['a-ok'] });
  });
});
