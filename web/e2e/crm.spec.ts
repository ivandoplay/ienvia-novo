import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { CONVERSAS_DA_INBOX } from './apoio/dados.mjs';
import { entrar } from './apoio/sessao';

const SUPABASE = 'http://127.0.0.1:54399';
const EVOLUTION = 'http://127.0.0.1:54398';

async function abrirInbox(page: Page, caminho = '/inbox') {
  await entrar(page, 'inbox');
  await page.goto(caminho);
  await expect(page).toHaveTitle('Inbox · Ienvia');
}

const abaCrm = (page: Page, nome: string) =>
  page.getByRole('navigation', { name: 'Modos do CRM' }).getByRole('link', { name: nome });

test.beforeEach(async ({ request }) => {
  await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
  await request.post(`${EVOLUTION}/controle/reiniciar`);
});

test.describe('CRM da Inbox — Desktop', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'Fluxo completo em desktop (painel lateral fixo)');
  });

  test('navega pelas abas Contatos e Kanban, cria contato manual e muda etapa do negócio', async ({ page }) => {
    await abrirInbox(page);

    // 1. Vai para Contatos e cria um contato manual
    await abaCrm(page, 'Contatos').click();
    await expect(page).toHaveURL(/aba=contatos/);
    await expect(page.getByRole('region', { name: 'Agenda de contatos' })).toBeVisible();

    await page.getByRole('button', { name: 'Novo contato' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Nome completo *').fill('Mariana Costa');
    await dlg.getByLabel('WhatsApp / Telefone').fill('86999112233');
    await dlg.getByLabel('Empresa / Negócio').fill('Costa Imóveis');
    await dlg.getByLabel('Cidade / UF').fill('Teresina');
    await dlg.getByRole('button', { name: 'Salvar contato' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText('Mariana Costa')).toBeVisible();
    await expect(page.getByText(/Costa Imóveis/)).toBeVisible();

    // 2. Inicia conversa WhatsApp direta a partir da agenda
    const cartaoAgenda = page.locator('article.crm-contato-card', { hasText: 'Mariana Costa' });
    await cartaoAgenda.getByRole('button', { name: 'Iniciar WhatsApp' }).click();
    await expect(page).toHaveURL(/\/inbox\?.*c=/);
    await expect(page.getByRole('region', { name: 'Conversa com Mariana Costa' })).toBeVisible();

    // 3. No cartão CRM lateral: define valor R$ 1.500,00, move etapa para Proposta e cria nota interna
    const cartao = page.getByRole('complementary', { name: 'Dados do contato' });
    const campoValor = cartao.getByLabel('Valor (R$)');
    await campoValor.fill('1500,00');
    await campoValor.blur();
    await expect(cartao.getByText(/1\.500,00/)).toBeVisible();
    await cartao.getByLabel('Etapa do funil').selectOption('proposta');

    await cartao.getByPlaceholder('Escreva uma anotação interna...').fill('Cliente pediu orçamento atualizado até sexta.');
    await cartao.getByRole('button', { name: 'Salvar nota' }).click();
    await expect(cartao.getByText('Cliente pediu orçamento atualizado até sexta.')).toBeVisible();

    // 4. Vai para o Kanban e confirma o card na coluna Proposta com valor
    await abaCrm(page, 'Kanban').click();
    await expect(page).toHaveURL(/aba=kanban/);
    const colunaProposta = page.locator('[data-crm-stage="proposta"]');
    await expect(colunaProposta).toContainText('Mariana Costa');
    await expect(colunaProposta).toContainText('1.500,00');
  });

  test('cria etiqueta, associa ao contato, filtra por etiqueta e cria resposta rápida com "/"', async ({ page }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);

    // 1. Abre gerenciador de Etiquetas & Respostas e cria tag VIP
    await page.getByRole('button', { name: 'Etiquetas & /' }).click();
    const dlgCat = page.getByRole('dialog');
    await dlgCat.getByPlaceholder(/Nome da nova etiqueta/i).fill('VIP');
    await dlgCat.getByRole('button', { name: 'Criar etiqueta' }).click();
    await expect(dlgCat.getByText('VIP')).toBeVisible();

    // 2. Cria resposta rápida /pix no mesmo modal e fecha
    await dlgCat.getByRole('tab', { name: /Respostas rápidas/i }).click();
    await dlgCat.getByLabel('Atalho (digite / no chat)').fill('pix');
    await dlgCat.getByLabel('Título curto').fill('Chave Pix');
    await dlgCat.getByLabel('Texto da mensagem').fill('Nossa chave Pix é 12.345.678/0001-99.');
    await dlgCat.getByRole('button', { name: 'Salvar resposta rápida' }).click();
    await expect(dlgCat.getByText('/pix')).toBeVisible();
    await dlgCat.getByRole('button', { name: 'Fechar' }).click();

    // 3. Anexa VIP na Ana pelo cartão CRM
    const cartao = page.getByRole('complementary', { name: 'Dados do contato' });
    await cartao.getByRole('button', { name: 'VIP' }).click();
    await expect(page.locator('.inbox-item[aria-current="true"]')).toContainText('VIP');

    // 4. Filtra lista por etiqueta VIP
    await page.getByLabel('Filtrar por etiqueta').selectOption({ label: 'VIP' });
    await expect(page.locator('.inbox-item')).toHaveCount(1);
    await expect(page.locator('.inbox-item')).toContainText('Ana');
    await page.getByLabel('Filtrar por etiqueta').selectOption('');

    // 5. Usa atalho /pix no campo de mensagem
    const campo = page.getByLabel('Mensagem', { exact: true });
    await campo.fill('/pix');
    await page.getByRole('option', { name: /\/pix/i }).click();
    await expect(campo).toHaveValue('Nossa chave Pix é 12.345.678/0001-99.');
  });

  test('agenda mensagem e cancela, alterna Ignorar IA, usa seleção em massa, Ctrl+K e exclusão', async ({ page }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);

    // 1. Agenda uma mensagem para daqui a 1 hora e cancela
    const campo = page.getByLabel('Mensagem', { exact: true });
    await campo.fill('Bom dia, passando para confirmar seu horário!');
    await page.getByRole('button', { name: 'Agendar envio' }).click();
    await page.getByRole('button', { name: 'Confirmar agendamento' }).click();
    const faixaAgenda = page.getByLabel('Mensagens agendadas');
    await expect(faixaAgenda).toContainText('Bom dia, passando para confirmar seu horário!');
    await faixaAgenda.getByRole('button', { name: 'Cancelar' }).click();
    await expect(faixaAgenda).toBeHidden();

    // 2. Ignorar IA no cartão lateral
    const cartao = page.getByRole('complementary', { name: 'Dados do contato' });
    await cartao.getByRole('button', { name: 'Ignorar IA' }).click();
    await expect(cartao.getByRole('button', { name: 'IA ignorada' })).toBeVisible();

    // 3. Seleção em massa: seleciona Ana e arquiva; abre filtro Arquivadas
    await page.getByRole('button', { name: 'Selecionar' }).click();
    await page.getByLabel('Selecionar Ana').check();
    await page.getByRole('region', { name: 'Ações em lote' }).getByRole('button', { name: 'Arquivar' }).click();
    await page.getByRole('navigation', { name: 'Filtros das conversas' }).getByRole('link', { name: /^Arquivadas/ }).click();
    await expect(page.locator('.inbox-item-nome')).toContainText(['Ana']);

    // 4. Busca global via Ctrl+K encontra Bruno e abre conversa
    await page.keyboard.press('Control+k');
    const buscaModal = page.getByRole('dialog');
    await buscaModal.getByPlaceholder(/Nome, WhatsApp/i).fill('Bruno');
    await buscaModal.getByRole('button', { name: /Bruno/i }).first().click();
    await expect(page.getByRole('region', { name: 'Conversa com Bruno' })).toBeVisible();

    // 5. Apagar contato e conversa (exclusão real com confirmação)
    await cartao.getByRole('button', { name: 'Apagar contato e conversa' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sim, apagar definitivamente' }).click();
    await expect(page).not.toHaveURL(new RegExp(CONVERSAS_DA_INBOX.bruno));
  });

  test('acessibilidade WCAG sem violações nas abas Conversas, Contatos e Kanban', async ({ page }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    for (const aba of ['Conversas', 'Contatos', 'Kanban']) {
      await abaCrm(page, aba).click();
      await page.waitForLoadState('networkidle');
      const relatorio = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const graves = relatorio.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      expect(graves, `Violações graves na aba ${aba}`).toEqual([]);
    }
  });
});

test.describe('CRM da Inbox — Mobile sem overflow horizontal ou vertical indevido', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('mobile mantém lista e conversa aberta dentro da viewport (scrollHeight - clientHeight <= 1)', async ({ page }) => {
    await abrirInbox(page);
    await expect(abaCrm(page, 'Contatos')).toBeVisible();

    // Entra numa conversa: .inbox-crm-topo é ocultada para preservar a altura exata da conversa no mobile
    await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await expect(page.getByRole('region', { name: 'Conversa com Ana' })).toBeVisible();

    const metricas = await page.evaluate(() => {
      const raiz = document.documentElement;
      return {
        transbordoVertical: raiz.scrollHeight - raiz.clientHeight,
        transbordoHorizontal: raiz.scrollWidth - raiz.clientWidth,
      };
    });
    expect(metricas.transbordoVertical).toBeLessThanOrEqual(1);
    expect(metricas.transbordoHorizontal).toBeLessThanOrEqual(1);

    // Abre o modal CRM do contato no mobile
    await page.getByRole('button', { name: 'Contato' }).click();
    await expect(page.getByRole('dialog', { name: 'Dados do contato' })).toBeVisible();
  });
});
