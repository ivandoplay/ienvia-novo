import { expect, test } from '@playwright/test';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

test.describe('Visão geral', () => {
  test('mostra os números do workspace da pessoa', async ({ page }) => {
    await entrar(page, 'dona');

    // Cada cartão é um link lido como "3 Esperando você conversas paradas · abrir".
    for (const nome of [
      /^3\s*Esperando você\s*conversas paradas · abrir$/,
      /^Ligada\s*IA respondendo\s*em 1 chip$/,
      /^1\s*Campanhas ativas\s*em andamento$/,
      /^2\s*Chips online\s*de 3 cadastrados$/,
      /^12\s*Mensagens recebidas\s*hoje · 9 respostas da IA$/,
      /^41\s*Contatos\s*no seu CRM$/,
    ]) {
      await expect(page.getByRole('link', { name: nome })).toBeVisible();
    }

    const funil = page.getByRole('region', { name: 'Funil de conversão' }).getByRole('listitem');
    await expect(funil).toHaveText([/Novas\s*4/, /Com a IA\s*7/, /Esperando você\s*3/, /Com você\s*2/, /Aguardando o cliente\s*1/, /Resolvidas\s*5/]);

    await expect(page.locator('.topbar .status-pill')).toHaveText('2 de 3 conectados');
  });

  test('um workspace não enxerga os números do outro', async ({ page }) => {
    // O "master" é dono da "Outra Empresa", que está vazia.
    await entrar(page, 'master@exemplo.com');

    await expect(page.getByRole('link', { name: /^0\s*Esperando você/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^0\s*Contatos/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Desligada\s*IA respondendo\s*atendimento automático$/ })).toBeVisible();
    await expect(page.locator('.topbar .status-pill')).toHaveText('Nenhum chip');
    await expect(page.getByText('Sem conversas no funil ainda')).toBeVisible();
  });

  test('conta sem workspace vê um aviso claro em vez de um painel vazio', async ({ page }) => {
    await entrar(page, 'novato');
    await expect(page.getByRole('heading', { name: 'Sua conta ainda não tem um workspace' })).toBeVisible();
  });
});

test.describe('Navegação', () => {
  test('as abas ainda não refeitas avisam em que fase ficam prontas', async ({ page }) => {
    await entrar(page, 'dona');
    await page.goto('/inbox');

    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    await expect(page.getByText('Em reconstrução · Fase 1 — Conectar e conversar')).toBeVisible();
    await expect(page).toHaveTitle('Inbox · Ienvia');
  });

  test('endereço que não existe mostra "Página não encontrada"', async ({ page }) => {
    await entrar(page, 'dona');
    const resposta = await page.goto('/aba-que-nao-existe');
    expect(resposta?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
  });

  test('"Clientes SaaS" é só do administrador da plataforma', async ({ page }) => {
    await entrar(page, 'dona');
    await expect(page.getByRole('link', { name: 'Clientes SaaS' })).toHaveCount(0);
    const resposta = await page.goto('/contas');
    expect(resposta?.status()).toBe(404);
  });

  test('o administrador da plataforma abre "Clientes SaaS"', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');
    await expect(page.getByRole('heading', { level: 1, name: 'Clientes SaaS' })).toBeVisible();
  });

  test('no computador, o menu lateral leva às abas e marca a aba atual', async ({ page, isMobile }) => {
    test.skip(isMobile, 'No celular o menu é uma gaveta (teste abaixo).');
    await entrar(page, 'dona');

    const menu = page.getByRole('navigation', { name: 'Seções do painel' });
    await expect(menu.getByRole('link', { name: 'Visão geral' })).toHaveAttribute('aria-current', 'page');

    await menu.getByRole('link', { name: 'Treinamento' }).click();
    await expect(page).toHaveURL(/\/treinamento$/);
    await expect(menu.getByRole('link', { name: 'Treinamento' })).toHaveAttribute('aria-current', 'page');
    await expect(menu.getByRole('link', { name: 'Visão geral' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('no celular, o menu abre como gaveta e fecha ao escolher uma aba', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de celular.');
    await entrar(page, 'dona');

    const gaveta = page.locator('#menu-principal');
    const barraInferior = page.getByRole('navigation', { name: 'Navegação principal no celular' });
    await expect(gaveta).not.toBeInViewport();
    await expect(barraInferior.getByRole('link', { name: 'Início' })).toHaveAttribute('aria-current', 'page');

    await barraInferior.getByRole('button', { name: /^Mais/ }).click();
    await expect(gaveta).toBeInViewport();

    await gaveta.getByRole('link', { name: 'Campanhas' }).click();
    await expect(page).toHaveURL(/\/campanhas$/);
    await expect(gaveta).not.toBeInViewport();
  });

  test('no celular, a tecla Esc fecha a gaveta', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de celular.');
    await entrar(page, 'dona');

    const gaveta = page.locator('#menu-principal');
    await page.getByRole('button', { name: 'Abrir menu de navegação' }).click();
    await expect(gaveta).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(gaveta).not.toBeInViewport();
    // O foco volta para o botão que abriu a gaveta.
    await expect(page.getByRole('button', { name: 'Abrir menu de navegação' })).toBeFocused();
  });
});

test.describe('Preferências', () => {
  test('o tema claro fica guardado mesmo depois de recarregar a página', async ({ page }) => {
    await entrar(page, 'dona');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light');

    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: /Modo claro/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await expect.poll(async () => (await page.context().cookies()).find((c) => c.name === 'ienvia_tema')?.value).toBe('claro');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
