import { defineConfig, devices } from '@playwright/test';

/**
 * Testes de ponta a ponta: abrem o painel num navegador de verdade e usam como uma pessoa usaria.
 *
 * Nenhum teste encosta no Supabase real nem cria chip de verdade. O painel é montado apontando
 * para um "Supabase de mentira" e uma "Evolution de mentira" (e2e/apoio), numa pasta de montagem separada.
 */
const PORTA_PAINEL = 3100;
const PORTA_SUPABASE_FALSO = 54399;
const PORTA_EVOLUTION_FALSA = 54398;

const ambienteDoPainel = {
  IENVIA_PASTA_DE_MONTAGEM: '.next-e2e',
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PORTA_SUPABASE_FALSO}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'chave-publica-de-teste',
  // A "chave do servidor": só o Supabase de mentira a conhece (e2e/apoio/dados.mjs).
  SUPABASE_SERVICE_ROLE_KEY: 'chave-de-servico-de-teste',
  EVOLUTION_API_URL: `http://127.0.0.1:${PORTA_EVOLUTION_FALSA}`,
  EVOLUTION_API_KEY: 'chave-da-evolution-de-teste',
  IENVIA_URL_PUBLICA: 'https://painel.teste.invalid',
  NEXT_TELEMETRY_DISABLED: '1',
};

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // O Supabase de mentira guarda as sessões na memória; um teste por vez evita surpresas.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORTA_PAINEL}`,
    locale: 'pt-BR',
    timezoneId: 'America/Fortaleza',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'computador', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'celular', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'node e2e/apoio/supabase-falso.mjs',
      url: `http://127.0.0.1:${PORTA_SUPABASE_FALSO}/saude`,
      env: { PORTA_SUPABASE_FALSO: String(PORTA_SUPABASE_FALSO) },
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: 'node e2e/apoio/evolution-falsa.mjs',
      url: `http://127.0.0.1:${PORTA_EVOLUTION_FALSA}/`,
      env: { PORTA_EVOLUTION_FALSA: String(PORTA_EVOLUTION_FALSA) },
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: `next build && next start --port ${PORTA_PAINEL}`,
      url: `http://localhost:${PORTA_PAINEL}/login`,
      env: ambienteDoPainel,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
