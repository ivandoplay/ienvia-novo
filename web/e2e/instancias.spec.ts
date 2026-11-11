import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { LIMITE_DE_CHIPS, WORKSPACE_CHIPS } from './apoio/dados.mjs';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * Tela de Instâncias, do começo ao fim, contra o Supabase e a Evolution de mentira.
 * "Ler o QR Code" é simulado pedindo à Evolution de mentira que marque o chip como conectado.
 */
const SUPABASE = 'http://127.0.0.1:54399';
const EVOLUTION = 'http://127.0.0.1:54398';
/** Todo chip da empresa de teste nasce na Evolution com este começo de nome. */
const PREFIXO = `ienvia-${WORKSPACE_CHIPS.replace(/-/g, '').slice(0, 8)}`;

async function comecarDoZero(request: APIRequestContext) {
  await request.post(`${SUPABASE}/controle/reiniciar-chips?workspace=${WORKSPACE_CHIPS}`);
  await request.post(`${EVOLUTION}/controle/reiniciar?prefixo=${PREFIXO}`);
}

const lerOQrCodeNoCelular = (request: APIRequestContext) =>
  request.post(`${EVOLUTION}/controle/conectar?prefixo=${PREFIXO}&telefone=5585999990000`);

const simularFalha = (request: APIRequestContext, tipo: 'nenhuma' | 'recusa' | 'pane') =>
  request.post(`${EVOLUTION}/controle/falha?tipo=${tipo}`);

async function chipsNaEvolution(request: APIRequestContext) {
  const resposta = await request.get(`${EVOLUTION}/controle/instancias?prefixo=${PREFIXO}`);
  return (await resposta.json()) as Array<{ nome: string; estado: string; aviso: { url: string } | null }>;
}

async function abrirInstancias(page: Page, usuario = 'chips') {
  await entrar(page, usuario);
  await page.goto('/instancias');
  await expect(page.getByRole('heading', { name: 'Instâncias', level: 1 })).toBeVisible();
}

const FUNCOES = {
  atendimento: /^Atendimento Conversa/,
  campanhas: /^Campanhas/,
  ambos: /^Atendimento e campanhas/,
};

async function adicionarChip(page: Page, apelido: string, funcao: keyof typeof FUNCOES = 'atendimento') {
  await page.getByRole('button', { name: 'Adicionar chip' }).click();
  const janela = page.getByRole('dialog', { name: 'Adicionar chip' });
  await janela.getByLabel('Apelido do chip').fill(apelido);
  await janela.getByRole('radio', { name: FUNCOES[funcao] }).check();
  await janela.getByRole('button', { name: 'Criar e conectar' }).click();
  return janela;
}

const cartao = (page: Page, apelido: string) => page.getByRole('article', { name: apelido });

