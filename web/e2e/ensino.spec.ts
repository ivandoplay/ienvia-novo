import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { CHIP_VENDAS, CONVERSAS_DA_INBOX } from './apoio/dados.mjs';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * "Corrigir resposta em 1 clique": na Inbox, o dono guarda no Treinamento o jeito certo de responder,
 * a partir de uma resposta da IA ("Corrigir resposta") ou de uma pessoa ("Ensinar à IA").
 *
 * Cenário (Supabase de mentira): a "Empresa da Inbox". A dona entra como `inbox`; `colega` é da equipe.
 * O chip Vendas usa a base "Principal" (3 perguntas frequentes; a primeira é "Vocês entregam no centro?")
 * e o chip Suporte usa a base "Suporte" (sem perguntas).
 *   Ana   (Vendas):  o cliente escreveu "Oi, boa tarde!" e "Vocês entregam no centro?".
 *   Bruno (Vendas):  "Qual o valor do frete?" → a dona respondeu "O frete é R$ 10,00." → "Fechado, pode mandar."
 *   Carla (Suporte): "Meu pedido não chegou".
 */
const SUPABASE = 'http://127.0.0.1:54399';

const respostaDaIa = (request: APIRequestContext, conversa: string, texto: string) =>
  request.post(`${SUPABASE}/controle/mensagem-da-ia?conversa=${conversa}&texto=${encodeURIComponent(texto)}`);

test.beforeEach(async ({ request }) => {
  await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
  await request.post(`${SUPABASE}/controle/reiniciar-ia`);
  await request.post(`${SUPABASE}/controle/ia-do-chip?chip=${CHIP_VENDAS}&ligada=sim`);
});

const mensagens = (page: Page) => page.getByRole('log', { name: 'Mensagens da conversa' });
const corrigir = (page: Page) => mensagens(page).getByRole('button', { name: 'Corrigir resposta' });
const ensinar = (page: Page) => mensagens(page).getByRole('button', { name: 'Ensinar à IA' });
const janelaDeCorrigir = (page: Page) => page.getByRole('dialog', { name: 'Corrigir a resposta da IA' });
const janelaDeEnsinar = (page: Page) => page.getByRole('dialog', { name: 'Ensinar esta resposta à IA' });
const avisoDaConversa = (page: Page) => page.locator('.inbox-aviso');
const aba = (page: Page, nome: string | RegExp) => page.getByRole('tab', { name: nome });
const barraDeSalvar = (page: Page) => page.locator('.barra-de-salvar-recado');

async function abrirConversa(page: Page, conversa: string, usuario = 'inbox') {
  await entrar(page, usuario);
  await page.goto(`/inbox?c=${conversa}`);
  await expect(page).toHaveTitle('Inbox · Ienvia');
  await expect(mensagens(page).locator('.balao').first()).toBeVisible();
}

async function abrirPerguntasDoTreinamento(page: Page) {
  await page.goto('/treinamento');
  await expect(page.getByRole('heading', { name: 'Treinamento', level: 1 })).toBeVisible();
  await aba(page, /^Perguntas frequentes/).click();
}

