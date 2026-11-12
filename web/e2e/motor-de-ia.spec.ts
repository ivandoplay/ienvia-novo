import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  CHAVE_GEMINI_DE_TESTE,
  CHAVE_GEMINI_VAZADA,
  CHAVE_NVIDIA_DE_TESTE,
  CHAVE_NVIDIA_NO_LIMITE,
  CHAVE_OPENROUTER_DE_TESTE,
  CHAVE_OPENROUTER_SEM_CREDITO,
} from './apoio/chaves-de-ia.mjs';
import type { PedidoRecebido } from './apoio/ia-falsa.mjs';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * Tela "Motor de IA", do começo ao fim, contra o Supabase de mentira e a IA de mentira
 * (que imita o Gemini, o OpenRouter e a NVIDIA com cópias das respostas de erro de verdade).
 * Nenhuma chave de verdade é usada.
 *
 * A "Empresa da Inbox" (usuário "inbox") começa com a chave do Gemini cadastrada e o resto no padrão.
 */
const SUPABASE = 'http://127.0.0.1:54399';
const IA = 'http://127.0.0.1:54397';

async function comecarDoZero(request: APIRequestContext) {
  await request.post(`${SUPABASE}/controle/reiniciar-ia`);
  await request.post(`${IA}/controle/reiniciar`);
}

const pedidosNaIa = async (request: APIRequestContext) => (await (await request.get(`${IA}/controle/pedidos`)).json()) as PedidoRecebido[];
const simularFalha = (request: APIRequestContext, tipo: string, provedor: string) => request.post(`${IA}/controle/falha?tipo=${tipo}&vezes=1&provedor=${provedor}`);

async function abrirMotor(page: Page, usuario = 'inbox') {
  await entrar(page, usuario);
  await page.goto('/inteligencia-artificial');
  await expect(page.getByRole('heading', { name: 'Motor de IA', level: 1 })).toBeVisible();
}

const cartao = (page: Page, provedor: 'Google Gemini' | 'OpenRouter' | 'NVIDIA') => page.getByRole('article', { name: provedor });
const recadoDoCartao = (page: Page, provedor: 'Google Gemini' | 'OpenRouter' | 'NVIDIA') => cartao(page, provedor).getByRole('status');
const principal = (page: Page) => page.getByLabel('Provedor principal');
const reserva = (page: Page) => page.getByLabel('Se o principal falhar');
const segundaReserva = (page: Page) => page.getByLabel('Se a reserva também falhar');
const salvar = (page: Page) => page.getByRole('button', { name: 'Salvar alterações' });
const rodape = (page: Page) => page.locator('.motor-rodape-recado');
const avisos = (page: Page) => page.locator('.motor-avisos .aviso');

/** Abre a janela da chave de um provedor, cola a chave e manda guardar. */
async function cadastrarChave(page: Page, provedor: 'Google Gemini' | 'OpenRouter' | 'NVIDIA', chave: string) {
  await cartao(page, provedor).getByRole('button', { name: /^(Cadastrar|Trocar) chave/ }).click();
  const janela = page.getByRole('dialog', { name: new RegExp(`^Chave d[oa] ${provedor}$`) });
  await expect(janela).toBeVisible();
  await janela.getByLabel(new RegExp(`^Chave d[oa] ${provedor}$`)).fill(chave);
  await janela.getByRole('button', { name: 'Guardar chave' }).click();
  return janela;
}

