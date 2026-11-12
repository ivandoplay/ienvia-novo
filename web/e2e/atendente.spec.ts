import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { CHIP_VENDAS, CONVERSAS_DA_INBOX } from './apoio/dados.mjs';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * O atendente de IA nas telas: ligar a IA num chip, o botão de emergência "Pausar tudo" e a faixa da IA
 * em cada conversa da Inbox (o que ela está fazendo ali, o recado que deixou, assumir e devolver).
 *
 * Aqui o banco é o de mentira: quem responde de verdade no WhatsApp (pedir a resposta ao provedor e enviar)
 * é testado em web/test-com-banco/atendente.test.ts, contra o banco de verdade em memória.
 *
 * Cenário: a "Empresa da Inbox" (logins `inbox`, a dona, e `colega`, da equipe), que já tem a chave do
 * Gemini e duas bases de treinamento; e a empresa dos chips (login `chips`), que não tem chave nenhuma.
 */
const SUPABASE = 'http://127.0.0.1:54399';
const EVOLUTION = 'http://127.0.0.1:54398';

type EstadoDaIa = 'respondendo' | 'escrevendo' | 'repassada' | 'sem_leitura' | 'falhou' | 'parada_por_pessoa' | 'limpa';

const ligarIaNoChipVendas = (request: APIRequestContext, ligada = true) =>
  request.post(`${SUPABASE}/controle/ia-do-chip?chip=${CHIP_VENDAS}&ligada=${ligada ? 'sim' : 'nao'}`);
const deixarIaNaConversa = (request: APIRequestContext, conversa: string, estado: EstadoDaIa) =>
  request.post(`${SUPABASE}/controle/ia-na-conversa?conversa=${conversa}&estado=${estado}`);

test.beforeEach(async ({ request }) => {
  await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
  await request.post(`${SUPABASE}/controle/reiniciar-ia`);
  await request.delete(`${EVOLUTION}/controle/enviadas`);
});

const cartaoDoChip = (page: Page, apelido: string) => page.getByRole('article', { name: apelido });
const interruptorDaIa = (page: Page, apelido: string) => cartaoDoChip(page, apelido).getByRole('switch', { name: 'Atendente de IA neste chip' });
const controleDaIa = (page: Page) => page.getByRole('group', { name: 'Atendente de IA' });
const faixaDaIa = (page: Page) => page.getByRole('group', { name: 'A IA nesta conversa' });
const cartaoDaVisaoGeral = (page: Page) => page.getByRole('link', { name: /IA respondendo/ });

async function abrirInstancias(page: Page, usuario = 'inbox') {
  await entrar(page, usuario);
  await page.goto('/instancias');
  await expect(page.getByRole('heading', { name: 'Instâncias', level: 1 })).toBeVisible();
}

async function abrirConversa(page: Page, conversa: string, usuario = 'inbox') {
  await entrar(page, usuario);
  await page.goto(`/inbox?c=${conversa}`);
  await expect(page).toHaveTitle('Inbox · Ienvia');
}