test.describe('Instâncias', () => {
  test.beforeEach(async ({ request }) => {
    await comecarDoZero(request);
  });

  test('a dona adiciona um chip, vê o QR Code e o chip conecta quando o celular lê', async ({ page, request }) => {
    await abrirInstancias(page);
    await expect(page.getByText('Nenhum chip por aqui ainda')).toBeVisible();
    await expect(page.getByText(`0 de ${LIMITE_DE_CHIPS} chips em uso`)).toBeVisible();

    await expect(await adicionarChip(page, 'Comercial', 'ambos')).toBeHidden();

    const chip = cartao(page, 'Comercial');
    await expect(chip.getByRole('img', { name: 'QR Code para conectar o chip Comercial' })).toBeVisible();
    await expect(chip.getByText('Aguardando a conexão…')).toBeVisible();
    await expect(chip.getByText('Atendimento e campanhas')).toBeVisible();
    await expect(chip.getByText('Número ainda não conectado')).toBeVisible();
    await expect(chip.getByText('Atendente de IA: desligado neste chip.')).toBeVisible();

    // A Evolution ficou sabendo para onde avisar quando chegar mensagem.
    const [naEvolution] = await chipsNaEvolution(request);
    expect(naEvolution?.aviso?.url).toBe('https://painel.teste.invalid/api/webhooks/evolution');

    await lerOQrCodeNoCelular(request);

    await expect(chip.getByText('Chip conectado!')).toBeVisible({ timeout: 15_000 });
    await expect(chip.getByText('Conectado', { exact: true })).toBeVisible();
    await expect(chip.getByText('+55 (85) 99999-0000')).toBeVisible();
    await expect(chip.getByRole('img')).toHaveCount(0);
    await expect(page.getByText(`1 de ${LIMITE_DE_CHIPS} chips em uso`)).toBeVisible();
  });

  test('conecta sem câmera, pelo código de 8 dígitos', async ({ page }) => {
    await abrirInstancias(page);
    await expect(await adicionarChip(page, 'Suporte')).toBeHidden();
    const chip = cartao(page, 'Suporte');
    await chip.getByRole('button', { name: 'Fechar' }).click();

    const numero = chip.getByLabel('Conectar sem câmera (código de 8 dígitos)');
    await numero.fill('123');
    await chip.getByRole('button', { name: 'Gerar código' }).click();
    await expect(chip.getByRole('alert')).toContainText('Informe o número do chip com DDD');

    await numero.fill('(85) 99999-0000');
    await chip.getByRole('button', { name: 'Gerar código' }).click();
    await expect(chip.getByText('ABCD-1234')).toBeVisible();
    await expect(chip.getByText('Conectar com número de telefone')).toBeVisible();
  });

  test('muda o apelido e a função de um chip', async ({ page }) => {
    await abrirInstancias(page);
    await expect(await adicionarChip(page, 'Comercial')).toBeHidden();
    await cartao(page, 'Comercial').getByRole('button', { name: 'Fechar' }).click();

    await cartao(page, 'Comercial').getByRole('button', { name: 'Editar' }).click();
    const janela = page.getByRole('dialog', { name: 'Editar chip' });
    await expect(janela.getByLabel('Apelido do chip')).toHaveValue('Comercial');
    await janela.getByLabel('Apelido do chip').fill('Vendas');
    await janela.getByRole('radio', { name: FUNCOES.campanhas }).check();
    await janela.getByRole('button', { name: 'Salvar' }).click();

    await expect(janela).toBeHidden();
    await expect(cartao(page, 'Vendas').getByText('Campanhas', { exact: true })).toBeVisible();
    await expect(cartao(page, 'Comercial')).toHaveCount(0);
  });

  test('desconecta e depois remove o chip (na tela e na Evolution)', async ({ page, request }) => {
    await abrirInstancias(page);
    await expect(await adicionarChip(page, 'Comercial')).toBeHidden();
    const chip = cartao(page, 'Comercial');
    await lerOQrCodeNoCelular(request);
    await expect(chip.getByText('Conectado', { exact: true })).toBeVisible({ timeout: 15_000 });

    await chip.getByRole('button', { name: 'Desconectar' }).click();
    await expect(chip.getByText('Chip desconectado.')).toBeVisible();
    await expect(chip.getByText('Desconectado', { exact: true })).toBeVisible();
    expect((await chipsNaEvolution(request))[0]?.estado).toBe('close');

    await chip.getByRole('button', { name: 'Remover' }).click();
    const janela = page.getByRole('dialog', { name: 'Remover chip' });
    await expect(janela).toContainText('As conversas e mensagens dele continuam guardadas');
    await janela.getByRole('button', { name: 'Remover chip' }).click();

    await expect(chip).toHaveCount(0);
    await expect(page.getByText('Nenhum chip por aqui ainda')).toBeVisible();
    expect(await chipsNaEvolution(request)).toEqual([]);
  });

  test('não deixa passar do limite de chips da conta', async ({ page }) => {
    await abrirInstancias(page);
    for (const apelido of ['Chip um', 'Chip dois']) {
      await expect(await adicionarChip(page, apelido)).toBeHidden();
      await cartao(page, apelido).getByRole('button', { name: 'Fechar' }).click();
    }
    await expect(page.getByText(`${LIMITE_DE_CHIPS} de ${LIMITE_DE_CHIPS} chips em uso`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Adicionar chip' })).toBeDisabled();
    await expect(page.getByText('Sua conta já usa todos os chips do plano')).toBeVisible();
  });

  test('se a Evolution recusa, nada fica pela metade; se ela não responde, dá para terminar depois', async ({ page, request }) => {
    await abrirInstancias(page);

    await simularFalha(request, 'recusa');
    const janela = await adicionarChip(page, 'Comercial');
    await expect(janela.getByRole('alert')).toContainText('A Evolution recusou o pedido');
    await expect(janela.getByLabel('Apelido do chip')).toHaveValue('Comercial');
    await janela.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText('Nenhum chip por aqui ainda')).toBeVisible();

    await simularFalha(request, 'pane');
    await expect(await adicionarChip(page, 'Comercial')).toBeHidden();
    const chip = cartao(page, 'Comercial');
    await expect(chip.getByText('Chip cadastrado. Toque em "Gerar QR Code" para conectar.')).toBeVisible();
    expect(await chipsNaEvolution(request)).toEqual([]);

    await simularFalha(request, 'nenhuma');
    await chip.getByRole('button', { name: 'Gerar QR Code' }).click();
    await expect(chip.getByRole('img', { name: 'QR Code para conectar o chip Comercial' })).toBeVisible();
    expect(await chipsNaEvolution(request)).toHaveLength(1);
  });

  test('a janela fecha com Esc e devolve o foco para o botão que a abriu', async ({ page }) => {
    await abrirInstancias(page);
    const botao = page.getByRole('button', { name: 'Adicionar chip' });
    await botao.click();
    const janela = page.getByRole('dialog', { name: 'Adicionar chip' });
    await expect(janela).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(janela).toBeHidden();
    await expect(botao).toBeFocused();
  });

  test('quem não é dono da conta só olha', async ({ page }) => {
    await abrirInstancias(page, 'atendente');
    await expect(page.getByText('Só o dono da conta pode adicionar, conectar ou remover chips.')).toBeVisible();
    await expect(cartao(page, 'Comercial').getByText('Motor local')).toBeVisible();
    await expect(cartao(page, 'Comercial').getByText('+55 (85) 99999-0001')).toBeVisible();
    await expect(cartao(page, 'Promoções').getByText('Desconectado', { exact: true })).toBeVisible();
    for (const nome of ['Adicionar chip', 'Editar', 'Remover', 'Gerar QR Code', 'Desconectar']) {
      await expect(page.getByRole('button', { name: nome })).toHaveCount(0);
    }
  });

  test('acessibilidade: lista com QR Code na tela e janela aberta, nos dois temas', async ({ page }) => {
    const problemasGraves = async () => {
      // Depois de uma ação, o Next troca o conteúdo da página (inclusive o título) em duas etapas;
      // só mede quando a página assentou. Se o título nunca voltar, o teste falha aqui.
      await expect(page).toHaveTitle(/Instâncias/);
      const resultado = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      return resultado.violations
        .filter((violacao) => violacao.impact === 'serious' || violacao.impact === 'critical')
        .map((violacao) => `${violacao.id}: ${violacao.help} → ${violacao.nodes[0]?.target.join(' ')}`);
    };

    // Sem animações, a troca de tema não deixa cores "no meio do caminho" na hora da medição.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await abrirInstancias(page);
    await expect(await adicionarChip(page, 'Comercial')).toBeHidden();
    await expect(cartao(page, 'Comercial').getByRole('img')).toBeVisible();
    expect(await problemasGraves()).toEqual([]);

    await cartao(page, 'Comercial').getByRole('button', { name: 'Fechar' }).click();
    expect(await problemasGraves()).toEqual([]);

    await page.getByRole('button', { name: 'Adicionar chip' }).click();
    await expect(page.getByRole('dialog', { name: 'Adicionar chip' })).toBeVisible();
    expect(await problemasGraves()).toEqual([]);
    await page.keyboard.press('Escape');

    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: /Modo claro/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await problemasGraves()).toEqual([]);
  });
});
