/**
 * A rota que a Inbox consulta a cada poucos segundos ("mudou alguma coisa?").
 * O banco aqui é de mentira: só anota o que recebeu e devolve o que o teste mandar.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/servidor', () => ({ criarClienteServidor: async () => ({ rpc }) }));

const { GET } = await import('@/app/api/inbox/versao/route');

const EMPRESA = 'a0000000-0000-4000-8000-000000000004';
const perguntar = (consulta: string) => GET(new Request(`https://painel.teste.invalid/api/inbox/versao${consulta}`));

beforeEach(() => {
  rpc.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'chave-publica-de-teste';
});

describe('"mudou alguma coisa?"', () => {
  test('devolve a versão que o banco informou, sem deixar o navegador guardar a resposta', async () => {
    rpc.mockResolvedValue({ data: '1794409200.5|1794400000|3', error: null, status: 200 });
    const r = await perguntar(`?w=${EMPRESA}`);

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ versao: '1794409200.5|1794400000|3' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('read_my_inbox_version', { p_workspace_id: EMPRESA });
  });

  test('quem não participa da empresa recebe uma versão vazia (o banco é quem decide)', async () => {
    rpc.mockResolvedValue({ data: '', error: null, status: 200 });
    const r = await perguntar(`?w=${EMPRESA}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ versao: '' });
  });

  test.each([['sem empresa', ''], ['com um código que não é de empresa', '?w=1%20or%201=1'], ['com código vazio', '?w=']])(
    'pedido %s é recusado sem chegar ao banco',
    async (_caso, consulta) => {
      const r = await perguntar(consulta);
      expect(r.status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['o banco não deixa executar (sem login)', { code: '42501', message: 'permission denied for function read_my_inbox_version' }, 401],
    ['a sessão venceu', { code: 'PGRST303', message: 'JWT expired' }, 401],
    ['proibido', { code: 'XXXXX', message: 'forbidden' }, 403],
  ])('sem sessão válida (%s) responde "faça login"', async (_caso, error, status) => {
    rpc.mockResolvedValue({ data: null, error, status });
    const r = await perguntar(`?w=${EMPRESA}`);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ erro: 'Faça login para continuar.' });
  });

  test('falha do banco não é confundida com "sem login"', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 });
    const r = await perguntar(`?w=${EMPRESA}`);
    expect(r.status).toBe(500);
  });

  test('painel sem Supabase configurado avisa em vez de quebrar', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const r = await perguntar(`?w=${EMPRESA}`);
    expect(r.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });
});
