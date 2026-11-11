/**
 * Trazer para o depósito o arquivo de uma mensagem que chegou pelo WhatsApp.
 * A Evolution, o banco e o depósito aqui são de mentira: cada teste diz o que eles respondem
 * e confere o que o painel fez com isso.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const buscarArquivoDaMensagem = vi.fn();
vi.mock('@/lib/evolution/cliente', () => ({ buscarArquivoDaMensagem }));

const { trazerArquivoDaMensagem } = await import('@/lib/inbox/buscar-arquivo');

const LOJA = '11111111-1111-4111-8111-111111111111';
const MENSAGEM = '22222222-2222-4222-8222-222222222222';
const CAMINHO = `${LOJA}/33333333-3333-4333-8333-333333333333/${MENSAGEM}/foto`;
const ALVO = { workspaceId: LOJA, mensagemId: MENSAGEM };
const MB = 1024 * 1024;

const RESERVADA = {
  claimed: true,
  object_key: CAMINHO,
  kind: 'image',
  content_type: 'image/jpeg',
  provider_instance_name: 'ienvia-chip-01',
  provider_message_id: 'WA-MSG-1',
  remote_jid: '5585999990000@s.whatsapp.net',
  from_me: false,
};

type Resposta = { data: unknown; error: { code?: string; message: string } | null };

/** Um "banco + depósito" que só anota as chamadas e devolve o que o teste mandar. */
function criarServico(respostas: { reserva?: Resposta; anotacao?: Resposta; guarda?: { error: { message: string } | null } } = {}) {
  const rpc = vi.fn<(funcao: string, parametros?: Record<string, unknown>) => Promise<Resposta>>(async (funcao) => {
    if (funcao === 'begin_media_download') return respostas.reserva ?? { data: RESERVADA, error: null };
    return respostas.anotacao ?? { data: { changed: true }, error: null };
  });
  const upload = vi.fn<(caminho: string, dados: Buffer, opcoes: Record<string, unknown>) => Promise<{ error: { message: string } | null }>>(
    async () => respostas.guarda ?? { error: null },
  );
  const from = vi.fn<(deposito: string) => { upload: typeof upload }>(() => ({ upload }));
  const servico = { rpc, storage: { from } } as unknown as SupabaseClient;
  const anotacoes = () => rpc.mock.calls.filter(([funcao]) => funcao === 'complete_media_download').map(([, parametros]) => parametros);
  return { servico, rpc, upload, from, anotacoes };
}

