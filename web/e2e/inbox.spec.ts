import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { CONVERSAS_DA_INBOX } from './apoio/dados.mjs';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * A Inbox, do começo ao fim, contra o Supabase e a Evolution de mentira.
 *
 * O cenário (e2e/apoio/dados.mjs, "Empresa da Inbox") volta ao começo antes de cada teste:
 *   Ana (nova, 2 não lidas) · Bruno (com você, 1 não lida) · Carla (nova, chip desconectado) ·
 *   um contato sem nome (aguardando o cliente) · Elisa (o número não tem WhatsApp) ·
 *   Fábio (a Evolution dá erro) · Diego e Gabi (resolvidas; a da Gabi é de um chip removido).
 */
const SUPABASE = 'http://127.0.0.1:54399';
const EVOLUTION = 'http://127.0.0.1:54398';
const SEM_NOME = '+55 (11) 97777-0003';

interface Envio {
  instancia: string;
  numero: string;
  texto: string;
}

const enviadasPelaEvolution = async (request: APIRequestContext) =>
  (await (await request.get(`${EVOLUTION}/controle/enviadas?prefixo=ienvia-fixo`)).json()) as Envio[];
const tentativasNaEvolution = async (request: APIRequestContext) =>
  (await (await request.get(`${EVOLUTION}/controle/tentativas?prefixo=ienvia-fixo`)).json()) as Envio[];

/** Um cliente escreve (como se o aviso da Evolution tivesse acabado de chegar ao painel). */
const clienteEscreve = (request: APIRequestContext, conversa: string, texto: string) =>
  request.post(`${SUPABASE}/controle/receber-mensagem?conversa=${conversa}&texto=${encodeURIComponent(texto)}`);

async function abrirInbox(page: Page, usuario = 'inbox', caminho = '/inbox') {
  await entrar(page, usuario);
  await page.goto(caminho);
  await expect(page).toHaveTitle('Inbox · Ienvia');
}

const lista = (page: Page) => page.getByRole('region', { name: /^(Fila de atendimento|Resultado da busca)$/ });
const nomesNaLista = (page: Page) => lista(page).locator('.inbox-item-nome');
const filtro = (page: Page, nome: string) => page.getByRole('navigation', { name: 'Filtros das conversas' }).getByRole('link', { name: new RegExp(`^${nome}`) });
const conversaCom = (page: Page, nome: string) => page.getByRole('region', { name: `Conversa com ${nome}` });
const baloes = (page: Page) => page.getByRole('log', { name: 'Mensagens da conversa' }).locator('.balao');
const etapaNoTopo = (page: Page) => page.locator('.inbox-conversa-topo .estado');
const campoDeMensagem = (page: Page) => page.getByLabel('Mensagem', { exact: true });

async function abrirConversa(page: Page, nome: string | RegExp, titulo: string = String(nome)) {
  await lista(page).getByRole('link', { name: nome }).click();
  await expect(page.getByRole('heading', { level: 2, name: titulo })).toBeVisible();
}

async function enviar(page: Page, texto: string) {
  await campoDeMensagem(page).fill(texto);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
}

/** No celular a lista some quando uma conversa está aberta; este passo volta para ela. */
async function verALista(page: Page, noCelular: boolean) {
  if (noCelular) await page.getByRole('link', { name: 'Voltar para a lista de conversas' }).click();
  await expect(lista(page)).toBeVisible();
}

async function problemasGraves(page: Page) {
  await expect(page).toHaveTitle(/.+/);
  const resultado = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return resultado.violations
    .filter((violacao) => violacao.impact === 'serious' || violacao.impact === 'critical')
    .map((violacao) => `${violacao.id}: ${violacao.help} (${violacao.nodes.length}x) → ${violacao.nodes[0]?.target.join(' ')}`);
}

async function ligarTemaClaro(page: Page) {
  const folha = await abrirMenuDaConta(page);
  await folha.getByRole('button', { name: /Modo claro/ }).click();
  await folha.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
}

test.beforeEach(async ({ request }) => {
  await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
  await request.delete(`${EVOLUTION}/controle/enviadas`);
});