test.describe('corrigir uma resposta da IA', () => {
  test('a janela já vem com a pergunta do cliente e a resposta inteira da IA; o que a dona guarda vai para o topo do Treinamento', async ({ page, request }) => {
    // A IA respondeu em dois balões, e respondeu errado.
    await respostaDaIa(request, CONVERSAS_DA_INBOX.ana, 'Oi! Boa tarde!');
    await respostaDaIa(request, CONVERSAS_DA_INBOX.ana, 'Não entregamos no Centro.');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);

    // Um botão só por resposta da IA, no último balão dela; as mensagens do cliente não têm botão.
    await expect(corrigir(page)).toHaveCount(1);
    await expect(ensinar(page)).toHaveCount(0);
    await expect(mensagens(page).locator('.balao').last()).toContainText('Não entregamos no Centro.');
    await expect(mensagens(page).locator('.balao').last().getByRole('button', { name: 'Corrigir resposta' })).toBeVisible();

    await corrigir(page).click();
    const janela = janelaDeCorrigir(page);
    await expect(janela).toBeVisible();
    await expect(janela).toContainText('Fica guardado no Treinamento da base que o chip Vendas usa');
    await expect(janela).toContainText('Nada é enviado ao cliente agora.');
    await expect(janela.getByRole('radio', { name: /Pergunta frequente/ })).toBeChecked();
    await expect(janela.getByLabel('Quando o cliente perguntar')).toHaveValue('Vocês entregam no centro?');
    await expect(janela.getByLabel('A IA deve responder')).toHaveValue('Oi! Boa tarde!\nNão entregamos no Centro.');

    await janela.getByLabel('A IA deve responder').fill('Entregamos sim! A taxa para o Centro é R$ 7,00.');
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();

    // Essa pergunta já existia na base: a resposta é trocada, sem duplicar.
    await expect(janela).toHaveCount(0);
    await expect(avisoDaConversa(page)).toHaveText(/Essa pergunta já existia na base “Principal”: a resposta foi trocada\. A IA já usa na próxima resposta\./);
    await expect(avisoDaConversa(page)).toHaveAttribute('role', 'status');
    // Nada foi enviado ao cliente: a conversa continua com as mesmas mensagens.
    await expect(mensagens(page).locator('.balao')).toHaveCount(4);

    await abrirPerguntasDoTreinamento(page);
    await expect(aba(page, /^Perguntas frequentes/)).toHaveText('Perguntas frequentes (3)');
    await expect(page.getByLabel('Pergunta 1')).toHaveValue('Vocês entregam no centro?');
    await expect(page.getByLabel('Resposta 1')).toHaveValue('Entregamos sim! A taxa para o Centro é R$ 7,00.');
    await expect(page.locator('.treino-perguntas > li').first()).toContainText('Veio de uma resposta ensinada pela Inbox.');
    await expect(page.getByLabel('Pergunta 2')).toHaveValue('Qual o valor do frete?');
  });

  test('a base que aprende é a do chip da conversa', async ({ page, request }) => {
    // A Carla escreveu para o chip Suporte, que usa a base "Suporte".
    await request.post(`${SUPABASE}/controle/ia-do-chip?chip=${CHIP_VENDAS}&ligada=nao`);
    await respostaDaIa(request, CONVERSAS_DA_INBOX.carla, 'Vou conferir.');
    await abrirConversa(page, CONVERSAS_DA_INBOX.carla);

    await corrigir(page).click();
    const janela = janelaDeCorrigir(page);
    await expect(janela).toContainText('da base que o chip Suporte usa');
    await expect(janela.getByLabel('Quando o cliente perguntar')).toHaveValue('Meu pedido não chegou');
    await janela.getByLabel('A IA deve responder').fill('Sinto muito pelo atraso! Me passe o número do pedido, por favor.');
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(avisoDaConversa(page)).toHaveText(/Guardado nas perguntas frequentes da base “Suporte”\./);

    // A base Principal continua com as 3 perguntas dela; a Suporte ganhou a primeira.
    await abrirPerguntasDoTreinamento(page);
    await expect(aba(page, /^Perguntas frequentes/)).toHaveText('Perguntas frequentes (3)');
    await page.getByRole('navigation', { name: 'Bases de treinamento' }).getByRole('link', { name: /Suporte/ }).click();
    await expect(page).toHaveURL(/base=/);
    await aba(page, /^Perguntas frequentes/).click();
    await expect(aba(page, /^Perguntas frequentes/)).toHaveText('Perguntas frequentes (1)');
    await expect(page.getByLabel('Pergunta 1')).toHaveValue('Meu pedido não chegou');
  });

  test('guardar como regra de ouro: a regra começa em branco e entra como uma linha nova nas regras', async ({ page, request }) => {
    await respostaDaIa(request, CONVERSAS_DA_INBOX.ana, 'Entrego hoje mesmo, pode deixar!');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);
    await corrigir(page).click();
    const janela = janelaDeCorrigir(page);

    await janela.getByRole('radio', { name: /Regra de ouro/ }).check();
    // Numa regra não há pergunta, e a fala da IA não é copiada: a pessoa escreve a ordem.
    await expect(janela.getByLabel('Quando o cliente perguntar')).toHaveCount(0);
    await expect(janela.getByLabel('A IA deve responder')).toHaveCount(0);
    await expect(janela.getByLabel('Regra que a IA deve seguir')).toHaveValue('');

    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(janela.getByRole('alert')).toHaveText('Escreva a regra que a IA deve seguir.');

    await janela.getByLabel('Regra que a IA deve seguir').fill('Nunca confirme entrega para o mesmo dia.');
    await expect(janela.getByRole('alert')).toHaveCount(0);
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(avisoDaConversa(page)).toHaveText(/Regra guardada nas regras de ouro da base “Principal”\. A IA já segue na próxima resposta\./);

    // A mesma regra de novo não repete.
    await corrigir(page).click();
    await janelaDeCorrigir(page).getByRole('radio', { name: /Regra de ouro/ }).check();
    await janelaDeCorrigir(page).getByLabel('Regra que a IA deve seguir').fill('Nunca confirme entrega para o mesmo dia.');
    await janelaDeCorrigir(page).getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(avisoDaConversa(page)).toHaveText(/Essa regra já estava nas regras de ouro da base “Principal”\. Nada mudou\./);

    await page.goto('/treinamento');
    await aba(page, 'Regras').click();
    const regras = await page.getByLabel('Regras de ouro (o que fazer e o que nunca inventar)').inputValue();
    expect(regras.endsWith('\n- Nunca confirme entrega para o mesmo dia.')).toBe(true);
    expect(regras.split('- Nunca confirme entrega para o mesmo dia.')).toHaveLength(2);
  });

  test('a janela confere antes de guardar, e cancelar não guarda nada', async ({ page, request }) => {
    await respostaDaIa(request, CONVERSAS_DA_INBOX.ana, 'Não sei informar.');
    await abrirConversa(page, CONVERSAS_DA_INBOX.ana);
    await corrigir(page).click();
    const janela = janelaDeCorrigir(page);

    await janela.getByLabel('A IA deve responder').fill('   ');
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(janela.getByRole('alert')).toHaveText('Escreva como a IA deve responder.');

    await janela.getByLabel('A IA deve responder').fill('Sim.');
    await janela.getByLabel('Quando o cliente perguntar').fill('');
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(janela.getByRole('alert')).toHaveText('Escreva o que o cliente pergunta.');

    // Passou do limite: o contador aparece no campo e a janela explica.
    await janela.getByLabel('Quando o cliente perguntar').fill('p'.repeat(501));
    await expect(janela.getByText('501 de 500 caracteres.')).toBeVisible();
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(janela.getByRole('alert')).toContainText('A pergunta é comprida demais: tem 501 caracteres e cabem 500.');

    await janela.getByRole('button', { name: 'Cancelar' }).click();
    await expect(janela).toHaveCount(0);
    await expect(avisoDaConversa(page)).toHaveCount(0);

    await abrirPerguntasDoTreinamento(page);
    await expect(aba(page, /^Perguntas frequentes/)).toHaveText('Perguntas frequentes (3)');
    await expect(page.getByLabel('Resposta 1')).toHaveValue('Entregamos em toda Fortaleza, inclusive no Centro. O frete é R$ 10,00.');
  });
});