test.describe('Motor de IA', () => {
  test.beforeEach(async ({ request }) => {
    await comecarDoZero(request);
  });

  test('mostra os três provedores, a situação de cada chave e onde a IA é ligada', async ({ page }) => {
    await abrirMotor(page);
    await expect(page).toHaveTitle('Motor de IA · Ienvia');
    await expect(page.getByRole('article')).toHaveCount(3);

    await expect(cartao(page, 'Google Gemini')).toContainText('Chave cadastrada');
    await expect(cartao(page, 'Google Gemini')).toContainText(`Termina em …${CHAVE_GEMINI_DE_TESTE.slice(-4)}`);
    await expect(cartao(page, 'OpenRouter')).toContainText('Sem chave');
    await expect(cartao(page, 'NVIDIA')).toContainText('Sem chave');
    await expect(cartao(page, 'NVIDIA')).toContainText('Gratuito');
    await expect(cartao(page, 'NVIDIA').getByRole('link', { name: 'Criar uma chave no site da NVIDIA' })).toHaveAttribute('href', 'https://build.nvidia.com/settings/api-keys');

    // Os modelos padrão de cada um.
    await expect(page.getByLabel('Modelo do Google Gemini')).toHaveValue('gemini-3.5-flash-lite');
    await expect(page.getByLabel('Modelo do OpenRouter')).toHaveValue('deepseek/deepseek-chat');
    await expect(page.getByLabel('Modelo da NVIDIA')).toHaveValue('nvidia/nemotron-3.5-super-vl-120b-a12b');

    // O principal (Gemini) tem chave: está pronto. E a tela diz onde isso passa a valer: nos chips com a IA ligada.
    await expect(page.getByText('Pronto para responder')).toBeVisible();
    await expect(avisos(page).first()).toContainText('O que está aqui vale para as conversas dos chips que estão com a IA ligada.');
    await expect(avisos(page).first().getByRole('link', { name: 'Instâncias' })).toHaveAttribute('href', '/instancias');
    await expect(principal(page)).toHaveValue('gemini');
    await expect(reserva(page)).toHaveValue('none');
    await expect(segundaReserva(page)).toBeDisabled();
    // Sem alterações, não há o que salvar.
    await expect(salvar(page)).toBeDisabled();

    // A chave inteira não aparece em lugar nenhum da página.
    expect(await page.content()).not.toContain(CHAVE_GEMINI_DE_TESTE);
  });

  test('NVIDIA: cadastra a chave, que é testada na hora; chave errada fica guardada, mas com aviso', async ({ page, request }) => {
    await abrirMotor(page);

    // Chave de outro provedor no cartão da NVIDIA: nem sai da tela.
    let janela = await cadastrarChave(page, 'NVIDIA', CHAVE_GEMINI_DE_TESTE);
    await expect(janela.getByRole('alert')).toHaveText('Esta parece ser uma chave do Google Gemini. Cole no cartão do Google Gemini.');
    await janela.getByRole('button', { name: 'Cancelar' }).click();
    await expect(cartao(page, 'NVIDIA')).toContainText('Sem chave');
    expect(await pedidosNaIa(request)).toHaveLength(0);

    // Uma chave com cara de chave, mas que a NVIDIA não reconhece: fica guardada e a tela avisa.
    janela = await cadastrarChave(page, 'NVIDIA', 'nvapi-chave-que-a-nvidia-nao-conhece-0009');
    await expect(janela).toBeHidden();
    await expect(recadoDoCartao(page, 'NVIDIA')).toHaveText(
      'A chave foi guardada, mas o teste não passou. A NVIDIA recusou a chave. Confira se ela foi copiada inteira e se continua ativa.',
    );
    await expect(cartao(page, 'NVIDIA')).toContainText('Chave cadastrada');
    await expect(cartao(page, 'NVIDIA')).toContainText('Termina em …0009');

    // Troca pela chave boa.
    janela = await cadastrarChave(page, 'NVIDIA', CHAVE_NVIDIA_DE_TESTE);
    await expect(janela).toBeHidden();
    await expect(recadoDoCartao(page, 'NVIDIA')).toHaveText(/^Chave guardada\. Funcionou: o modelo nvidia\/nemotron-3\.5-super-vl-120b-a12b respondeu em \d+,\d s\.$/);
    await expect(cartao(page, 'NVIDIA')).toContainText(`Termina em …${CHAVE_NVIDIA_DE_TESTE.slice(-4)}`);

    // O que chegou à "NVIDIA": a pergunta de teste, no modelo da tela, com o pedido de não ficar raciocinando.
    const pedidos = (await pedidosNaIa(request)).filter((pedido) => pedido.provedor === 'nvidia');
    expect(pedidos.at(-1)).toMatchObject({ modelo: 'nvidia/nemotron-3.5-super-vl-120b-a12b', semPensar: true, temAudio: false, conversa: [{ de: 'cliente', texto: 'Teste de conexão.' }] });

    // Depois de guardada, a chave não volta para a tela (nem recarregando).
    await page.reload();
    await expect(cartao(page, 'NVIDIA')).toContainText('Chave cadastrada');
    expect(await page.content()).not.toContain(CHAVE_NVIDIA_DE_TESTE);
  });

  test('NVIDIA: a lista de modelos é pública; modelo listado mas não liberado para a conta é avisado no teste', async ({ page }) => {
    await abrirMotor(page);
    // Dá para ver os modelos antes mesmo de ter chave.
    await cartao(page, 'NVIDIA').getByRole('button', { name: /^Ver modelos/ }).click();
    const lista = cartao(page, 'NVIDIA').getByLabel('Modelos disponíveis: NVIDIA');
    // Só os de conversa: os de busca, de filtro, de leitura de documento e de programação ficam de fora.
    await expect(lista.locator('option')).toHaveText([
      'Escolher da lista (4 modelos)',
      'google/gemma-4-31b-it',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/nemotron-3.5-super-vl-120b-a12b',
      'z-ai/glm-5.3-flash',
    ]);

    await (await cadastrarChave(page, 'NVIDIA', CHAVE_NVIDIA_DE_TESTE)).waitFor({ state: 'hidden' });

    await lista.selectOption('z-ai/glm-5.3-flash');
    await expect(page.getByLabel('Modelo da NVIDIA')).toHaveValue('z-ai/glm-5.3-flash');
    await cartao(page, 'NVIDIA').getByRole('button', { name: /^Testar conexão/ }).click();
    await expect(recadoDoCartao(page, 'NVIDIA')).toHaveText(/^Funcionou: o modelo z-ai\/glm-5\.3-flash respondeu em /);

    // Está na lista da NVIDIA, mas esta conta não pode usar: só o teste descobre.
    await lista.selectOption('google/gemma-4-31b-it');
    await cartao(page, 'NVIDIA').getByRole('button', { name: /^Testar conexão/ }).click();
    await expect(recadoDoCartao(page, 'NVIDIA')).toHaveText('O modelo "google/gemma-4-31b-it" não existe na NVIDIA, ou não está liberado para a sua conta. Escolha outro modelo.');

    // Um nome que nem existe.
    await page.getByLabel('Modelo da NVIDIA').fill('fabricante/modelo-inventado');
    await cartao(page, 'NVIDIA').getByRole('button', { name: /^Testar conexão/ }).click();
    await expect(recadoDoCartao(page, 'NVIDIA')).toHaveText('O modelo "fabricante/modelo-inventado" não existe na NVIDIA, ou não está liberado para a sua conta. Escolha outro modelo.');
  });

  test('cada problema do provedor vira uma frase clara: limite, pane, sem crédito e chave bloqueada', async ({ page, request }) => {
    await abrirMotor(page);

    // NVIDIA no limite de pedidos.
    await (await cadastrarChave(page, 'NVIDIA', CHAVE_NVIDIA_NO_LIMITE)).waitFor({ state: 'hidden' });
    await expect(recadoDoCartao(page, 'NVIDIA')).toContainText('A NVIDIA avisou que o limite de uso desta chave foi atingido.');

    // NVIDIA fora do ar na hora do teste.
    await (await cadastrarChave(page, 'NVIDIA', CHAVE_NVIDIA_DE_TESTE)).waitFor({ state: 'hidden' });
    await simularFalha(request, 'pane', 'nvidia');
    await cartao(page, 'NVIDIA').getByRole('button', { name: /^Testar conexão/ }).click();
    await expect(recadoDoCartao(page, 'NVIDIA')).toHaveText('A NVIDIA está com problema agora. Tente de novo em instantes.');
    // O painel não tenta de novo sozinho: quem decide repetir é a pessoa.
    await cartao(page, 'NVIDIA').getByRole('button', { name: /^Testar conexão/ }).click();
    await expect(recadoDoCartao(page, 'NVIDIA')).toHaveText(/^Funcionou: /);

    // OpenRouter com a conta sem crédito.
    await (await cadastrarChave(page, 'OpenRouter', CHAVE_OPENROUTER_SEM_CREDITO)).waitFor({ state: 'hidden' });
    await expect(recadoDoCartao(page, 'OpenRouter')).toHaveText('A chave foi guardada, mas o teste não passou. A conta do OpenRouter está sem crédito.');

    // Gemini com a chave que o Google bloqueou por ter aparecido em público.
    await (await cadastrarChave(page, 'Google Gemini', CHAVE_GEMINI_VAZADA)).waitFor({ state: 'hidden' });
    await expect(recadoDoCartao(page, 'Google Gemini')).toContainText('O Google Gemini bloqueou esta chave porque ela apareceu em algum lugar público.');
    await expect(recadoDoCartao(page, 'Google Gemini')).toContainText('crie uma chave nova');
  });

  test('ordem de uso: principal, reserva e segunda reserva, sem repetir provedor; fica gravada', async ({ page }) => {
    await abrirMotor(page);

    await principal(page).selectOption('nvidia');
    await expect(page.getByText('Falta a chave', { exact: true })).toBeVisible();
    await expect(avisos(page).filter({ hasText: 'Falta a chave' })).toHaveText(['Falta a chave da NVIDIA, o provedor principal.']);
    // Sem o Gemini na ordem, ninguém escuta áudio.
    await expect(page.getByText('a IA não entende os áudios dos clientes')).toBeVisible();

    // A reserva só oferece quem não é o principal.
    await expect(reserva(page).locator('option')).toHaveText(['Sem reserva: a IA não responde aquela mensagem', 'Usar o Google Gemini', 'Usar o OpenRouter']);
    await reserva(page).selectOption('gemini');
    await expect(page.getByText('os áudios dos clientes vão sempre para ele')).toBeVisible();
    // A segunda reserva só oferece quem sobrou.
    await expect(segundaReserva(page)).toBeEnabled();
    await expect(segundaReserva(page).locator('option')).toHaveText(['Sem segunda reserva', 'Usar o OpenRouter']);
    await segundaReserva(page).selectOption('openrouter');
    await expect(avisos(page).filter({ hasText: 'Falta a chave' })).toHaveText(['Falta a chave da NVIDIA, o provedor principal.', 'Falta a chave do OpenRouter, a segunda reserva.']);

    await expect(rodape(page)).toHaveText('Há alterações que ainda não foram salvas.');
    await salvar(page).click();
    await expect(rodape(page)).toHaveText('Alterações salvas.');

    await page.reload();
    await expect(principal(page)).toHaveValue('nvidia');
    await expect(reserva(page)).toHaveValue('gemini');
    await expect(segundaReserva(page)).toHaveValue('openrouter');

    // Quem vira principal sai das reservas, e a outra reserva sobe de posto.
    await principal(page).selectOption('gemini');
    await expect(reserva(page)).toHaveValue('openrouter');
    await expect(segundaReserva(page)).toHaveValue('none');
    // Tirar a reserva tira também a segunda.
    await segundaReserva(page).selectOption('nvidia');
    await reserva(page).selectOption('none');
    await expect(reserva(page)).toHaveValue('nvidia');
    await expect(segundaReserva(page)).toHaveValue('none');

    // Desfazer volta ao que está gravado.
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(principal(page)).toHaveValue('nvidia');
    await expect(reserva(page)).toHaveValue('gemini');
    await expect(segundaReserva(page)).toHaveValue('openrouter');
    await expect(salvar(page)).toBeDisabled();
  });

  test('comportamento nas conversas e modelos: o que se muda fica gravado', async ({ page }) => {
    await abrirMotor(page);

    const digitando = page.getByRole('switch', { name: 'Mostrar “digitando…” antes de responder' });
    const pararComPessoa = page.getByRole('switch', { name: 'Parar a IA quando uma pessoa responder' });
    const volta = page.getByLabel('Depois que uma pessoa responde, a IA volta em');
    await expect(digitando).toBeChecked();
    await digitando.uncheck();
    await volta.selectOption('120');
    await page.getByLabel('Esperar o cliente terminar de escrever').selectOption('10');
    await page.getByLabel('Quanto da conversa a IA relê').selectOption('30');
    await page.getByLabel('Modelo da NVIDIA').fill('  z-ai/glm-5.3-flash ');
    await salvar(page).click();
    await expect(rodape(page)).toHaveText('Alterações salvas.');

    await page.reload();
    await expect(digitando).not.toBeChecked();
    await expect(volta).toHaveValue('120');
    await expect(page.getByLabel('Esperar o cliente terminar de escrever')).toHaveValue('10');
    await expect(page.getByLabel('Quanto da conversa a IA relê')).toHaveValue('30');
    // Os espaços em volta do nome do modelo saem ao gravar.
    await expect(page.getByLabel('Modelo da NVIDIA')).toHaveValue('z-ai/glm-5.3-flash');

    // Sem "parar quando uma pessoa responder", o tempo de volta não se aplica.
    await pararComPessoa.uncheck();
    await expect(volta).toBeDisabled();

    // Nome de modelo que não serve: a tela explica e nada é gravado.
    await page.getByLabel('Modelo da NVIDIA').fill('modelo com espaço');
    await salvar(page).click();
    await expect(rodape(page)).toHaveText('O nome do modelo da NVIDIA não é válido. Exemplo: nvidia/nemotron-3.5-super-vl-120b-a12b');
    await page.reload();
    await expect(page.getByLabel('Modelo da NVIDIA')).toHaveValue('z-ai/glm-5.3-flash');
    await expect(pararComPessoa).toBeChecked();
  });

  test('testar e remover a chave do Gemini; sem a chave do principal, a tela diz o que falta', async ({ page, request }) => {
    await abrirMotor(page);

    await cartao(page, 'Google Gemini').getByRole('button', { name: /^Testar conexão/ }).click();
    await expect(recadoDoCartao(page, 'Google Gemini')).toHaveText(/^Funcionou: o modelo gemini-3\.5-flash-lite respondeu em /);
    expect((await pedidosNaIa(request)).at(-1)).toMatchObject({ provedor: 'gemini', modelo: 'gemini-3.5-flash-lite' });

    await cartao(page, 'Google Gemini').getByRole('button', { name: /^Ver modelos/ }).click();
    await expect(cartao(page, 'Google Gemini').getByLabel('Modelos disponíveis: Google Gemini').locator('option')).toHaveText([
      'Escolher da lista (3 modelos)',
      'Gemini 3.5 Flash-Lite',
      'Gemini 3.8 Flash',
      'Gemini 4 Argon',
    ]);

    await cartao(page, 'Google Gemini').getByRole('button', { name: /^Remover chave/ }).click();
    const janela = page.getByRole('dialog', { name: 'Remover chave' });
    await expect(janela).toContainText('A chave do Google Gemini será apagada daqui.');
    // Cancelar não apaga nada.
    await janela.getByRole('button', { name: 'Cancelar' }).click();
    await expect(cartao(page, 'Google Gemini')).toContainText('Chave cadastrada');

    await cartao(page, 'Google Gemini').getByRole('button', { name: /^Remover chave/ }).click();
    await page.getByRole('dialog', { name: 'Remover chave' }).getByRole('button', { name: 'Remover chave' }).click();
    await expect(recadoDoCartao(page, 'Google Gemini')).toHaveText('Chave removida.');
    await expect(cartao(page, 'Google Gemini')).toContainText('Sem chave');
    await expect(page.getByText('Falta a chave', { exact: true })).toBeVisible();
    await expect(avisos(page).filter({ hasText: 'Falta a chave' })).toHaveText(['Falta a chave do Google Gemini, o provedor principal.']);

    await page.reload();
    await expect(cartao(page, 'Google Gemini')).toContainText('Sem chave');
    // No Gemini, a lista de modelos depende da chave: sem chave, o botão some. Nos outros dois, continua.
    await expect(cartao(page, 'Google Gemini').getByRole('button', { name: /^Ver modelos/ })).toHaveCount(0);
    await expect(cartao(page, 'OpenRouter').getByRole('button', { name: /^Ver modelos/ })).toBeVisible();
    await expect(cartao(page, 'NVIDIA').getByRole('button', { name: /^Ver modelos/ })).toBeVisible();
  });

  test('OpenRouter: cadastra a chave e escolhe um modelo gratuito da lista', async ({ page }) => {
    await abrirMotor(page);
    await (await cadastrarChave(page, 'OpenRouter', CHAVE_OPENROUTER_DE_TESTE)).waitFor({ state: 'hidden' });
    await expect(recadoDoCartao(page, 'OpenRouter')).toHaveText(/^Chave guardada\. Funcionou: o modelo deepseek\/deepseek-chat respondeu em /);

    await cartao(page, 'OpenRouter').getByRole('button', { name: /^Ver modelos/ }).click();
    const lista = cartao(page, 'OpenRouter').getByLabel('Modelos disponíveis: OpenRouter');
    await expect(lista.locator('optgroup')).toHaveCount(2);
    await expect(lista.locator('optgroup[label="Gratuitos"] option')).toHaveText(['Google: Gemma 4 26B (free)']);
    await lista.selectOption('google/gemma-4-26b-a4b-it:free');
    await expect(page.getByLabel('Modelo do OpenRouter')).toHaveValue('google/gemma-4-26b-a4b-it:free');
  });

  test('a atendente vê como está configurado, mas não muda nada nem vê o final das chaves', async ({ page }) => {
    await abrirMotor(page, 'colega');
    await expect(page.getByText('Só o dono da conta altera o Motor de IA.')).toBeVisible();
    await expect(cartao(page, 'Google Gemini')).toContainText('Chave cadastrada');
    await expect(cartao(page, 'Google Gemini')).toContainText('Guardada e protegida');
    await expect(cartao(page, 'Google Gemini')).not.toContainText('Termina em');

    await expect(page.getByRole('button', { name: /chave/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Testar conexão|Ver modelos)/ })).toHaveCount(0);
    await expect(salvar(page)).toHaveCount(0);
    for (const campo of [principal(page), reserva(page), segundaReserva(page), page.getByLabel('Modelo da NVIDIA'), page.getByLabel('Quanto da conversa a IA relê')]) {
      await expect(campo).toBeDisabled();
    }
    await expect(page.getByRole('switch', { name: 'Dividir respostas longas em mensagens menores' })).toBeDisabled();
  });

  test('cada empresa tem o seu Motor de IA: a outra conta não vê as chaves nem os ajustes desta', async ({ page }) => {
    await abrirMotor(page);
    await principal(page).selectOption('nvidia');
    await salvar(page).click();
    await expect(rodape(page)).toHaveText('Alterações salvas.');

    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: 'Sair desta conta' }).click();
    await expect(page).toHaveURL(/\/login/);

    await abrirMotor(page, 'dona');
    await expect(principal(page)).toHaveValue('gemini');
    for (const provedor of ['Google Gemini', 'OpenRouter', 'NVIDIA'] as const) await expect(cartao(page, provedor)).toContainText('Sem chave');
  });

  test('no celular, nada passa da largura da tela', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de celular.');
    await abrirMotor(page);
    await cartao(page, 'NVIDIA').getByRole('button', { name: /^Ver modelos/ }).click();
    await expect(cartao(page, 'NVIDIA').getByLabel('Modelos disponíveis: NVIDIA')).toBeVisible();
    const larguras = await page.evaluate(() => ({ pagina: document.documentElement.scrollWidth, janela: window.innerWidth }));
    expect(larguras.pagina).toBeLessThanOrEqual(larguras.janela);
  });
});

