import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { WORKSPACE_INBOX } from './apoio/dados.mjs';
import { entrar } from './apoio/sessao';

const SUPABASE = 'http://127.0.0.1:54399';

test.describe('Segurança & Proteção', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
    await request.post(`${SUPABASE}/controle/reiniciar-fase5`);
  });

  test('dona configura anti-ban, horário, alerta com disparo de teste, números ignorados e fila segura', async ({ page, request }) => {
    await entrar(page, 'inbox');
    await page.goto('/seguranca');

    await expect(page.getByRole('heading', { level: 1, name: 'Segurança & Proteção' })).toBeVisible();

    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations).toEqual([]);

    // 1. Seleciona preset Conservador e salva
    await page.getByRole('button', { name: /Conservador/ }).click();
    await expect(page.getByLabel('Digitando mínimo (ms)')).toHaveValue('2200');
    await expect(page.getByLabel('Teto diário de abordagens na fila por chip')).toHaveValue('20');
    await page.getByRole('button', { name: 'Salvar regras de segurança' }).click();
    await expect(page.getByText('Regras de segurança salvas com sucesso.')).toBeVisible();

    // 2. Horário & Alertas: ativa janela comercial, liga alertas e dispara alerta de teste
    await page.getByRole('tab', { name: /Horário & Alertas/ }).click();
    await page.getByLabel('Modo de horário').selectOption('business_hours_only');
    await page.getByLabel('Ativar alertas no meu WhatsApp').check();
    await page.getByLabel('WhatsApp do responsável (DDD + número)').fill('5586999112233');
    await page.getByLabel(/Chip desconectado/).check();
    await page.getByRole('button', { name: 'Enviar alerta de teste' }).click();
    await expect(page.getByText('Alerta de teste enviado para o WhatsApp configurado.')).toBeVisible();

    const resAlertas = await request.get(`${SUPABASE}/controle/alertas-admin`);
    const alertas = (await resAlertas.json()) as Array<{ p_kind: string; p_body_text: string }>;
    expect(alertas.some((a) => a.p_kind === 'test')).toBe(true);

    // 3. Contatos Ignorados: adiciona número e confere persistência após recarregar
    await page.getByRole('tab', { name: /Contatos Ignorados/ }).click();
    await page.getByLabel('Nome / Identificação').fill('Sócio Comercial');
    await page.getByLabel(/WhatsApp \(com ou sem o 9º dígito\)/).fill('86999887766');
    await page.getByRole('button', { name: 'Adicionar à lista' }).click();
    await expect(page.getByText('Sócio Comercial')).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: /Contatos Ignorados/ }).click();
    await expect(page.getByText('Sócio Comercial')).toBeVisible();

    // 4. Fila Segura: inicia com lista colada (1 suprimido pelo número ignorado, 1 elegível)
    await page.getByRole('tab', { name: /Fila Segura/ }).click();
    await page.getByLabel('Ou colar lista (Nome;Telefone)').fill('Sócio;558699887766\nClara Mendes;86988776655');
    await page.getByRole('button', { name: 'Iniciar Fila Segura' }).click();
    await expect(page.getByText(/1 elegível.*1 suprimido/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Clara Mendes' })).toBeVisible();

    // 5. Simula envio sem confirmação -> pausa fila -> operadora confirma envio na tela
    await request.post(`${SUPABASE}/controle/simular-envio-incerto?workspace=${WORKSPACE_INBOX}&alvo=fila`);
    await page.reload();
    await page.getByRole('tab', { name: /Fila Segura/ }).click();
    await expect(page.getByRole('button', { name: 'Foi enviada' })).toBeVisible();
    await page.getByRole('button', { name: 'Foi enviada' }).click();
    await expect(page.getByText('Confirmado que a mensagem saiu.')).toBeVisible();
  });

  test('atendente enxerga anti-ban somente leitura, mas consegue gerenciar números ignorados', async ({ page }) => {
    await entrar(page, 'colega');
    await page.goto('/seguranca');

    await expect(page.getByText(/Só o dono da conta altera limites anti-ban e horários/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salvar regras de segurança' })).toHaveCount(0);

    await page.getByRole('tab', { name: /Contatos Ignorados/ }).click();
    await page.getByLabel('Nome / Identificação').fill('Fornecedor');
    await page.getByLabel(/WhatsApp \(com ou sem o 9º dígito\)/).fill('85999001122');
    await page.getByRole('button', { name: 'Adicionar à lista' }).click();
    await expect(page.getByText('Fornecedor')).toBeVisible();
  });
});