test.describe('Inbox — lista de conversas', () => {
  test('mostra as conversas em aberto, da mais recente para a mais antiga, com as não lidas em destaque', async ({ page }) => {
    await abrirInbox(page);

    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    await expect(nomesNaLista(page)).toHaveText(['Ana Souza', 'Bruno Lima', 'Carla Dias', SEM_NOME, 'Elisa Prado', 'Fábio Nunes']);
    await expect(lista(page)).toContainText('6 conversas');

    const ana = lista(page).getByRole('link', { name: /Ana Souza/ });
    await expect(ana).toContainText('Vocês entregam no centro?');
    await expect(ana).toContainText('2 mensagens não lidas');
    await expect(ana).toContainText('Nova');
    // Com mais de um chip na conta, cada conversa diz de qual chip é.
    await expect(ana).toContainText('Vendas');
    await expect(lista(page).getByRole('link', { name: /Carla Dias/ })).toContainText('Suporte');

    await expect(filtro(page, 'Ativas')).toHaveAttribute('aria-current', 'true');
    await expect(filtro(page, 'Não lidas')).toHaveText(/Não lidas\s*3/);
    await expect(filtro(page, 'Esperando você')).toHaveText(/Esperando você\s*5/);
  });

  test('filtros: não lidas, esperando você e resolvidas', async ({ page }) => {
    await abrirInbox(page);

    await filtro(page, 'Não lidas').click();
    await expect(page).toHaveURL(/\/inbox\?ver=nao-lidas$/);
    await expect(nomesNaLista(page)).toHaveText(['Ana Souza', 'Bruno Lima', 'Carla Dias']);
    await expect(filtro(page, 'Não lidas')).toHaveAttribute('aria-current', 'true');

    await filtro(page, 'Esperando você').click();
    await expect(nomesNaLista(page)).toHaveText(['Ana Souza', 'Bruno Lima', 'Carla Dias', 'Elisa Prado', 'Fábio Nunes']);

    await filtro(page, 'Resolvidas').click();
    await expect(nomesNaLista(page)).toHaveText(['Diego Rocha', 'Gabi Moura']);

    await filtro(page, 'Ativas').click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(nomesNaLista(page)).toHaveCount(6);
  });

  test('ver por chip: só as conversas daquele chip, inclusive de um chip que já foi removido', async ({ page }) => {
    await abrirInbox(page);
    const verPorChip = page.getByLabel('Ver por chip');

    await verPorChip.selectOption({ label: 'Suporte' });
    await expect(page).toHaveURL(/chip=/);
    await expect(nomesNaLista(page)).toHaveText(['Carla Dias']);
    // Os números dos filtros acompanham o chip escolhido.
    await expect(filtro(page, 'Não lidas')).toHaveText(/Não lidas\s*1/);
    await expect(filtro(page, 'Esperando você')).toHaveText(/Esperando você\s*1/);

    // O histórico de um chip removido continua disponível.
    await verPorChip.selectOption({ label: 'Número antigo' });
    await expect(lista(page)).toContainText('Nenhuma conversa em aberto neste chip');
    await filtro(page, 'Resolvidas').click();
    await expect(nomesNaLista(page)).toHaveText(['Gabi Moura']);

    await verPorChip.selectOption({ label: 'Todos os chips' });
    await expect(nomesNaLista(page)).toHaveText(['Diego Rocha', 'Gabi Moura']);
  });

  test('busca por nome, por telefone e pelo texto da última mensagem, em todas as conversas', async ({ page }) => {
    await abrirInbox(page);
    const busca = page.getByLabel('Buscar conversa');

    await busca.fill('bruno');
    await busca.press('Enter');
    await expect(page).toHaveURL(/busca=bruno/);
    await expect(nomesNaLista(page)).toHaveText(['Bruno Lima']);
    await expect(lista(page)).toContainText('Procurando “bruno” em todas as conversas');

    // O número foi digitado com o nono dígito e com pontuação.
    await busca.fill('(85) 98888-0004');
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(nomesNaLista(page)).toHaveText(['Carla Dias']);

    await busca.fill('orçamento');
    await busca.press('Enter');
    await expect(nomesNaLista(page)).toHaveText([SEM_NOME]);

    // A busca também acha conversa resolvida.
    await busca.fill('diego');
    await busca.press('Enter');
    await expect(nomesNaLista(page)).toHaveText(['Diego Rocha']);
    await expect(lista(page).getByRole('link', { name: /Diego Rocha/ })).toContainText('Resolvida');

    await busca.fill('zzz-nada');
    await busca.press('Enter');
    await expect(lista(page)).toContainText('Nada encontrado');

    await page.getByRole('link', { name: 'Limpar busca' }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(busca).toHaveValue('');
    await expect(nomesNaLista(page)).toHaveCount(6);
  });

  test('"Ver mais conversas" traz o resto da lista', async ({ page }) => {
    // A Loja da Maria tem 17 conversas em aberto.
    await abrirInbox(page, 'dona', '/inbox?limite=5');
    await expect(nomesNaLista(page)).toHaveCount(5);
    await expect(lista(page)).toContainText('mais de 5 conversas');

    await page.getByRole('link', { name: 'Ver mais conversas' }).click();
    await expect(nomesNaLista(page)).toHaveCount(17);
    await expect(lista(page)).toContainText('17 conversas');
    await expect(page.getByRole('link', { name: 'Ver mais conversas' })).toHaveCount(0);
  });

  test('uma mensagem nova aparece na lista sozinha, sem recarregar a página', async ({ page, request }) => {
    await abrirInbox(page);
    await expect(nomesNaLista(page).first()).toHaveText('Ana Souza');

    await clienteEscreve(request, CONVERSAS_DA_INBOX.elisa, 'Alguém aí?');

    const elisa = lista(page).getByRole('link', { name: /Elisa Prado/ });
    await expect(elisa).toContainText('Alguém aí?', { timeout: 15_000 });
    await expect(elisa).toContainText('1 mensagem não lida');
    await expect(nomesNaLista(page).first()).toHaveText('Elisa Prado');
    await expect(filtro(page, 'Não lidas')).toHaveText(/Não lidas\s*4/);
  });
});

test.describe('Inbox — conversa aberta', () => {
  test('abrir mostra as mensagens e marca a conversa como lida', async ({ page, isMobile }) => {
    await abrirInbox(page);
    await abrirConversa(page, /Ana Souza/, 'Ana Souza');
    await expect(page).toHaveURL(new RegExp(`/inbox\\?c=${CONVERSAS_DA_INBOX.ana}$`));

    await expect(baloes(page)).toHaveText([/Oi, boa tarde!/, /Vocês entregam no centro\?/]);
    await expect(conversaCom(page, 'Ana Souza')).toContainText('+55 (85) 98888-0001');
    await expect(conversaCom(page, 'Ana Souza')).toContainText('Chip Vendas');
    await expect(etapaNoTopo(page)).toHaveText('Nova');

    await verALista(page, isMobile);
    await expect(lista(page).getByRole('link', { name: /Ana Souza/ })).not.toContainText('não lida');
    await expect(filtro(page, 'Não lidas')).toHaveText(/Não lidas\s*2/);
  });

  test('cada resposta diz quem escreveu: você, a equipe ou o celular do chip', async ({ page }) => {
    await abrirInbox(page);

    await abrirConversa(page, /Bruno Lima/, 'Bruno Lima');
    await expect(baloes(page).nth(1)).toContainText('O frete é R$ 10,00.');
    await expect(baloes(page).nth(1)).toContainText('Você');

    await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.semNome}`);
    await expect(page.getByRole('heading', { level: 2, name: SEM_NOME })).toBeVisible();
    await expect(baloes(page).first()).toContainText('Pelo celular');

    await page.goto(`/inbox?ver=resolvidas&c=${CONVERSAS_DA_INBOX.diego}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Diego Rocha' })).toBeVisible();
    await expect(baloes(page).last()).toContainText('Equipe');
    await expect(page.getByText('Ontem', { exact: true })).toBeVisible();
  });

  test('dados do contato: ao lado no computador, numa janela no celular', async ({ page, isMobile }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Bruno Lima' })).toBeVisible();

    const botao = page.getByRole('button', { name: 'Contato', exact: true });
    if (isMobile) {
      await botao.click();
      const janela = page.getByRole('dialog', { name: 'Dados do contato' });
      await expect(janela).toContainText('+55 (85) 98888-0002');
      await expect(janela).toContainText('Vendas (conectado)');
      await expect(janela).toContainText('Com você');
      await janela.getByRole('button', { name: 'Fechar' }).click();
      await expect(janela).toBeHidden();
    } else {
      await expect(botao).toBeHidden();
      const cartao = page.getByRole('complementary', { name: 'Dados do contato' });
      await expect(cartao).toContainText('Bruno Lima');
      await expect(cartao).toContainText('+55 (85) 98888-0002');
      await expect(cartao).toContainText('Vendas (conectado)');
      await expect(cartao).toContainText('Com você');
    }
  });

  test('contato sem nome aparece pelo telefone', async ({ page, isMobile }) => {
    test.skip(isMobile, 'A coluna do contato só fica ao lado no computador.');
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.semNome}`);
    await expect(page.getByRole('heading', { level: 2, name: SEM_NOME })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Dados do contato' })).toContainText('Este contato ainda não tem nome.');
  });

  test('uma mensagem nova do cliente entra na conversa aberta sozinha e já fica como lida', async ({ page, request, isMobile }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.semNome}`);
    await expect(etapaNoTopo(page)).toHaveText('Aguardando o cliente');

    await clienteEscreve(request, CONVERSAS_DA_INBOX.semNome, 'Quero sim! Quanto fica?');

    await expect(baloes(page).last()).toContainText('Quero sim! Quanto fica?', { timeout: 15_000 });
    // O cliente respondeu: a bola volta para quem atende.
    await expect(etapaNoTopo(page)).toHaveText('Com você');

    await verALista(page, isMobile);
    await expect(lista(page).getByRole('link', { name: new RegExp(SEM_NOME.replace(/[+()]/g, '\\$&')) })).not.toContainText('não lida');
  });

  test('endereço de uma conversa que não existe avisa em vez de quebrar', async ({ page }) => {
    await abrirInbox(page, 'inbox', '/inbox?c=f0000000-0000-4000-8000-00000000dead');
    await expect(page.getByText('Esta conversa não existe mais')).toBeVisible();
    await page.getByRole('link', { name: 'Voltar para as conversas' }).click();
    await expect(page).toHaveURL(/\/inbox$/);
  });

  test('uma empresa não vê nem abre as conversas da outra', async ({ page }) => {
    await abrirInbox(page, 'dona');
    await expect(nomesNaLista(page).first()).toHaveText('Cliente 1');
    await expect(lista(page)).not.toContainText('Ana Souza');

    await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await expect(page.getByText('Esta conversa não existe mais')).toBeVisible();
    await expect(page.getByText('Vocês entregam no centro?')).toHaveCount(0);
  });
});