test.describe('Motor de IA: acessibilidade', () => {
  async function problemasGraves(page: Page) {
    await expect(page).toHaveTitle(/.+/);
    const resultado = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    return resultado.violations
      .filter((violacao) => violacao.impact === 'serious' || violacao.impact === 'critical')
      .map((violacao) => `${violacao.id}: ${violacao.help} (${violacao.nodes.length}x) → ${violacao.nodes[0]?.target.join(' ')}`);
  }

  test.beforeEach(async ({ page, request }) => {
    await comecarDoZero(request);
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('tema escuro, com recados, lista de modelos e alterações por salvar', async ({ page }) => {
    await abrirMotor(page);
    await cartao(page, 'Google Gemini').getByRole('button', { name: /^Testar conexão/ }).click();
    await expect(recadoDoCartao(page, 'Google Gemini')).toHaveText(/^Funcionou/);
    await cartao(page, 'NVIDIA').getByRole('button', { name: /^Ver modelos/ }).click();
    await expect(cartao(page, 'NVIDIA').getByLabel('Modelos disponíveis: NVIDIA')).toBeVisible();
    await principal(page).selectOption('nvidia');
    await expect(rodape(page)).toHaveText('Há alterações que ainda não foram salvas.');
    expect(await problemasGraves(page)).toEqual([]);
  });

  test('tema claro', async ({ page }) => {
    await abrirMotor(page);
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: /Modo claro/ }).click();
    await folha.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await principal(page).selectOption('openrouter');
    await expect(avisos(page).filter({ hasText: 'Falta a chave' })).toHaveCount(1);
    expect(await problemasGraves(page)).toEqual([]);
  });

  test('janela de cadastrar chave, com erro à mostra', async ({ page }) => {
    await abrirMotor(page);
    const janela = await cadastrarChave(page, 'NVIDIA', 'curta');
    await expect(janela.getByRole('alert')).toHaveText('Esta chave está curta demais. Confira se copiou inteira.');
    expect(await problemasGraves(page)).toEqual([]);
  });

  test('atendente, só leitura', async ({ page }) => {
    await abrirMotor(page, 'colega');
    await expect(page.getByText('Só o dono da conta altera o Motor de IA.')).toBeVisible();
    expect(await problemasGraves(page)).toEqual([]);
  });
});
