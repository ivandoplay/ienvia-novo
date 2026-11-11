/**
 * A rota que mostra (ou baixa) um arquivo da Inbox. O depósito aqui é de mentira: só anota o que
 * recebeu e devolve o que o teste mandar. Quem pode ver cada arquivo é decidido pelo depósito de
 * verdade (regras em supabase/migrations, testadas em supabase/tests/midia.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const createSignedUrl = vi.fn();
const from = vi.fn<(deposito: string) => { createSignedUrl: typeof createSignedUrl }>(() => ({ createSignedUrl }));
vi.mock('@/lib/supabase/servidor', () => ({ criarClienteServidor: async () => ({ storage: { from } }) }));

const { GET } = await import('@/app/api/inbox/midia/[...caminho]/route');

const EMPRESA = 'a0000000-0000-4000-8000-000000000004';
const CONVERSA = 'f0000000-0000-4000-8000-000000000009';
const MENSAGEM = 'f1000000-0000-4000-8000-000000000013';
const CAMINHO = `${EMPRESA}/${CONVERSA}/${MENSAGEM}/foto`;
const SUPABASE = 'https://projeto-de-teste.supabase.co';
const ASSINADO = `${SUPABASE}/storage/v1/object/sign/midias/${CAMINHO}?token=codigo-assinado`;

const pedir = (caminho: string, consulta = '') =>
  GET(new Request(`https://painel.teste.invalid/api/inbox/midia/${caminho}${consulta}`), { params: Promise.resolve({ caminho: caminho.split('/') }) });

beforeEach(() => {
  createSignedUrl.mockReset();
  from.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'chave-publica-de-teste';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mostrar um arquivo da Inbox', () => {
  test('pede ao depósito um endereço que vale por uma hora e manda o navegador para ele', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: ASSINADO }, error: null });
    const r = await pedir(CAMINHO);

    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(ASSINADO);
    expect(from).toHaveBeenCalledExactlyOnceWith('midias');
    expect(createSignedUrl).toHaveBeenCalledExactlyOnceWith(CAMINHO, 3600);
  });

  test('o navegador pode reaproveitar o redirecionamento por meia hora, e só ele (nunca um servidor no caminho)', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: ASSINADO }, error: null });
    const r = await pedir(CAMINHO);
    expect(r.headers.get('cache-control')).toBe('private, max-age=1800');
    expect(r.headers.get('vary')).toBe('Cookie');
  });

  test('arquivo de um envio do painel (pasta "envios") também abre', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: ASSINADO }, error: null });
    const doEnvio = `${EMPRESA}/${CONVERSA}/envios/9487cc58-ebea-4c3a-9998-fa583056f4a5/Orcamento-n-12.pdf`;
    expect((await pedir(doEnvio)).status).toBe(302);
    expect(createSignedUrl).toHaveBeenCalledWith(doEnvio, 3600);
  });

  test('para baixar, o nome que a pessoa conhece vai junto, com acentos e espaços inteiros', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: ASSINADO }, error: null });
    const r = await pedir(CAMINHO, `?baixar=${encodeURIComponent('Tabela de preços & cia.pdf')}`);
    expect(r.headers.get('location')).toBe(`${ASSINADO}&download=Tabela%20de%20pre%C3%A7os%20%26%20cia.pdf`);
  });

  test('nome para baixar com quebra de linha ou aspas é limpo antes de ir', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: ASSINADO }, error: null });
    const r = await pedir(CAMINHO, `?baixar=${encodeURIComponent('a"\r\nb/c.pdf')}`);
    expect(r.headers.get('location')).toBe(`${ASSINADO}&download=a%20b%20c.pdf`);
  });

  test('quem não pode ver recebe o mesmo que um arquivo que não existe (o depósito responde igual, de propósito)', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    const r = await pedir(CAMINHO);

    expect(r.status).toBe(404);
    expect(r.headers.get('location')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toContain('Arquivo não encontrado');
  });

  test('falha do depósito também não entrega nada', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'tempo esgotado' } });
    expect((await pedir(CAMINHO)).status).toBe(404);
  });

  test.each([
    ['caminho de outro formato', 'qualquer/coisa'],
    ['tentando subir de pasta', `${EMPRESA}/${CONVERSA}/${MENSAGEM}/../../../segredo`],
    ['sem o nome do arquivo', `${EMPRESA}/${CONVERSA}/${MENSAGEM}`],
    ['empresa que não é um código', `empresa/${CONVERSA}/${MENSAGEM}/foto`],
    ['nome com espaço', `${EMPRESA}/${CONVERSA}/${MENSAGEM}/fo to`],
  ])('%s: recusado sem nem perguntar ao depósito', async (_caso, caminho) => {
    const r = await pedir(caminho);
    expect(r.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  test('painel sem Supabase configurado avisa em vez de quebrar', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const r = await pedir(CAMINHO);
    expect(r.status).toBe(503);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  test('só em desenvolvimento, com o desvio ligado, o endereço passa pelo próprio painel (prévia)', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: ASSINADO }, error: null });
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('IENVIA_DEPOSITO_PELO_PAINEL', '1');
    expect((await pedir(CAMINHO)).headers.get('location')).toBe(`/_deposito/object/sign/midias/${CAMINHO}?token=codigo-assinado`);

    // Em produção o desvio é ignorado, mesmo que alguém ligue a opção por engano.
    vi.stubEnv('NODE_ENV', 'production');
    expect((await pedir(CAMINHO)).headers.get('location')).toBe(ASSINADO);
  });
});