test.describe('Inbox — responder', () => {
  test('a resposta sai pela Evolution, entra na conversa e a conversa passa a aguardar o cliente', async ({ page, request, isMobile }) => {
    await abrirInbox(page);
    await abrirConversa(page, /Bruno Lima/, 'Bruno Lima');
    await expect(etapaNoTopo(page)).toHaveText('Com você');

    await enviar(page, 'Combinado! Sai hoje à tarde.');

    const ultimo = baloes(page).last();
    await expect(ultimo).toContainText('Combinado! Sai hoje à tarde.');
    await expect(ultimo).toContainText('Você');
    await expect(ultimo).toContainText('Enviada');
    await expect(baloes(page)).toHaveCount(4);
    await expect(campoDeMensagem(page)).toHaveValue('');
    await expect(etapaNoTopo(page)).toHaveText('Aguardando o cliente');

    // O número vai só com dígitos, pelo chip da conversa, e uma única vez.
    expect(await enviadasPelaEvolution(request)).toMatchObject([
      { instancia: 'ienvia-fixo-vendas', numero: '5585988880002', texto: 'Combinado! Sai hoje à tarde.' },
    ]);
    expect(await tentativasNaEvolution(request)).toHaveLength(1);

    await verALista(page, isMobile);
    await expect(lista(page).getByRole('link', { name: /Bruno Lima/ })).toContainText('Combinado! Sai hoje à tarde.');
    await expect(lista(page).getByRole('link', { name: /Bruno Lima/ })).toContainText('Aguardando o cliente');
    await expect(nomesNaLista(page).first()).toHaveText('Bruno Lima');
  });

  test('no computador, Enter envia e Shift + Enter pula a linha', async ({ page, request, isMobile }) => {
    test.skip(isMobile, 'No celular, Enter pula a linha (como no WhatsApp).');
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);

    const campo = campoDeMensagem(page);
    await campo.click();
    await campo.pressSequentially('Primeira linha');
    await campo.press('Shift+Enter');
    await campo.pressSequentially('Segunda linha');
    await expect(campo).toHaveValue('Primeira linha\nSegunda linha');
    await campo.press('Enter');

    await expect(baloes(page).last()).toContainText('Segunda linha');
    await expect(campo).toHaveValue('');
    await expect(campo).toBeFocused();
    // O balão aparece na hora; "Enviada" só aparece quando a Evolution confirmou.
    await expect(baloes(page).last()).toContainText('Enviada');
    expect(await enviadasPelaEvolution(request)).toMatchObject([{ texto: 'Primeira linha\nSegunda linha' }]);
  });

  test('no celular, Enter pula a linha e quem envia é o botão', async ({ page, request, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de toque.');
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);

    const campo = campoDeMensagem(page);
    await campo.click();
    await campo.pressSequentially('Primeira linha');
    await campo.press('Enter');
    await campo.pressSequentially('Segunda linha');
    await expect(campo).toHaveValue('Primeira linha\nSegunda linha');
    expect(await tentativasNaEvolution(request)).toHaveLength(0);

    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(baloes(page).last()).toContainText('Segunda linha');
    await expect(baloes(page).last()).toContainText('Enviada');
    expect(await enviadasPelaEvolution(request)).toMatchObject([{ texto: 'Primeira linha\nSegunda linha' }]);
  });

  test('mensagem só com espaços não é enviada', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    await campoDeMensagem(page).fill('    ');
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeDisabled();
    expect(await tentativasNaEvolution(request)).toHaveLength(0);
  });

  test('o que a pessoa estava escrevendo não se perde ao trocar de conversa', async ({ page, isMobile }) => {
    await abrirInbox(page);
    await abrirConversa(page, /Bruno Lima/, 'Bruno Lima');
    await campoDeMensagem(page).fill('Rascunho para o Bruno');

    await verALista(page, isMobile);
    await abrirConversa(page, /Ana Souza/, 'Ana Souza');
    await expect(campoDeMensagem(page)).toHaveValue('');

    await verALista(page, isMobile);
    await abrirConversa(page, /Bruno Lima/, 'Bruno Lima');
    await expect(campoDeMensagem(page)).toHaveValue('Rascunho para o Bruno');
  });

  test('o atendente (que não é o dono) também responde', async ({ page, request }) => {
    await abrirInbox(page, 'colega', `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    // A resposta antiga foi da dona: para o atendente, é "Equipe".
    await expect(baloes(page).nth(1)).toContainText('Equipe');

    await enviar(page, 'Aqui é o Caio, já estou vendo.');
    await expect(baloes(page).last()).toContainText('Aqui é o Caio, já estou vendo.');
    await expect(baloes(page).last()).toContainText('Você');
    await expect(baloes(page).last()).toContainText('Enviada');
    expect(await enviadasPelaEvolution(request)).toHaveLength(1);
  });

  test('número sem WhatsApp: a mensagem fica como não enviada, com o motivo, e dá para escrever de novo', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.elisa}`);
    await enviar(page, 'Ligamos sim!');

    const conversa = conversaCom(page, 'Elisa Prado');
    await expect(conversa.getByRole('alert')).toContainText('A mensagem não foi enviada: este número não tem WhatsApp.');
    const balao = baloes(page).last();
    await expect(balao).toContainText('Ligamos sim!');
    await expect(balao).toContainText('Não enviada');
    // Nada saiu, e a conversa continua esperando a resposta de quem atende.
    expect(await enviadasPelaEvolution(request)).toHaveLength(0);
    await expect(etapaNoTopo(page)).toHaveText('Com você');

    await balao.getByRole('button', { name: 'Escrever de novo' }).click();
    await expect(campoDeMensagem(page)).toHaveValue('Ligamos sim!');
    await expect(campoDeMensagem(page)).toBeFocused();

    await conversa.getByRole('button', { name: 'Fechar aviso' }).click();
    await expect(conversa.getByRole('alert')).toHaveCount(0);
  });

  test('sem confirmação: o painel não reenvia sozinho; a pessoa confere e decide', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.fabio}`);
    await enviar(page, 'Temos 3 em estoque.');

    const balao = baloes(page).last();
    await expect(balao).toContainText('Sem confirmação');
    await expect(balao).toContainText('Confira no WhatsApp do chip');
    await expect(etapaNoTopo(page)).toHaveText('Com você');

    // Uma chamada à Evolution, e só uma: sem confirmação não é motivo para tentar de novo.
    await page.waitForTimeout(1_500);
    expect(await tentativasNaEvolution(request)).toHaveLength(1);

    // A pessoa olhou no celular: não foi.
    await balao.getByRole('button', { name: 'Não foi enviada' }).click();
    await expect(balao).toContainText('Não enviada');
    await expect(balao.getByRole('button', { name: 'Foi enviada', exact: true })).toHaveCount(0);
    expect(await tentativasNaEvolution(request)).toHaveLength(1);

    // Ela escreve de novo; desta vez confere e a mensagem tinha chegado.
    await balao.getByRole('button', { name: 'Escrever de novo' }).click();
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    const segundo = baloes(page).last();
    await expect(segundo).toContainText('Sem confirmação');
    await segundo.getByRole('button', { name: 'Foi enviada', exact: true }).click();
    await expect(segundo).toContainText('Enviada');
    await expect(segundo).not.toContainText('Sem confirmação');
    await expect(etapaNoTopo(page)).toHaveText('Aguardando o cliente');
    expect(await tentativasNaEvolution(request)).toHaveLength(2);
  });

  test('chip desconectado: o dono vê o caminho para reconectar', async ({ page }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.carla}`);
    const conversa = conversaCom(page, 'Carla Dias');
    await expect(conversa).toContainText('O chip “Suporte” está desconectado. Reconecte para responder.');
    await expect(campoDeMensagem(page)).toHaveCount(0);
    await expect(conversa.getByRole('link', { name: 'Abrir Instâncias' })).toHaveAttribute('href', '/instancias');
  });

  test('chip desconectado: o atendente vê a quem pedir', async ({ page }) => {
    await abrirInbox(page, 'colega', `/inbox?c=${CONVERSAS_DA_INBOX.carla}`);
    await expect(conversaCom(page, 'Carla Dias')).toContainText('O chip “Suporte” está desconectado. Peça ao dono da conta para reconectar.');
    await expect(page.getByRole('link', { name: 'Abrir Instâncias' })).toHaveCount(0);
    await expect(campoDeMensagem(page)).toHaveCount(0);
  });
});