test.describe('ensinar com a resposta de uma pessoa', () => {
  test('a resposta que a dona deu vira pergunta frequente nova, no topo da lista', async ({ page }) => {
    await abrirConversa(page, CONVERSAS_DA_INBOX.bruno);
    // Só a resposta da dona tem o botão; as mensagens do cliente, não.
    await expect(ensinar(page)).toHaveCount(1);
    await expect(corrigir(page)).toHaveCount(0);

    await ensinar(page).click();
    const janela = janelaDeEnsinar(page);
    await expect(janela).toContainText('A IA passa a responder assim quando perguntarem a mesma coisa.');
    await expect(janela.getByLabel('Quando o cliente perguntar')).toHaveValue('Qual o valor do frete?');
    await expect(janela.getByLabel('A IA deve responder')).toHaveValue('O frete é R$ 10,00.');

    await janela.getByLabel('Quando o cliente perguntar').fill('Quanto custa a entrega?');
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(avisoDaConversa(page)).toHaveText(/Guardado nas perguntas frequentes da base “Principal”\. A IA já usa na próxima resposta\./);

    await abrirPerguntasDoTreinamento(page);
    await expect(aba(page, /^Perguntas frequentes/)).toHaveText('Perguntas frequentes (4)');
    await expect(page.getByLabel('Pergunta 1')).toHaveValue('Quanto custa a entrega?');
    await expect(page.getByLabel('Resposta 1')).toHaveValue('O frete é R$ 10,00.');
    await expect(page.getByLabel('Pergunta 2')).toHaveValue('Vocês entregam no centro?');
  });

  test('quem é da equipe, mas não é dono, não vê os botões de ensinar', async ({ page, request }) => {
    await respostaDaIa(request, CONVERSAS_DA_INBOX.bruno, 'Anotado!');
    await abrirConversa(page, CONVERSAS_DA_INBOX.bruno, 'colega');
    await expect(mensagens(page).locator('.balao').last()).toContainText('Anotado!');
    await expect(ensinar(page)).toHaveCount(0);
    await expect(corrigir(page)).toHaveCount(0);
  });
});

