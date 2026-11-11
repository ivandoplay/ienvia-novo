import { expect, test } from '@playwright/test';
import { abrirMenuDaConta, entrar, preencherLogin } from './apoio/sessao';

test.describe('Login', () => {
  test('quem não está logado é levado para a tela de login', async ({ page }) => {
    await page.goto('/visao-geral');
    await expect(page).toHaveURL(/\/login\?voltar=%2Fvisao-geral$/);
    await expect(page.getByRole('heading', { name: 'Ienvia' })).toBeVisible();
  });

  test('senha errada mostra um aviso e não entra', async ({ page }) => {
    await page.goto('/login');
    await preencherLogin(page, 'dona', 'senha-errada');

    await expect(page.locator('form').getByRole('alert')).toHaveText('Usuário ou senha incorretos.');
    await expect(page).toHaveURL(/\/login$/);
    // O usuário digitado continua no campo; a senha não.
    await expect(page.getByLabel('Usuário ou e-mail')).toHaveValue('dona');
    await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('');
  });

  test('usuário que não existe recebe o mesmo aviso (não revela quais contas existem)', async ({ page }) => {
    await page.goto('/login');
    await preencherLogin(page, 'ninguem');
    await expect(page.locator('form').getByRole('alert')).toHaveText('Usuário ou senha incorretos.');
  });

  test('entra com nome de usuário e abre a Visão geral', async ({ page }) => {
    await entrar(page, 'dona');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Bom dia|Boa tarde|Boa noite/);

    const folha = await abrirMenuDaConta(page);
    await expect(folha).toContainText('Dona Maria');
    await expect(folha).toContainText('Proprietário · Loja da Maria');
  });

  test('aceita maiúsculas e espaços sobrando no usuário', async ({ page }) => {
    await entrar(page, '  DONA ');
  });

  test('entra com e-mail completo', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    const folha = await abrirMenuDaConta(page);
    await expect(folha).toContainText('Administrador da plataforma');
  });

  test('depois do login volta para a aba que a pessoa tentou abrir', async ({ page }) => {
    await page.goto('/inbox');
    await expect(page).toHaveURL(/\/login\?voltar=%2Finbox$/);
    await preencherLogin(page, 'dona');
    await expect(page).toHaveURL(/\/inbox$/);
  });

  test('um destino de outro site na URL é ignorado', async ({ page }) => {
    await page.goto('/login?voltar=https://malvado.example.com/roubo');
    await preencherLogin(page, 'dona');
    await expect(page).toHaveURL(/localhost:\d+\/visao-geral$/);
  });

  test('quem já está logado não vê a tela de login de novo', async ({ page }) => {
    await entrar(page, 'dona');
    await page.goto('/login');
    await expect(page).toHaveURL(/\/visao-geral$/);
  });

  test('sair encerra a sessão', async ({ page }) => {
    await entrar(page, 'dona');
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: 'Sair desta conta' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // Voltar pelo endereço não reabre o painel.
    await page.goto('/visao-geral');
    await expect(page).toHaveURL(/\/login\?voltar=%2Fvisao-geral$/);
  });
});
