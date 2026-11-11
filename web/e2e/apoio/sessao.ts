import { expect, type Page } from '@playwright/test';
import { SENHA_DE_TESTE } from './dados.mjs';

/** Faz login pela tela, como uma pessoa faria, e espera o painel abrir. */
export async function entrar(page: Page, usuario: string, senha: string = SENHA_DE_TESTE): Promise<void> {
  await page.goto('/login');
  await preencherLogin(page, usuario, senha);
  await expect(page).toHaveURL(/\/visao-geral$/);
}

export async function preencherLogin(page: Page, usuario: string, senha: string = SENHA_DE_TESTE): Promise<void> {
  await page.getByLabel('Usuário ou e-mail').fill(usuario);
  await page.getByLabel('Senha', { exact: true }).fill(senha);
  await page.getByRole('button', { name: 'Acessar Meu Painel' }).click();
}

/** Abre a folha "Conta e preferências" (o botão com as iniciais, no topo). */
export async function abrirMenuDaConta(page: Page) {
  await page.getByRole('button', { name: /^Conta e preferências/ }).click();
  const folha = page.getByRole('dialog', { name: 'Conta e preferências' });
  await expect(folha).toBeVisible();
  return folha;
}
