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

const cabecalhosDeSeguranca = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=(self)' },
  // Em produção o painel nunca pode ser embutido em outro site (proteção contra clickjacking).
  ...(emProducao ? [{ key: 'X-Frame-Options', value: 'DENY' }] : []),
];

const config: NextConfig = {
  // Os testes de ponta a ponta montam o painel numa pasta separada (.next-e2e),
  // para não misturar com a montagem normal.
  distDir: process.env.IENVIA_PASTA_DE_MONTAGEM || '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  // O pacote compartilhado é TypeScript puro; o Next compila junto com o painel.
  transpilePackages: ['@ienvia/shared'],
  // A raiz do repositório (uma pasta acima) é a raiz do monorepo.
  outputFileTracingRoot: path.join(__dirname, '..'),
  turbopack: { root: path.join(__dirname, '..') },
  allowedDevOrigins: origensDev,
  experimental: {
    serverActions: {
      allowedOrigins: emProducao ? [] : origensDev,
    },
  },
  async headers() {
    return [{ source: '/:path*', headers: cabecalhosDeSeguranca }];
  },
};

export default config;
