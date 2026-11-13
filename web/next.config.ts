import path from 'node:path';
import type { NextConfig } from 'next';

const emProducao = process.env.NODE_ENV === 'production';

/**
 * Origens extras aceitas só em desenvolvimento (ex.: a prévia desta conversa roda
 * atrás de um proxy em outro domínio). Em produção fica vazio.
 * Exemplo: IENVIA_ORIGENS_DEV="*.e2b.app"
 */
const origensDev = (process.env.IENVIA_ORIGENS_DEV ?? '')
  .split(',')
  .map((origem) => origem.trim())
  .filter(Boolean);

/**
 * Só em desenvolvimento: faz o depósito de arquivos (Supabase Storage) responder pelo próprio painel,
 * em /_deposito/... Serve para prévias em que o navegador não alcança o Supabase diretamente.
 * Em produção não existe: o navegador fala direto com o Supabase. (ver src/lib/supabase/deposito.ts)
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '');
const depositoPeloPainel = !emProducao && process.env.IENVIA_DEPOSITO_PELO_PAINEL === '1' && Boolean(supabaseUrl);

const cabecalhosDeSeguranca = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=(self)' },
  // Em produção o painel nunca pode ser embutido em outro site (proteção contra clickjacking).
  ...(emProducao ? [{ key: 'X-Frame-Options', value: 'DENY' }] : []),
];

const config: NextConfig = {
  // Os testes de ponta a ponta montam o painel numa pasta separada (.cache/next-e2e, definida em
  // playwright.config.ts), para não misturar com a montagem normal.
  distDir: process.env.IENVIA_PASTA_DE_MONTAGEM || '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  // O pacote compartilhado é TypeScript puro; o Next compila junto com o painel.
  transpilePackages: ['@ienvia/shared'],
  // A raiz do repositório (uma pasta acima) é a raiz do monorepo.
  outputFileTracingRoot: path.join(__dirname, '..'),
  outputFileTracingIncludes: {
    '/api/motor/pacote': ['../motor/package.json', '../motor/src/**/*', '../motor/scripts/**/*'],
    '/api/motor/versao': ['../motor/package.json', '../motor/src/**/*', '../motor/scripts/**/*'],
  },
  turbopack: { root: path.join(__dirname, '..') },
  allowedDevOrigins: origensDev,
  // Em desenvolvimento, o Next escreve no terminal cada ação do servidor COM os argumentos. Aqui os
  // argumentos incluem chaves de IA e mensagens de clientes: isso não pode ir para registro nenhum.
  logging: { serverFunctions: false },
  experimental: {
    serverActions: {
      allowedOrigins: emProducao ? [] : origensDev,
      bodySizeLimit: '6mb',
    },
  },
  async headers() {
    return [{ source: '/:path*', headers: cabecalhosDeSeguranca }];
  },
  async rewrites() {
    return depositoPeloPainel ? [{ source: '/_deposito/:caminho*', destination: `${supabaseUrl}/storage/v1/:caminho*` }] : [];
  },
};

export default config;
