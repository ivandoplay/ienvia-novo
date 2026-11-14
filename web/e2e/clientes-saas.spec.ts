/**
 * Clientes SaaS com controle de verdade: cobrança, uso, suspender com aviso, senha nova e zerar.
 * Roda no banco falso da fase 7 e também fotografa as telas para a auditoria visual.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

import { CHIP_ANTIGO, CHIP_SUPORTE, CHIP_VENDAS, CONVERSAS_DA_INBOX } from './apoio/dados.mjs';
import { abrirMenuDaConta, entrar, preencherLogin } from './apoio/sessao';

const REINICIAR_FASE7 = 'http://127.0.0.1:54399/controle/reiniciar-fase7';
// "Zerar dados" apaga contatos e conversas de verdade — o Inbox precisa ser restaurado depois,
// senão os outros specs rodam sem dados.
const REINICIAR_INBOX = 'http://127.0.0.1:54399/controle/reiniciar-inbox';
// "Suspender" desliga o chip da Loja da Maria e mexe no estado da IA — os outros specs contam com
// esse estado original (ex.: "IA respondendo em 1 chip" na Visão geral).
const REINICIAR_IA = 'http://127.0.0.1:54399/controle/reiniciar-ia';
// Cada teste do arquivo mexe num cliente que os OUTROS specs usam. No banco falso o estado da IA e dos
// chips é único para todos: por isso os testes daqui rodam um de cada vez (serial).
const PASTA = 'auditoria-visual/clientes-saas';
// Cliente que já existe no banco de teste, com dono e movimento.
const CLIENTE = 'Loja da Maria';
const cartaoDoCliente = (page: import('@playwright/test').Page) => page.locator('.conta-card', { hasText: CLIENTE }).first();

test.describe('Clientes SaaS — mesa de administração', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(REINICIAR_FASE7);
    await request.post(REINICIAR_INBOX);
    await request.post(REINICIAR_IA);
    await restaurarCenarioDaIa(request);
  });

  test.afterAll(async ({ request }) => {
    await request.post(REINICIAR_FASE7);
    await request.post(REINICIAR_INBOX);
    await request.post(REINICIAR_IA);
    // A Visão geral da dona mostra "IA respondendo em 1 chip": o chip que este spec desligou volta ligado.
    await request.post(`http://127.0.0.1:54399/controle/ia-do-chip?chip=${CHIP_VENDAS}&ligada=sim`);
  });

  /** Cria um cliente só para o teste (os testes não podem mexer nos clientes que os outros specs usam). */
  async function criarCliente(page: import('@playwright/test').Page, nome: string, login: string, senha = 'ClinicaSenha2026!') {
    await page.getByRole('button', { name: '+ Novo cliente' }).click();
    await page.getByLabel('Nome da empresa').fill(nome);
    await page.getByLabel('Login ou e-mail do dono').fill(login);
    await page.getByLabel('Nome do responsável').fill('Dra. Teste');
    await page.getByLabel('Senha inicial').fill(senha);
    await page.getByLabel('Limite de chips').fill('1');
    await page.getByRole('button', { name: 'Criar cliente SaaS' }).click();
    await expect(page.getByText(`Cliente "${nome}" criado com sucesso.`)).toBeVisible();
  }

  // Cenário da IA como os outros specs esperam: só o chip de vendas com IA ligada.
  async function restaurarCenarioDaIa(request: import('@playwright/test').APIRequestContext) {
    for (const chip of [CHIP_VENDAS, CHIP_SUPORTE, CHIP_ANTIGO]) {
      const ligada = chip === CHIP_VENDAS ? 'sim' : 'nao';
      await request.post(`http://127.0.0.1:54399/controle/ia-do-chip?chip=${chip}&ligada=${ligada}`);
    }
    for (const conversa of Object.values(CONVERSAS_DA_INBOX)) {
      await request.post(`http://127.0.0.1:54399/controle/ia-na-conversa?conversa=${conversa}&estado=limpa`);
    }
  }

  test('cobrança: define vencimento, valor e carência, marca mês pago e vê a situação mudar', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');

    const cartao = cartaoDoCliente(page);
    await expect(cartao).toContainText('Sem cobrança combinada');

    // 1. Combina a cobrança: vence dia 10, R$ 149,00, carência de 3 dias, aviso escrito.
    await cartao.getByRole('button', { name: 'Cobrança' }).click();
    const formulario = cartao.locator('.conta-editor');
    await formulario.getByLabel('Dia do vencimento').fill('10');
    await formulario.getByLabel('Valor por mês (R$)').fill('149,00');
    await formulario.getByLabel('Carência depois do vencimento (dias)').fill('3');
    await formulario.getByLabel('Aviso enviado ao cliente quando você suspender').fill('Oi! Seu acesso está suspenso até o pagamento.');
    await formulario.getByRole('button', { name: 'Salvar cobrança' }).click();

    await expect(page.getByText('Cobrança salva. O painel já mostra a nova situação.')).toBeVisible();
    // Nunca foi pago: o painel já avisa que está vencida.
    await expect(cartao).toContainText('Vencida');
    await expect(cartao).toContainText('R$\u00a0149,00 por mês');
    await expect(cartao).toContainText('vence dia 10');
    await expect(cartao).toContainText('Carência de 3 dia(s)');

    // 2. Marca o mês como pago: o prazo pula para o mês seguinte e a etiqueta fica verde.
    await cartao.getByRole('button', { name: 'Marcar mês como pago' }).click();
    await expect(page.getByText(/Pagamento registrado\. Cliente em dia até/)).toBeVisible();
    await expect(cartao.getByText('Em dia', { exact: false })).toBeVisible();
    await expect(cartao).toContainText('faltam');

    // 3. Os números de uso do mês aparecem no cartão.
    await expect(cartao).toContainText('mensagens no mês');
    await expect(cartao).toContainText('respostas da IA');
  });

  test('suspender com aviso: acesso cai, chips desligam, o aviso entra na fila e a reativação cancela', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');

    // Cliente só deste teste: suspender desliga os chips, e os outros specs contam com os chips originais.
    await criarCliente(page, 'Clínica Suspensa', 'clinica_suspensa');
    const cartao = page.locator('.conta-card', { hasText: 'Clínica Suspensa' }).first();
    await cartao.getByRole('button', { name: 'Suspender' }).click();

    const janela = page.getByRole('dialog');
    await expect(janela).toContainText('Suspender Clínica Suspensa?');
    await janela.getByLabel('Motivo da suspensão (fica no histórico)').fill('Mensalidade em atraso');
    await janela
      .getByLabel('Aviso no WhatsApp do cliente')
      .fill('Oi! Seu acesso ao painel está suspenso por falta de pagamento. Assim que regularizar, a gente libera na hora.');
    await janela.getByRole('button', { name: 'Suspender agora' }).click();

    await expect(page.getByText(/Cliente suspenso: o acesso parou/)).toBeVisible();
    await expect(page.getByText(/aviso ficou na fila|Nenhum aviso foi enfileirado/)).toBeVisible();
    await expect(cartao).toContainText('Desativada');
    await expect(cartao).toContainText('aviso(s) de suspensão na fila');

    // Reativar devolve o acesso e cancela o aviso que ainda não saiu.
    await cartao.getByRole('button', { name: 'Reativar acesso' }).click();
    await expect(page.getByText('Cliente reativado.')).toBeVisible();
    await expect(cartao).toContainText('Ativa');
    await expect(cartao).not.toContainText('aviso(s) de suspensão na fila');
  });

  test('senha nova: gera, mostra uma vez e o login antigo deixa de valer', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');

    // Cliente só deste teste: aqui a senha do dono muda de verdade.
    await criarCliente(page, 'Clínica da Senha', 'clinica_senha', 'SenhaAntiga2026!');
    const cartao = page.locator('.conta-card', { hasText: 'Clínica da Senha' }).first();
    await cartao.getByRole('button', { name: 'Senha nova' }).click();

    const janela = page.getByRole('dialog');
    await expect(janela).toContainText('Copie agora e envie para o responsável');
    const senha = (await janela.locator('code').innerText()).trim();
    expect(senha.length).toBeGreaterThanOrEqual(10);
    expect(senha).not.toMatch(/[0Ol1]/); // letras que se confundem ao ditar por telefone

    await janela.getByRole('button', { name: 'Já enviei, fechar' }).click();
    await expect(janela).toBeHidden();

    // O master sai; a senha antiga da dona não abre mais; a nova, sim.
    await abrirMenuDaConta(page).then((folha) => folha.getByRole('button', { name: 'Sair desta conta' }).click());
    await expect(page).toHaveURL(/\/login$/);
    await preencherLogin(page, 'clinica_senha', 'SenhaAntiga2026!');
    await expect(page.getByText(/incorret/i)).toBeVisible();
    await preencherLogin(page, 'clinica_senha', senha);
    await expect(page).toHaveURL(/\/visao-geral$/);
  });

  test('zerar dados: só com o nome digitado, e apaga mensagens, conversas e contatos', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');

    // Cria um cliente só para este teste: zerar apaga dados de verdade.
    await criarCliente(page, 'Clínica do Teste', 'clinica_teste');

    const cartao = page.locator('.conta-card', { hasText: 'Clínica do Teste' }).first();
    await cartao.getByRole('button', { name: 'Zerar dados' }).click();

    const janela = page.getByRole('dialog');
    await expect(janela).toContainText('Não dá para desfazer');

    // Nome errado: o botão fica desligado e nada acontece.
    await janela.getByLabel(/Digite/).fill('outro nome');
    await expect(janela.getByRole('button', { name: 'Zerar os dados' })).toBeDisabled();

    await janela.getByLabel(/Digite/).fill('Clínica do Teste');
    await janela.getByRole('button', { name: 'Zerar os dados' }).click();

    await expect(page.getByText(/Conta zerada: \d+ mensagens/)).toBeVisible();
    await expect(cartao).toContainText('0 contatos · 0 conversas');
    // O histórico guarda quem zerou e o que apagou.
    await expect(page.getByText('Zerou os dados do cliente — Clínica do Teste')).toBeVisible();
  });

  test('print das telas novas no celular e no computador', async ({ page }, info) => {
    mkdirSync(PASTA, { recursive: true });
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');

    const cartao = cartaoDoCliente(page);
    await cartao.getByRole('button', { name: 'Cobrança' }).click();
    const formulario = cartao.locator('.conta-editor');
    await formulario.getByLabel('Dia do vencimento').fill('10');
    await formulario.getByLabel('Valor por mês (R$)').fill('149,00');
    await formulario.getByLabel('WhatsApp do responsável (recebe o aviso)').fill('+55 (85) 99999-9999');
    await formulario.getByRole('button', { name: 'Salvar cobrança' }).click();
    await expect(cartao).toContainText('Vencida');
    await cartao.getByRole('button', { name: 'Marcar mês como pago' }).click();
    await expect(cartao.getByText('Em dia', { exact: false })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${PASTA}/${info.project.name}-01-cartao-com-cobranca.png`, fullPage: true });

    await cartao.getByRole('button', { name: 'Suspender' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${PASTA}/${info.project.name}-02-janela-suspender.png` });
  });
});
