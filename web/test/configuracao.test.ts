import { afterEach, describe, expect, test, vi } from 'vitest';
import { atributosDeCookie, atributosDoCookieDeSessao } from '@/lib/cookies';
import { dominioDeUsuario, enderecoDoAviso, enderecoPublico, lerConfigSupabase } from '@/lib/env';
import { nomeDaFase } from '@/lib/fases';
import { enderecoDoDepositoParaONavegador } from '@/lib/supabase/deposito';
import { lerTema } from '@/lib/tema';

const ambiente = (valores: Record<string, string>) => valores as unknown as NodeJS.ProcessEnv;

describe('cookies do painel', () => {
  test('em produção: só por HTTPS e só no próprio site', () => {
    expect(atributosDeCookie(ambiente({ NODE_ENV: 'production' }))).toEqual({ path: '/', sameSite: 'lax', secure: true });
  });

  test('em desenvolvimento: aceita http://localhost', () => {
    expect(atributosDeCookie(ambiente({ NODE_ENV: 'development' }))).toEqual({ path: '/', sameSite: 'lax', secure: false });
  });

  test('prévia embutida afrouxa o SameSite só fora de produção', () => {
    expect(atributosDeCookie(ambiente({ NODE_ENV: 'development', IENVIA_PREVIA_EMBUTIDA: '1' }))).toEqual({
      path: '/',
      sameSite: 'none',
      secure: true,
      partitioned: true,
    });
  });

  test('em produção a opção de prévia embutida é ignorada', () => {
    expect(atributosDeCookie(ambiente({ NODE_ENV: 'production', IENVIA_PREVIA_EMBUTIDA: '1' }))).toEqual({
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  });

  test('o cookie de sessão nunca pode ser lido por scripts da página', () => {
    for (const NODE_ENV of ['production', 'development']) {
      expect(atributosDoCookieDeSessao(ambiente({ NODE_ENV })).httpOnly).toBe(true);
    }
    expect(atributosDoCookieDeSessao(ambiente({ NODE_ENV: 'development', IENVIA_PREVIA_EMBUTIDA: '1' })).httpOnly).toBe(true);
  });
});

describe('configuração do Supabase', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('sem as variáveis, o painel sabe que não está configurado', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    expect(lerConfigSupabase()).toBeNull();
  });

  test('faltando só a chave também conta como não configurado', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://exemplo.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    expect(lerConfigSupabase()).toBeNull();
  });

  test('lê o endereço e a chave pública, sem espaços sobrando', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ' https://exemplo.supabase.co ');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', ' sb_publishable_exemplo ');
    expect(lerConfigSupabase()).toEqual({ url: 'https://exemplo.supabase.co', chavePublica: 'sb_publishable_exemplo' });
  });

  test('o domínio interno de usuário tem padrão e pode ser trocado', () => {
    vi.stubEnv('AUTH_DOMINIO_USUARIO', '');
    expect(dominioDeUsuario()).toBe('zapia.local');
    vi.stubEnv('AUTH_DOMINIO_USUARIO', 'ienvia.local');
    expect(dominioDeUsuario()).toBe('ienvia.local');
  });

  test('reconhece endereço público (Netlify, Render, Vercel ou manual) e endereço direto do webhook', () => {
    expect(enderecoPublico({})).toBeNull();
    expect(enderecoPublico({ IENVIA_URL_PUBLICA: 'https://painel.ienvia.com/' })).toBe('https://painel.ienvia.com');
    expect(enderecoPublico({ VERCEL_PROJECT_PRODUCTION_URL: 'ienvia.vercel.app' })).toBe('https://ienvia.vercel.app');
    expect(enderecoPublico({ URL: 'https://ienvia.netlify.app/' })).toBe('https://ienvia.netlify.app');
    expect(enderecoPublico({ RENDER_EXTERNAL_URL: 'https://ienvia.onrender.com/' })).toBe('https://ienvia.onrender.com');

    expect(enderecoDoAviso({})).toBeNull();
    expect(enderecoDoAviso({ URL: 'https://ienvia.netlify.app' })).toBe('https://ienvia.netlify.app/api/webhooks/evolution');
    expect(
      enderecoDoAviso({
        URL: 'https://ienvia.netlify.app',
        IENVIA_WEBHOOK_URL: 'https://ienvia-porteiro.exemplo.workers.dev/',
      }),
    ).toBe('https://ienvia-porteiro.exemplo.workers.dev');
  });
});

describe('tema', () => {
  test('o escuro é o padrão; só "claro" troca', () => {
    expect(lerTema(undefined)).toBe('escuro');
    expect(lerTema('')).toBe('escuro');
    expect(lerTema('qualquer-coisa')).toBe('escuro');
    expect(lerTema('claro')).toBe('claro');
  });
});

describe('fases do plano', () => {
  test('toda fase tem nome; fase desconhecida não quebra a tela', () => {
    expect(nomeDaFase(1)).toBe('Conectar e conversar');
    expect(nomeDaFase(99)).toBe('Fase 99');
  });
});

describe('endereço do depósito de arquivos para o navegador', () => {
  const SUPABASE = 'https://projeto.supabase.co';
  const ASSINADO = `${SUPABASE}/storage/v1/object/sign/midias/empresa/conversa/mensagem/foto?token=abc`;

  test('em produção o navegador fala direto com o Supabase, sempre', () => {
    expect(enderecoDoDepositoParaONavegador(ASSINADO, ambiente({ NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: SUPABASE }))).toBe(ASSINADO);
    expect(
      enderecoDoDepositoParaONavegador(ASSINADO, ambiente({ NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: SUPABASE, IENVIA_DEPOSITO_PELO_PAINEL: '1' })),
    ).toBe(ASSINADO);
  });

  test('em desenvolvimento, sem o desvio ligado, também', () => {
    expect(enderecoDoDepositoParaONavegador(ASSINADO, ambiente({ NODE_ENV: 'development', NEXT_PUBLIC_SUPABASE_URL: SUPABASE }))).toBe(ASSINADO);
  });

  test('em desenvolvimento, com o desvio ligado, o endereço passa pelo próprio painel', () => {
    const comDesvio = ambiente({ NODE_ENV: 'development', NEXT_PUBLIC_SUPABASE_URL: `${SUPABASE}/`, IENVIA_DEPOSITO_PELO_PAINEL: '1' });
    expect(enderecoDoDepositoParaONavegador(ASSINADO, comDesvio)).toBe('/_deposito/object/sign/midias/empresa/conversa/mensagem/foto?token=abc');
    // Endereço que não é do depósito deste projeto fica como está.
    expect(enderecoDoDepositoParaONavegador('https://outro.exemplo.com/arquivo', comDesvio)).toBe('https://outro.exemplo.com/arquivo');
  });
});

describe('registros (logs) do servidor', () => {
  test('as ações do servidor não são escritas no terminal com os argumentos (ali passam chaves de IA e mensagens)', async () => {
    const { default: configuracao } = await import('../next.config');
    expect(configuracao.logging).toMatchObject({ serverFunctions: false });
  });
});
