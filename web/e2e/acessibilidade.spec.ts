import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * Verificação automática de acessibilidade (contraste, rótulos, estrutura).
 * Não substitui um teste com leitor de tela, mas pega os erros mais comuns.
 */
async function problemasGraves(page: Page) {
  const resultado = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return resultado.violations
    .filter((violacao) => violacao.impact === 'serious' || violacao.impact === 'critical')
    .map((violacao) => `${violacao.id}: ${violacao.help} (${violacao.nodes.length}x) → ${violacao.nodes[0]?.target.join(' ')}`);
}

test.describe('Acessibilidade', () => {
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

  test('aba em reconstrução', async ({ page }) => {
    await entrar(page, 'dona');
    await page.goto('/campanhas');
    expect(await problemasGraves(page)).toEqual([]);
  });

  test('menu aberto no celular', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de celular.');
    await entrar(page, 'dona');
    await page.getByRole('button', { name: 'Abrir menu de navegação' }).click();
    await expect(page.locator('#menu-principal')).toBeInViewport();
    expect(await problemasGraves(page)).toEqual([]);
  });
});