test.describe('ligar a IA num chip', () => {
  test('o dono liga e desliga pelo cartão do chip, e o resto do painel acompanha', async ({ page }) => {
    await abrirInstancias(page);
    const vendas = cartaoDoChip(page, 'Vendas');
    await expect(interruptorDaIa(page, 'Vendas')).not.toBeChecked();
    await expect(vendas.getByText('Desligado: as mensagens deste chip chegam na Inbox, e só a equipe responde.')).toBeVisible();
    // Sem chip nenhum com a IA ligada, não há o que pausar.
    await expect(controleDaIa(page)).toHaveCount(0);

    await interruptorDaIa(page, 'Vendas').check();
    await expect(vendas.getByRole('status')).toHaveText('IA ligada neste chip.');
    await expect(interruptorDaIa(page, 'Vendas')).toBeChecked();
    await expect(vendas.getByText('A IA responde as mensagens que chegam neste chip e passa a conversa para você quando precisa.')).toBeVisible();
    await expect(controleDaIa(page).getByRole('button', { name: 'Pausar tudo' })).toBeVisible();

    // O chip "Suporte" está desconectado: dá para deixar a IA ligada, e ela começa quando ele conectar.
    await interruptorDaIa(page, 'Suporte').check();
    await expect(cartaoDoChip(page, 'Suporte').getByText('Ligado. A IA começa a responder quando o chip estiver conectado.')).toBeVisible();

    await page.goto('/visao-geral');
    await expect(cartaoDaVisaoGeral(page)).toHaveText(/^Ligada\s*IA respondendo\s*em 1 de 2 chips$/);

    await page.goto('/instancias');
    await interruptorDaIa(page, 'Vendas').uncheck();
    await expect(cartaoDoChip(page, 'Vendas').getByRole('status')).toHaveText('IA desligada neste chip.');
    await expect(interruptorDaIa(page, 'Vendas')).not.toBeChecked();
  });

  test('sem a chave do provedor, a IA não liga, e a tela diz o que falta e onde resolver', async ({ page, request }) => {
    // A empresa dos chips não tem chave de IA cadastrada.
    await request.post(`${SUPABASE}/controle/reiniciar-chips?workspace=a0000000-0000-4000-8000-000000000003`);
    await entrar(page, 'chips');
    await page.goto('/instancias');
    await page.getByRole('button', { name: 'Adicionar chip' }).click();
    const janela = page.getByRole('dialog', { name: 'Adicionar chip' });
    await janela.getByLabel('Apelido do chip').fill('Balcão');
    await janela.getByRole('button', { name: 'Criar e conectar' }).click();
    const balcao = cartaoDoChip(page, 'Balcão');
    await expect(balcao.getByText('Desligado. Para ligar, cadastre antes a chave do provedor principal no Motor de IA.')).toBeVisible();
    await expect(balcao.getByRole('link', { name: 'Abrir o Motor de IA' })).toHaveAttribute('href', '/inteligencia-artificial');

    await interruptorDaIa(page, 'Balcão').check();
    await expect(balcao.getByRole('alert')).toHaveText('Antes de ligar a IA, cadastre a chave do provedor principal na aba Motor de IA.');
    await expect(interruptorDaIa(page, 'Balcão')).not.toBeChecked();
    await request.post(`${EVOLUTION}/controle/reiniciar?prefixo=ienvia-a0000000`);
  });

  test('quem não é dono vê como está, sem o botão', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await abrirInstancias(page, 'colega');
    await expect(cartaoDoChip(page, 'Vendas').getByText('Atendente de IA: ligado neste chip. Só o dono da conta liga e desliga.')).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
  });
});

test.describe('Pausar tudo', () => {
  test('o dono pausa a IA em todos os chips e retoma depois', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await abrirInstancias(page);

    await controleDaIa(page).getByRole('button', { name: 'Pausar tudo' }).click();
    const janela = page.getByRole('dialog', { name: 'Pausar a IA em todos os chips?' });
    await expect(janela).toContainText('A IA para de responder agora, em todos os chips. As mensagens continuam chegando na Inbox, para a equipe responder.');
    await expect(janela).toContainText('Você retoma quando quiser, por este mesmo lugar.');
    // Cancelar não muda nada.
    await janela.getByRole('button', { name: 'Cancelar' }).click();
    await expect(janela).toBeHidden();
    await expect(controleDaIa(page).getByRole('button', { name: 'Pausar tudo' })).toBeVisible();

    await controleDaIa(page).getByRole('button', { name: 'Pausar tudo' }).click();
    await page.getByRole('dialog', { name: 'Pausar a IA em todos os chips?' }).getByRole('button', { name: 'Pausar tudo' }).click();
    await expect(controleDaIa(page)).toContainText('IA pausada');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // O chip continua com a IA ligada; só não responde enquanto a pausa durar.
    await expect(interruptorDaIa(page, 'Vendas')).toBeChecked();
    await expect(cartaoDoChip(page, 'Vendas').getByText('Ligado, mas a IA está pausada em todos os chips.')).toBeVisible();

    // O aviso aparece em todas as abas.
    await page.goto('/visao-geral');
    await expect(controleDaIa(page)).toContainText('IA pausada');
    await expect(cartaoDaVisaoGeral(page)).toHaveText(/^Pausada\s*IA respondendo\s*em todos os chips$/);

    await controleDaIa(page).getByRole('button', { name: 'Retomar' }).click();
    await expect(controleDaIa(page).getByRole('button', { name: 'Pausar tudo' })).toBeVisible();
    await expect(cartaoDaVisaoGeral(page)).toHaveText(/^Ligada\s*IA respondendo\s*em 1 chip$/);
  });

  test('qualquer pessoa da equipe pausa; só o dono retoma', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await entrar(page, 'colega');

    await controleDaIa(page).getByRole('button', { name: 'Pausar tudo' }).click();
    const janela = page.getByRole('dialog', { name: 'Pausar a IA em todos os chips?' });
    await expect(janela).toContainText('Só o dono da conta consegue retomar depois.');
    await janela.getByRole('button', { name: 'Pausar tudo' }).click();
    await expect(controleDaIa(page)).toContainText('IA pausada');
    await expect(controleDaIa(page).getByRole('button')).toHaveCount(0);

    // A dona entra e encontra a IA pausada, com o botão de retomar.
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await entrar(page, 'inbox');
    await expect(controleDaIa(page).getByRole('button', { name: 'Retomar' })).toBeVisible();
  });
});

