import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * Verificação automática de acessibilidade (contraste, rótulos, estrutura).
 * Não substitui um teste com leitor de tela, mas pega os erros mais comuns.
 */
async function problemasGraves(page: Page) {
  // Só mede quando a página assentou (o título é a última coisa que o Next coloca no lugar).
  await expect(page).toHaveTitle(/.+/);
  const resultado = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return resultado.violations
    .filter((violacao) => violacao.impact === 'serious' || violacao.impact === 'critical')
    .map((violacao) => `${violacao.id}: ${violacao.help} (${violacao.nodes.length}x) → ${violacao.nodes[0]?.target.join(' ')}`);
}

test.describe('Acessibilidade', () => {
  // Sem animações, a troca de tema não deixa cores "no meio do caminho" na hora da medição.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('tela de login', async ({ page }) => {
    await page.goto('/login');
    expect(await problemasGraves(page)).toEqual([]);
  });

  test('Visão geral, tema escuro', async ({ page }) => {
    await entrar(page, 'dona');
    expect(await problemasGraves(page)).toEqual([]);
  });

  test('Visão geral, tema claro', async ({ page }) => {
    await entrar(page, 'dona');
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: /Modo claro/ }).click();
    await folha.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await problemasGraves(page)).toEqual([]);
  });

  test('configurações gerais', async ({ page }) => {
    await entrar(page, 'dona');
    await page.goto('/configuracoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Geral' })).toBeVisible();
    expect(await problemasGraves(page)).toEqual([]);
  });

  test('clientes SaaS e modo suporte', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');
    await expect(page.getByRole('heading', { level: 1, name: 'Clientes SaaS' })).toBeVisible();
    expect(await problemasGraves(page)).toEqual([]);

    await page.getByRole('button', { name: '+ Novo cliente' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Criar nova conta de cliente' })).toBeVisible();
    expect(await problemasGraves(page)).toEqual([]);

    await page.request.post('http://127.0.0.1:54399/controle/reiniciar-fase7');
  });

  test('menu aberto no celular', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de celular.');
    await entrar(page, 'dona');
    await page.getByRole('button', { name: 'Abrir menu de navegação' }).click();
    await expect(page.locator('#menu-principal')).toBeInViewport();
    expect(await problemasGraves(page)).toEqual([]);
  });
});