test.describe('Inbox — resolver e reabrir', () => {
  test('resolver tira a conversa das ativas; reabrir devolve', async ({ page, isMobile }) => {
    await abrirInbox(page);
    await abrirConversa(page, /Ana Souza/, 'Ana Souza');

    await page.getByRole('button', { name: 'Resolver', exact: true }).click();
    await expect(etapaNoTopo(page)).toHaveText('Resolvida');
    await expect(conversaCom(page, 'Ana Souza')).toContainText('Esta conversa está resolvida. Para responder, reabra a conversa.');
    await expect(campoDeMensagem(page)).toHaveCount(0);

    await verALista(page, isMobile);
    await expect(nomesNaLista(page)).toHaveCount(5);
    await expect(lista(page)).not.toContainText('Ana Souza');
    await filtro(page, 'Resolvidas').click();
    await expect(nomesNaLista(page)).toHaveText(['Ana Souza', 'Diego Rocha', 'Gabi Moura']);

    await abrirConversa(page, /Ana Souza/, 'Ana Souza');
    await page.getByRole('button', { name: 'Reabrir conversa' }).click();
    await expect(etapaNoTopo(page)).toHaveText('Com você');
    await expect(campoDeMensagem(page)).toBeVisible();

    await verALista(page, isMobile);
    await filtro(page, 'Ativas').click();
    await expect(nomesNaLista(page).first()).toHaveText('Ana Souza');
  });

  test('conversa de um chip removido: dá para ler e reabrir, mas não para responder', async ({ page }) => {
    await abrirInbox(page, 'inbox', `/inbox?ver=resolvidas&c=${CONVERSAS_DA_INBOX.gabi}`);
    const conversa = conversaCom(page, 'Gabi Moura');
    await expect(conversa).toContainText('Chip Número antigo (removido)');
    await expect(baloes(page)).toHaveText([/Oi, ainda atendem neste número\?/]);

    await page.getByRole('button', { name: 'Reabrir conversa' }).click();
    await expect(conversa).toContainText('O chip “Número antigo” foi removido. Dá para ler a conversa, mas não para responder por ela.');
    await expect(campoDeMensagem(page)).toHaveCount(0);
  });
});