test.describe('a IA em cada conversa da Inbox', () => {
  test('com a IA desligada no chip, a conversa não mostra nada sobre a IA', async ({ page }) => {
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);
    await expect(page.getByRole('region', { name: 'Conversa com Ana Souza' })).toBeVisible();
    await expect(faixaDaIa(page)).toHaveCount(0);
  });

  test('conversa com a IA: assumir tira a conversa dela; devolver põe de volta', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.ana, 'respondendo');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);

    await expect(page.locator('.inbox-conversa-topo .estado')).toHaveText('Com a IA');
    await expect(faixaDaIa(page)).toContainText('A IA responde esta conversa');
    await expect(faixaDaIa(page)).toContainText('Se você responder, ela para aqui por um tempo. Para tirar a conversa dela de vez, use Assumir.');
    await expect(faixaDaIa(page).getByRole('button', { name: 'Devolver para a IA' })).toHaveCount(0);

    await faixaDaIa(page).getByRole('button', { name: 'Assumir' }).click();
    await expect(faixaDaIa(page)).toContainText('Esta conversa foi assumida por uma pessoa');
    await expect(faixaDaIa(page)).toContainText('Ela só volta quando alguém devolver a conversa.');
    await expect(page.locator('.inbox-conversa-topo .estado')).toHaveText('Com você');
    await expect(faixaDaIa(page).getByRole('button', { name: 'Assumir' })).toHaveCount(0);

    await faixaDaIa(page).getByRole('button', { name: 'Devolver para a IA' }).click();
    await expect(faixaDaIa(page)).toContainText('A IA responde esta conversa');
    await expect(faixaDaIa(page).getByRole('button', { name: 'Assumir' })).toBeVisible();
  });

  test('a resposta da IA aparece na conversa com o nome dela, diferente das respostas das pessoas', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await request.post(`${SUPABASE}/controle/mensagem-da-ia?conversa=${CONVERSAS_DA_INBOX.ana}&texto=${encodeURIComponent('Entregamos sim, no Centro também!')}`);
    await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.ana, 'respondendo');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);
    const balao = page.getByRole('log', { name: 'Mensagens da conversa' }).locator('.balao').last();
    await expect(balao).toContainText('Entregamos sim, no Centro também!');
    await expect(balao).toContainText('IA');
    await expect(balao).toHaveClass(/balao--ia/);
    // A lista mostra a resposta dela como última mensagem da conversa (no celular, a lista é outra tela).
    await page.goto('/inbox');
    await expect(page.getByRole('region', { name: 'Fila de atendimento' }).getByRole('link', { name: /Ana Souza/ })).toContainText('Entregamos sim, no Centro também!');
  });

  test('a IA passou a conversa: o recado dela aparece em três linhas, com a hora em que ela volta', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.ana, 'repassada');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);

    const faixa = faixaDaIa(page);
    await expect(faixa).toContainText('A IA passou esta conversa para você');
    await expect(faixa.locator('dl')).toHaveText(/Quem é\s*cliente novo\s*O que pediu\s*quer fechar o pedido\s*Sugestão\s*confirmar o endereço/);
    await expect(faixa).toContainText(/A IA volta a responder aqui às \d\d:\d\d, ou antes, se você devolver a conversa\./);
    await expect(page.locator('.inbox-conversa-topo .estado')).toHaveText('Esperando você');
    await expect(faixa.getByRole('button', { name: 'Assumir' })).toHaveCount(0);

    await faixa.getByRole('button', { name: 'Devolver para a IA' }).click();
    await expect(faixaDaIa(page)).toContainText('A IA responde esta conversa');
    await expect(faixaDaIa(page).locator('dl')).toHaveCount(0);
  });

  test('a IA não leu a mensagem ou não conseguiu responder: a faixa explica o motivo', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.ana, 'sem_leitura');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);
    await expect(faixaDaIa(page)).toContainText('A IA não respondeu esta conversa e chamou você');
    await expect(faixaDaIa(page)).toContainText('O contato mandou um áudio. A IA só escuta áudio pelo Google Gemini');
    await expect(faixaDaIa(page)).toContainText('A IA só volta a responder aqui quando você devolver a conversa.');

    await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.bruno, 'falhou');
    await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    await expect(faixaDaIa(page)).toContainText('A IA não conseguiu responder');
    await expect(faixaDaIa(page)).toContainText('O Google Gemini recusou a chave.');
  });

  test('quando uma pessoa responde, a IA para naquela conversa e a faixa diz até quando', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.ana, 'respondendo');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);

    await page.getByLabel('Mensagem', { exact: true }).fill('Oi, Ana! Aqui é a dona da loja.');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(faixaDaIa(page)).toContainText('Uma pessoa respondeu, e a IA parou nesta conversa');
    await expect(faixaDaIa(page)).toContainText(/Ela volta a responder aqui às \d\d:\d\d, ou antes, se você devolver a conversa\./);
    await expect(faixaDaIa(page).getByRole('button', { name: 'Assumir' })).toBeVisible();
    await expect(faixaDaIa(page).getByRole('button', { name: 'Devolver para a IA' })).toBeVisible();
  });

  test('com a IA pausada na empresa, a conversa avisa que as mensagens ficam para a equipe', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.ana, 'respondendo');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana, 'colega');
    await controleDaIa(page).getByRole('button', { name: 'Pausar tudo' }).click();
    await page.getByRole('dialog', { name: 'Pausar a IA em todos os chips?' }).getByRole('button', { name: 'Pausar tudo' }).click();
    await expect(faixaDaIa(page)).toContainText('A IA está pausada em todos os chips');
    await expect(faixaDaIa(page).getByRole('button')).toHaveCount(0);
  });

  test('a lista mostra quais conversas estão com a IA', async ({ page, request }) => {
    await ligarIaNoChipVendas(request);
    await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.ana, 'respondendo');
    await entrar(page, 'inbox');
    await page.goto('/inbox');
    const item = page.getByRole('region', { name: 'Fila de atendimento' }).getByRole('link', { name: /Ana Souza/ });
    await expect(item).toContainText('Com a IA');
  });
});

