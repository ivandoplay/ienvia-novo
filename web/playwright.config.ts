import { defineConfig, devices } from '@playwright/test';

/**
 * Testes de ponta a ponta: abrem o painel num navegador de verdade e usam como uma pessoa usaria.
 *
 * Nenhum teste encosta no Supabase real nem cria chip de verdade. O painel é montado apontando
 * para um "Supabase de mentira", uma "Evolution de mentira" e uma "IA de mentira" (e2e/apoio), numa pasta
 * de montagem separada. Nenhuma chave de IA de verdade é usada.
 */
const PORTA_PAINEL = 3100;
const PORTA_SUPABASE_FALSO = 54399;
const PORTA_EVOLUTION_FALSA = 54398;
const PORTA_IA_FALSA = 54397;
/** O segredo que protege as chaves de IA nos testes (o mesmo de e2e/apoio/ia-no-banco-falso.mjs; nunca em produção). */
const SEGREDO_DO_COFRE_DE_TESTE = '0f1e2d3c4b5a69788796a5b4c3d2e1f00123456789abcdeffedcba9876543210';

const ambienteDoPainel = {
  IENVIA_PASTA_DE_MONTAGEM: '.next-e2e',
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PORTA_SUPABASE_FALSO}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'chave-publica-de-teste',
  // A "chave do servidor": só o Supabase de mentira a conhece (e2e/apoio/dados.mjs).
  SUPABASE_SERVICE_ROLE_KEY: 'chave-de-servico-de-teste',
  EVOLUTION_API_URL: `http://127.0.0.1:${PORTA_EVOLUTION_FALSA}`,
  EVOLUTION_API_KEY: 'chave-da-evolution-de-teste',
  IENVIA_URL_PUBLICA: 'https://painel.teste.invalid',
  // O Gemini e o OpenRouter "de mentira" (e2e/apoio/ia-falsa.mjs). Só endereços desta máquina são aceitos.
  IENVIA_GEMINI_URL: `http://127.0.0.1:${PORTA_IA_FALSA}`,
  IENVIA_OPENROUTER_URL: `http://127.0.0.1:${PORTA_IA_FALSA}/openrouter/api/v1`,
  IENVIA_NVIDIA_URL: `http://127.0.0.1:${PORTA_IA_FALSA}/nvidia/v1`,
  IENVIA_CHAVE_DOS_SEGREDOS: SEGREDO_DO_COFRE_DE_TESTE,
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
      env: { PORTA_SUPABASE_FALSO: String(PORTA_SUPABASE_FALSO), IENVIA_CHAVE_DOS_SEGREDOS: SEGREDO_DO_COFRE_DE_TESTE },
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
      command: 'node e2e/apoio/ia-falsa.mjs',
      url: `http://127.0.0.1:${PORTA_IA_FALSA}/controle/pedidos`,
      env: { PORTA_IA_FALSA: String(PORTA_IA_FALSA) },
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