test.describe('Inbox — celular', () => {
  test('a lista e a conversa ocupam a tela uma de cada vez, com botão de voltar', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de celular.');
    await abrirInbox(page);
    await expect(lista(page)).toBeVisible();
    await expect(page.locator('.inbox-conversa')).toBeHidden();

    await abrirConversa(page, /Bruno Lima/, 'Bruno Lima');
    await expect(lista(page)).toBeHidden();
    // O foco acompanha a troca de tela.
    await expect(page.getByRole('heading', { level: 2, name: 'Bruno Lima' })).toBeFocused();
    // A conversa cabe na tela: o campo de escrever fica acima da barra de baixo, sem a página rolar.
    await expect(campoDeMensagem(page)).toBeInViewport();
    const sobra = await page.evaluate(() => {
      const area = document.querySelector('.content-area');
      return area ? area.scrollHeight - area.clientHeight : -1;
    });
    expect(sobra).toBeGreaterThanOrEqual(0);
    expect(sobra).toBeLessThanOrEqual(1);

    await page.getByRole('link', { name: 'Voltar para a lista de conversas' }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(lista(page)).toBeVisible();

    // O botão "voltar" do navegador faz o mesmo caminho.
    await page.goBack();
    await expect(page.getByRole('heading', { level: 2, name: 'Bruno Lima' })).toBeVisible();
  });
});

