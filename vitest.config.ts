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
            // "server-only" é uma trava do Next (impede o navegador de importar código do servidor);
            // nos testes, que rodam fora do Next, ela vira um arquivo vazio.
            'server-only': path.join(raiz, 'web', 'test', 'apoio', 'vazio.ts'),
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
          // O Postgres em memória é pesado (uns 400 MB, com pico de ~1 GB ao subir). Para caber em
          // máquinas pequenas: um processo só, sem isolar os arquivos (assim todos usam o mesmo
          // banco — ver `bancoDaRodada`), e sem a compilação otimizada de WebAssembly do Node,
          // que é o que causa o pico. Os testes ficam um pouco mais lentos e bem mais leves.
          maxWorkers: 1,
          fileParallelism: false,
          isolate: false,
          execArgv: ['--liftoff-only'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