beforeEach(() => {
  buscarArquivoDaMensagem.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('trazer o arquivo de uma mensagem', () => {
  test('caminho feliz: reserva, busca na Evolution, guarda no depósito fechado e anota com tamanho, tipo e resumo', async () => {
    const dados = Buffer.from('bytes de uma foto de mentira');
    buscarArquivoDaMensagem.mockResolvedValue({ ok: true, dados, conteudo: 'image/jpeg; charset=binary' });
    const { servico, rpc, upload, from, anotacoes } = criarServico();
    const aviso = { key: { id: 'WA-MSG-1' }, message: { imageMessage: { mediaKey: { 0: 1 } } } };

    expect(await trazerArquivoDaMensagem(servico, ALVO, aviso)).toBe('guardado');

    expect(rpc.mock.calls[0]).toEqual(['begin_media_download', { p_workspace_id: LOJA, p_message_id: MENSAGEM }]);
    // A Evolution recebe o aviso original inteiro.
    expect(buscarArquivoDaMensagem).toHaveBeenCalledExactlyOnceWith('ienvia-chip-01', aviso);
    expect(from).toHaveBeenCalledWith('midias');
    expect(upload).toHaveBeenCalledExactlyOnceWith(CAMINHO, dados, { contentType: 'image/jpeg', cacheControl: '3600', upsert: true });
    expect(anotacoes()).toEqual([
      {
        p_workspace_id: LOJA,
        p_message_id: MENSAGEM,
        p_outcome: 'stored',
        p_content_type: 'image/jpeg',
        p_byte_size: dados.length,
        p_sha256_hex: createHash('sha256').update(dados).digest('hex'),
      },
    ]);
  });

  test('sem o aviso original ("buscar de novo"), a Evolution recebe só a identificação da mensagem', async () => {
    buscarArquivoDaMensagem.mockResolvedValue({ ok: true, dados: Buffer.from('x'), conteudo: null });
    const { servico } = criarServico({ reserva: { data: { ...RESERVADA, from_me: true }, error: null } });

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('guardado');
    expect(buscarArquivoDaMensagem).toHaveBeenCalledExactlyOnceWith('ienvia-chip-01', {
      key: { id: 'WA-MSG-1', remoteJid: '5585999990000@s.whatsapp.net', fromMe: true },
    });
  });

  test.each([
    ['a Evolution não informou o tipo: vale o que veio no aviso', null, 'image/jpeg'],
    ['a Evolution informou um tipo ilegível: vale o que veio no aviso', 'isto não é um tipo', 'image/jpeg'],
    ['a Evolution informou outro tipo: vale o dela', 'image/webp', 'image/webp'],
  ])('%s', async (_caso, informado, esperado) => {
    buscarArquivoDaMensagem.mockResolvedValue({ ok: true, dados: Buffer.from('x'), conteudo: informado });
    const { servico, upload, anotacoes } = criarServico();
    await trazerArquivoDaMensagem(servico, ALVO);
    expect(upload.mock.calls[0]?.[2]).toMatchObject({ contentType: esperado });
    expect(anotacoes()[0]).toMatchObject({ p_content_type: esperado });
  });

  test('sem tipo nenhum (nem da Evolution, nem do aviso), o arquivo é guardado como "desconhecido"', async () => {
    buscarArquivoDaMensagem.mockResolvedValue({ ok: true, dados: Buffer.from('x'), conteudo: null });
    const { servico, upload } = criarServico({ reserva: { data: { ...RESERVADA, content_type: undefined }, error: null } });
    await trazerArquivoDaMensagem(servico, ALVO);
    expect(upload.mock.calls[0]?.[2]).toMatchObject({ contentType: 'application/octet-stream' });
  });

  test('arquivo que chegou maior que 25 MB não é guardado: fica anotado como grande demais', async () => {
    buscarArquivoDaMensagem.mockResolvedValue({ ok: true, dados: Buffer.alloc(25 * MB + 1), conteudo: 'video/mp4' });
    const { servico, upload, anotacoes } = criarServico();

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('grande_demais');
    expect(upload).not.toHaveBeenCalled();
    expect(anotacoes()).toMatchObject([{ p_outcome: 'too_large', p_byte_size: null }]);
  });

  test('exatamente 25 MB ainda é guardado', async () => {
    buscarArquivoDaMensagem.mockResolvedValue({ ok: true, dados: Buffer.alloc(25 * MB), conteudo: 'video/mp4' });
    const { servico, upload } = criarServico();
    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('guardado');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('a Evolution não entrega: nada é guardado e fica anotado que falhou', async () => {
    buscarArquivoDaMensagem.mockResolvedValue({ ok: false, detalhe: 'HTTP 400: Message not found' });
    const { servico, upload, anotacoes } = criarServico();

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('falhou');
    expect(upload).not.toHaveBeenCalled();
    expect(anotacoes()).toMatchObject([{ p_outcome: 'failed', p_content_type: null, p_byte_size: null, p_sha256_hex: null }]);
  });

  test('o depósito recusa: fica anotado que falhou', async () => {
    buscarArquivoDaMensagem.mockResolvedValue({ ok: true, dados: Buffer.from('x'), conteudo: 'image/jpeg' });
    const { servico, anotacoes } = criarServico({ guarda: { error: { message: 'falha simulada do depósito' } } });

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('falhou');
    expect(anotacoes()).toMatchObject([{ p_outcome: 'failed' }]);
  });

  test('o arquivo foi guardado, mas o banco não anotou: conta como falha (a conversa oferece buscar de novo)', async () => {
    buscarArquivoDaMensagem.mockResolvedValue({ ok: true, dados: Buffer.from('x'), conteudo: 'image/jpeg' });
    const { servico, upload } = criarServico({ anotacao: { data: null, error: { code: '57014', message: 'tempo esgotado' } } });

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('falhou');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('um erro inesperado no meio do caminho não escapa: fica anotado que falhou', async () => {
    buscarArquivoDaMensagem.mockRejectedValue(new Error('explodiu'));
    const { servico, anotacoes } = criarServico();

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('falhou');
    expect(anotacoes()).toMatchObject([{ p_outcome: 'failed' }]);
  });

  test.each([
    ['outro pedido está buscando agora', { claimed: false, reason: 'in_progress' }, 'em_andamento'],
    ['já está guardado', { claimed: false, reason: 'stored' }, 'ja_resolvido'],
    ['já está marcado como grande demais', { claimed: false, reason: 'too_large' }, 'ja_resolvido'],
    ['a mensagem não tem arquivo', { claimed: false, reason: 'not_found' }, 'indisponivel'],
    ['o chip foi removido', { claimed: false, reason: 'unavailable' }, 'indisponivel'],
    ['resposta vazia do banco', null, 'indisponivel'],
  ])('sem a vez (%s): não chama a Evolution, não guarda e não anota nada', async (_caso, reserva, esperado) => {
    const { servico, upload, anotacoes } = criarServico({ reserva: { data: reserva, error: null } });

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe(esperado);
    expect(buscarArquivoDaMensagem).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(anotacoes()).toEqual([]);
  });

  test('o banco falha ao reservar: nada mais é feito', async () => {
    const { servico, rpc } = criarServico({ reserva: { data: null, error: { code: 'XX000', message: 'falha simulada' } } });

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('falhou');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(buscarArquivoDaMensagem).not.toHaveBeenCalled();
  });

  test('reserva incompleta (sem o nome do chip): devolve a vez como falha, sem chamar a Evolution', async () => {
    const { servico, anotacoes } = criarServico({ reserva: { data: { ...RESERVADA, provider_instance_name: null }, error: null } });

    expect(await trazerArquivoDaMensagem(servico, ALVO)).toBe('indisponivel');
    expect(buscarArquivoDaMensagem).not.toHaveBeenCalled();
    expect(anotacoes()).toMatchObject([{ p_outcome: 'failed' }]);
  });
});
