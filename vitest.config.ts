import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const raiz = path.dirname(fileURLToPath(import.meta.url));

/**
 * Um único comando (`npm test`) roda os três grupos de teste rápidos do repositório:
 *   shared — regras usadas pelo painel e pelo motor
 *   web    — funções puras do painel (sem navegador)
 *   banco  — migrações e regras de acesso, num Postgres em memória
 * Os testes de navegador (ponta a ponta) rodam à parte: `npm run test:e2e`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          include: ['shared/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: {
          alias: {
            '@': path.join(raiz, 'web', 'src'),
            '@ienvia/shared': path.join(raiz, 'shared', 'src', 'index.ts'),
          },
        },
        test: {
          name: 'web',
          include: ['web/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'banco',
          include: ['supabase/tests/**/*.test.ts'],
          environment: 'node',
          // Cada arquivo sobe um Postgres inteiro na memória; um de cada vez para não faltar memória.
          maxWorkers: 1,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