test.describe('Inbox — acessibilidade', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  for (const tema of ['escuro', 'claro'] as const) {
    test(`lista e conversa aberta, tema ${tema}`, async ({ page }) => {
      await entrar(page, 'inbox');
      if (tema === 'claro') await ligarTemaClaro(page);

      await page.goto('/inbox');
      await expect(nomesNaLista(page)).toHaveCount(6);
      expect(await problemasGraves(page)).toEqual([]);

      await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
      await expect(baloes(page)).toHaveCount(3);
      expect(await problemasGraves(page)).toEqual([]);
    });

    test(`mensagem não enviada, sem confirmação e conversa resolvida, tema ${tema}`, async ({ page }) => {
      await entrar(page, 'inbox');
      if (tema === 'claro') await ligarTemaClaro(page);

      await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.elisa}`);
      await enviar(page, 'Ligamos sim!');
      await expect(baloes(page).last()).toContainText('Não enviada');
      await expect(conversaCom(page, 'Elisa Prado').getByRole('alert')).toBeVisible();
      expect(await problemasGraves(page)).toEqual([]);

      await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.fabio}`);
      await enviar(page, 'Temos 3 em estoque.');
      await expect(baloes(page).last().getByRole('button', { name: 'Foi enviada', exact: true })).toBeVisible();
      expect(await problemasGraves(page)).toEqual([]);

      await page.goto(`/inbox?ver=resolvidas&c=${CONVERSAS_DA_INBOX.diego}`);
      await expect(page.getByRole('button', { name: 'Reabrir conversa' })).toBeVisible();
      expect(await problemasGraves(page)).toEqual([]);
    });
  }

  test('janela com os dados do contato', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'No computador os dados do contato ficam ao lado, não numa janela.');
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    await page.getByRole('button', { name: 'Contato', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Dados do contato' })).toBeVisible();
    expect(await problemasGraves(page)).toEqual([]);
  });
});