test.describe('a tela do Treinamento aberta enquanto alguém ensina pela Inbox', () => {
  test('salvar com a tela desatualizada é recusado, com a saída à mostra; depois de recarregar, o que foi ensinado está lá', async ({ page, request }) => {
    await respostaDaIa(request, CONVERSAS_DA_INBOX.ana, 'Não sei.');
    await entrar(page, 'inbox');
    await page.goto('/treinamento');
    await expect(page.getByRole('heading', { name: 'Treinamento', level: 1 })).toBeVisible();

    // Em outra aba do navegador, a dona ensina uma pergunta nova pela Inbox.
    const outraAba = await page.context().newPage();
    await outraAba.goto(`/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await corrigir(outraAba).click();
    await janelaDeCorrigir(outraAba).getByLabel('Quando o cliente perguntar').fill('Vocês abrem aos domingos?');
    await janelaDeCorrigir(outraAba).getByLabel('A IA deve responder').fill('Abrimos das 9h às 13h.');
    await janelaDeCorrigir(outraAba).getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(avisoDaConversa(outraAba)).toHaveText(/Guardado nas perguntas frequentes da base “Principal”/);
    await outraAba.close();

    // De volta à primeira aba (que não sabe da pergunta nova), ela muda um campo e tenta salvar.
    await page.getByLabel('Nicho ou área de atuação').fill('Moda praia');
    await page.getByRole('button', { name: 'Salvar treinamento' }).click();
    await expect(barraDeSalvar(page)).toContainText('Esta base foi alterada em outro lugar depois que você abriu esta tela');
    await expect(barraDeSalvar(page)).toContainText('nada foi salvo');
    await expect(page.getByRole('button', { name: 'Salvar treinamento' })).toHaveCount(0);

    // Mexer em outro campo não some com o caminho de saída.
    await page.getByLabel('Nicho ou área de atuação').fill('Moda praia e fitness');
    await expect(barraDeSalvar(page)).toHaveText('Esta base foi alterada em outro lugar. Recarregue a página antes de salvar.');

    await page.getByRole('button', { name: 'Recarregar a página' }).click();
    await expect(page.getByRole('heading', { name: 'Treinamento', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Nicho ou área de atuação')).toHaveValue('Moda feminina');
    await expect(aba(page, /^Perguntas frequentes/)).toHaveText('Perguntas frequentes (4)');

    // Com a tela em dia, salvar funciona, e a pergunta ensinada continua lá.
    await page.getByLabel('Nicho ou área de atuação').fill('Moda praia');
    await page.getByRole('button', { name: 'Salvar treinamento' }).click();
    await expect(barraDeSalvar(page)).toHaveText('Treinamento salvo.');
    await aba(page, /^Perguntas frequentes/).click();
    await expect(page.getByLabel('Pergunta 1')).toHaveValue('Vocês abrem aos domingos?');
    await expect(page.locator('.treino-perguntas > li')).toHaveCount(4);
  });
});

test.describe('ensinar a IA: acessibilidade e celular', () => {
  async function problemasGraves(page: Page) {
    const resultado = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    return resultado.violations
      .filter((violacao) => violacao.impact === 'serious' || violacao.impact === 'critical')
      .map((violacao) => `${violacao.id}: ${violacao.help} (${violacao.nodes.length}x) → ${violacao.nodes[0]?.target.join(' ')}`);
  }

  test.beforeEach(async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await respostaDaIa(request, CONVERSAS_DA_INBOX.bruno, 'Fechado! Sai amanhã cedo.');
  });

  test('tema escuro: a conversa com os botões, a janela aberta, com erro, e o aviso de que guardou', async ({ page }) => {
    await abrirConversa(page, CONVERSAS_DA_INBOX.bruno);
    await expect(corrigir(page)).toHaveCount(1);
    await expect(ensinar(page)).toHaveCount(1);
    expect(await problemasGraves(page), 'conversa com os botões').toEqual([]);

    await corrigir(page).click();
    const janela = janelaDeCorrigir(page);
    await expect(janela).toBeVisible();
    expect(await problemasGraves(page), 'janela aberta').toEqual([]);

    await janela.getByLabel('A IA deve responder').fill('');
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(janela.getByRole('alert')).toBeVisible();
    expect(await problemasGraves(page), 'janela com erro').toEqual([]);

    await janela.getByRole('radio', { name: /Regra de ouro/ }).check();
    await janela.getByLabel('Regra que a IA deve seguir').fill('Confirme sempre o endereço.');
    expect(await problemasGraves(page), 'janela na regra de ouro').toEqual([]);
    await janela.getByRole('button', { name: 'Guardar no Treinamento' }).click();
    await expect(avisoDaConversa(page)).toBeVisible();
    expect(await problemasGraves(page), 'aviso de que guardou').toEqual([]);
  });

  test('tema claro: a conversa com os botões e a janela aberta', async ({ page }) => {
    await abrirConversa(page, CONVERSAS_DA_INBOX.bruno);
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: /Modo claro/ }).click();
    await folha.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await problemasGraves(page), 'conversa com os botões').toEqual([]);

    await ensinar(page).click();
    await expect(janelaDeEnsinar(page)).toBeVisible();
    expect(await problemasGraves(page), 'janela aberta').toEqual([]);
  });

  test('a janela se usa só com o teclado e devolve o foco ao botão que a abriu', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Teclado físico: só vale para tela de computador.');
    await abrirConversa(page, CONVERSAS_DA_INBOX.bruno);
    await corrigir(page).focus();
    await page.keyboard.press('Enter');
    await expect(janelaDeCorrigir(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(janelaDeCorrigir(page)).toHaveCount(0);
    await expect(corrigir(page)).toBeFocused();
  });

  test('no celular, a janela cabe na tela e os botões dos balões têm tamanho de toque', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de celular.');
    await abrirConversa(page, CONVERSAS_DA_INBOX.bruno);
    for (const botao of [corrigir(page), ensinar(page)]) {
      const caixa = await botao.boundingBox();
      expect(caixa?.height ?? 0).toBeGreaterThanOrEqual(24);
    }
    await corrigir(page).click();
    const janela = janelaDeCorrigir(page);
    await expect(janela).toBeVisible();
    const medidas = await page.evaluate(() => ({ pagina: document.documentElement.scrollWidth, janela: window.innerWidth }));
    expect(medidas.pagina).toBeLessThanOrEqual(medidas.janela);
    const caixa = await janela.boundingBox();
    expect(caixa?.width ?? 0).toBeLessThanOrEqual(medidas.janela);
    await expect(janela.getByRole('button', { name: 'Guardar no Treinamento' })).toBeInViewport();
  });
});