test.describe('acessibilidade', () => {
  const problemasGraves = async (page: Page) => {
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    return violations.filter((violacao) => violacao.impact === 'critical' || violacao.impact === 'serious').map((violacao) => `${violacao.id}: ${violacao.nodes[0]?.html.slice(0, 160)}`);
  };

  for (const tema of ['escuro', 'claro'] as const) {
    test(`faixa da IA, liga/desliga do chip e janela de pausar, no tema ${tema}`, async ({ page, request }) => {
      // Sem animações, a troca de tema não deixa cores "no meio do caminho" na hora da medição.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await ligarIaNoChipVendas(request);
      await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.ana, 'repassada');
      await deixarIaNaConversa(request, CONVERSAS_DA_INBOX.bruno, 'respondendo');

      await abrirConversa(page, CONVERSAS_DA_INBOX.ana);
      if (tema === 'claro') {
        const folha = await abrirMenuDaConta(page);
        await folha.getByRole('button', { name: /Modo claro/ }).click();
        await folha.getByRole('button', { name: 'Fechar' }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      }
      await expect(faixaDaIa(page)).toContainText('A IA passou esta conversa para você');
      expect(await problemasGraves(page)).toEqual([]);

      await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
      await expect(faixaDaIa(page)).toContainText('A IA responde esta conversa');
      expect(await problemasGraves(page)).toEqual([]);

      await page.goto('/instancias');
      await expect(interruptorDaIa(page, 'Vendas')).toBeChecked();
      await controleDaIa(page).getByRole('button', { name: 'Pausar tudo' }).click();
      await expect(page.getByRole('dialog', { name: 'Pausar a IA em todos os chips?' })).toBeVisible();
      expect(await problemasGraves(page)).toEqual([]);
      await page.getByRole('dialog').getByRole('button', { name: 'Pausar tudo' }).click();
      await expect(controleDaIa(page)).toContainText('IA pausada');
      expect(await problemasGraves(page)).toEqual([]);
    });
  }
});
