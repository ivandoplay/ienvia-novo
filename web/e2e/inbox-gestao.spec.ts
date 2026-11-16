import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { CONVERSAS_DA_INBOX, SENHA_DE_TESTE, USUARIOS, WORKSPACE_INBOX } from './apoio/dados.mjs';
import { entrar } from './apoio/sessao';

/**
 * Inbox — gestão da conversa (silenciar, transferir, lembretes, citação, busca, rascunho da IA,
 * automação das etapas e ações em lote), nos dois tamanhos: computador e celular.
 *
 * Tudo roda contra o Supabase, a Evolution e a IA de mentira (e2e/apoio). O cenário da Inbox volta ao
 * começo antes de cada teste; cada teste confere no "banco" o que ficou gravado, não só o que a tela mostra.
 *
 * O cenário (e2e/apoio/dados.mjs) tem: Ana (nova, falou há 12 min), Bruno (com você, falou do frete),
 * Carla (chip desconectado), Elisa, Fábio, Helena (arquivos) e as resolvidas.
 */

const SUPABASE = 'http://127.0.0.1:54399';
const EVOLUTION = 'http://127.0.0.1:54398';
const COLEGA = 'colega@zapia.local';
/** O rótulo que o banco grava em `assigned_label` vem do perfil de cada pessoa. */
const NOME_DO_COLEGA = 'Caio Colega';
/** Na lista (espaço curto) o chip mostra só o primeiro nome de quem atende. */
const COLEGA_NA_LISTA = 'Caio';

/* ---------------------------------------------------------------------------------------------- */
/* Apoio                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

async function abrirInbox(page: Page, caminho = '/inbox') {
  await entrar(page, 'inbox');
  await page.goto(caminho);
  await expect(page).toHaveTitle('Inbox · Ienvia');
}

/** No celular o topo só tem espaço para alguns botões: o resto mora no menu "Mais". */
async function abrirMais(page: Page) {
  const botao = page.getByRole('button', { name: 'Mais', exact: true });
  if ((await botao.getAttribute('aria-expanded')) !== 'true') await botao.click();
  await expect(botao).toHaveAttribute('aria-expanded', 'true');
  return page.getByRole('group', { name: 'Mais ações da conversa' });
}

/** Clica num botão do topo da conversa, abrindo o menu "Mais" quando ele mora lá. */
async function clicarEm(page: Page, nome: string) {
  const noTopo = page.getByRole('region', { name: /^Conversa com / }).getByRole('button', { name: nome, exact: true });
  if (await noTopo.count()) {
    await noTopo.first().click();
    return;
  }
  const menu = await abrirMais(page);
  await menu.getByRole('button', { name: nome, exact: true }).click();
}

const lista = (page: Page) => page.getByRole('region', { name: /^(Fila de atendimento|Resultado da busca)$/ });
const nomesNaLista = (page: Page) => lista(page).locator('.inbox-item-nome');
const conversaCom = (page: Page, nome: string) => page.getByRole('region', { name: `Conversa com ${nome}` });
const baloes = (page: Page) => page.getByRole('log', { name: 'Mensagens da conversa' }).locator('.balao');
const campoDeMensagem = (page: Page) => page.getByLabel('Mensagem', { exact: true });

/** No celular a lista e a conversa ocupam a tela uma de cada vez: a conversa se abre pelo nome. */
async function abrirConversa(page: Page, nome: string) {
  const aberta = conversaCom(page, nome);
  if (await aberta.count()) return aberta;
  await voltarParaALista(page);
  await page.getByRole('link', { name: new RegExp(`^${nome}`) }).first().click();
  await expect(aberta).toBeVisible();
  return aberta;
}

/** No celular, volta da conversa para a lista (no computador as duas ficam na tela e não há o link). */
async function voltarParaALista(page: Page) {
  const voltar = page.getByRole('link', { name: 'Voltar para a lista de conversas' });
  if (await voltar.count()) await voltar.click();
}

/**
 * Envia o que está no campo como uma pessoa faria: no computador, Enter; no celular, Enter quebra a
 * linha (como no WhatsApp) e quem envia é o botão.
 */
async function enviarMensagem(page: Page, conversa: string) {
  if (test.info().project.name === 'celular') {
    await conversaCom(page, conversa).getByRole('button', { name: 'Enviar', exact: true }).click();
    return;
  }
  await page.keyboard.press('Enter');
}

/** A conversa como o "banco" a guarda. */
interface ConversaNoBanco {
  id: string;
  stage: string;
  is_muted?: boolean | null;
  assigned_user_id?: string | null;
  assigned_label?: string | null;
  follow_up_at?: string | null;
  crm_stage?: string | null;
  unread_count?: number;
}

async function conversaNoBanco(request: APIRequestContext, id: string): Promise<ConversaNoBanco> {
  const todas = (await (await request.get(`${SUPABASE}/controle/conversas?workspace=${WORKSPACE_INBOX}`)).json()) as ConversaNoBanco[];
  const encontrada = todas.find((c) => c.id === id);
  expect(encontrada, `a conversa ${id} devia existir no banco`).toBeTruthy();
  return encontrada as ConversaNoBanco;
}

interface MensagemNoBanco {
  id: string;
  body_text: string | null;
  direction: string;
  reply_to_message_id?: string | null;
}

async function mensagensNoBanco(request: APIRequestContext, conversa: string): Promise<MensagemNoBanco[]> {
  return (await (await request.get(`${SUPABASE}/controle/mensagens?conversa=${conversa}`)).json()) as MensagemNoBanco[];
}

/** O que a Evolution de mentira recebeu (só o que saiu do painel). */
async function enviadasPelaEvolution(request: APIRequestContext) {
  return (await (await request.get(`${EVOLUTION}/controle/enviadas?prefixo=ienvia-fixo`)).json()) as Array<{
    instancia: string;
    numero: string;
    texto: string;
  }>;
}

const minutosAtras = (minutos: number) => new Date(Date.now() - minutos * 60_000);

/**
 * Cada teste começa do cenário da Inbox como ele nasceu (nada de um teste atrapalhar o outro): o
 * "banco" volta ao começo e a Evolution de mentira esquece o que saiu nos testes anteriores.
 */
test.beforeEach(async ({ request }) => {
  await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
  await request.delete(`${EVOLUTION}/controle/enviadas?prefixo=ienvia-fixo`);
});

/** A janela de 24 h: a última mensagem do cliente foi há mais de um dia. */
async function deixarJanelaFechada(request: APIRequestContext) {
  await request.post(`${SUPABASE}/controle/seguir-conversa`, {
    data: { conversa: CONVERSAS_DA_INBOX.bruno, ultimaDoCliente: minutosAtras(26 * 60).toISOString() },
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* Menu "Mais": abre, fecha com Esc, devolve o foco                                               */
/* ---------------------------------------------------------------------------------------------- */

test.describe('menu Mais da conversa', () => {
  test('abre, fecha com Esc devolvendo o foco e fecha clicando fora', async ({ page }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    const botao = page.getByRole('button', { name: 'Mais', exact: true });
    await expect(botao).toHaveAttribute('aria-expanded', 'false');
    await botao.click();
    await expect(botao).toHaveAttribute('aria-expanded', 'true');

    const menu = page.getByRole('group', { name: 'Mais ações da conversa' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Silenciar conversa' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Transferir' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Lembretes' })).toBeVisible();

    // Esc fecha o menu (e só o menu): o foco volta para o botão que abriu.
    await page.keyboard.press('Escape');
    await expect(botao).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveCount(0);
    await expect(botao).toBeFocused();

    // Clicando fora também fecha.
    await botao.click();
    await expect(menu).toBeVisible();
    await page.getByRole('heading', { name: 'Inbox', exact: true }).click({ force: true });
    await expect(menu).toHaveCount(0);
    await expect(conversaCom(page, 'Ana')).toBeVisible();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Silenciar                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

test.describe('silenciar conversa', () => {
  test('silencia, marca a conversa na lista e volta a avisar', async ({ page, request }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    await clicarEm(page, 'Silenciar conversa');
    await expect(page.getByRole('status').filter({ hasText: 'Conversa silenciada' })).toBeVisible();
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).is_muted).toBe(true);

    // A lista mostra a marca e a conversa continua ali (silenciar não é arquivar). No celular a
    // conversa ocupa a tela, então voltamos para a lista.
    await voltarParaALista(page);
    const item = lista(page).locator('.inbox-item', { hasText: 'Ana' }).first();
    await expect(item).toHaveClass(/inbox-silenciada/);
    await expect(item.getByText('Silenciada')).toBeVisible();

    // O menu passa a oferecer "Voltar a avisar".
    await abrirConversa(page, 'Ana');
    await clicarEm(page, 'Voltar a avisar');
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).is_muted).toBe(false);
    await voltarParaALista(page);
    await expect(item).not.toHaveClass(/inbox-silenciada/);
  });

  test('a conversa silenciada não é arquivada nem resolvida', async ({ page, request }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    await conversaCom(page, 'Bruno').waitFor();
    await clicarEm(page, 'Silenciar conversa');
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.bruno)).is_muted).toBe(true);

    const bruno = await conversaNoBanco(request, CONVERSAS_DA_INBOX.bruno);
    expect(bruno.stage).toBe('human');
    // Continua na fila de atendimento.
    await voltarParaALista(page);
    await expect(nomesNaLista(page).filter({ hasText: 'Bruno' })).toBeVisible();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Transferir                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

test.describe('transferir conversa', () => {
  test('transfere para uma pessoa da equipe e mostra quem atende', async ({ page, request }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    await clicarEm(page, 'Transferir');
    const janela = page.getByRole('dialog', { name: 'Transferir conversa' });
    await expect(janela).toBeVisible();
    // A própria pessoa aparece marcada como "você"; a equipe mostra o papel de cada um.
    await expect(janela.getByRole('button', { name: /Dona da Inbox/ })).toContainText('(você)');
    await expect(janela.getByRole('button', { name: new RegExp(NOME_DO_COLEGA) })).toContainText('Atendente');

    await janela.getByRole('button', { name: new RegExp(NOME_DO_COLEGA) }).click();
    await expect(page.getByRole('status').filter({ hasText: `Conversa transferida para ${NOME_DO_COLEGA}` })).toBeVisible();

    const ana = await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana);
    expect(ana.assigned_label).toBe(NOME_DO_COLEGA);
    expect(ana.assigned_user_id).toBe(USUARIOS[7]!.id);
    // A conversa passa a ser de alguém do time: sai da IA e fica em atendimento humano.
    expect(ana.stage).toBe('human');

    // O topo e a lista mostram o nome de quem atende.
    await expect(conversaCom(page, 'Ana').locator('.inbox-etiqueta--atendente').first()).toHaveText(NOME_DO_COLEGA);
    await voltarParaALista(page);
    const item = lista(page).locator('.inbox-item', { hasText: 'Ana' }).first();
    await expect(item.getByText(COLEGA_NA_LISTA, { exact: true })).toBeVisible();
  });

  test('devolve para a fila', async ({ page, request }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    await clicarEm(page, 'Transferir');
    const janela = page.getByRole('dialog', { name: 'Transferir conversa' });
    await janela.getByRole('button', { name: new RegExp(NOME_DO_COLEGA) }).click();
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).assigned_label).toBe(NOME_DO_COLEGA);

    await clicarEm(page, 'Transferir');
    await janela.getByRole('button', { name: 'Devolver para a fila' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'devolvida para a fila' })).toBeVisible();
    const ana = await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana);
    expect(ana.assigned_label).toBeNull();
    expect(ana.assigned_user_id).toBeNull();
  });

  test('quem não é dono não vê "Transferir"', async ({ page }) => {
    await entrar(page, COLEGA, SENHA_DE_TESTE);
    await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();
    const menu = await abrirMais(page);
    await expect(menu.getByRole('button', { name: 'Silenciar conversa' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Transferir' })).toHaveCount(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Lembretes                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

test.describe('lembretes', () => {
  test('marca o combinado, aparece na aba Lembretes e some quando o lembrete é tirado', async ({ page, request }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    await clicarEm(page, 'Lembretes');
    const janela = page.getByRole('dialog', { name: 'Lembretes' });
    await expect(janela).toBeVisible();
    await janela.getByRole('button', { name: 'Daqui a 1 h' }).click();
    await janela.getByRole('button', { name: 'Salvar lembrete' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Lembrete salvo.' })).toBeVisible();

    expect((await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).follow_up_at).toBeTruthy();

    // O combinado venceu: a conversa aparece na aba Lembretes.
    await request.post(`${SUPABASE}/controle/seguir-conversa`, {
      data: { conversa: CONVERSAS_DA_INBOX.ana, quando: minutosAtras(5).toISOString() },
    });
    await page.goto('/inbox?ver=lembretes');
    await expect(nomesNaLista(page).filter({ hasText: 'Ana' })).toBeVisible();

    // "Já resolvi": tira o lembrete e a conversa sai da aba.
    await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await clicarEm(page, 'Lembretes');
    await janela.getByRole('button', { name: 'Tirar o lembrete' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Lembrete tirado.' })).toBeVisible();
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).follow_up_at).toBeNull();

    await page.goto('/inbox?ver=lembretes');
    await expect(nomesNaLista(page).filter({ hasText: 'Ana' })).toHaveCount(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Responder citando                                                                              */
/* ---------------------------------------------------------------------------------------------- */

test.describe('responder citando', () => {
  test('cita uma mensagem recebida, mostra a citação e grava o vínculo', async ({ page, request }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    const citada = baloes(page).filter({ hasText: 'Vocês entregam no centro?' }).first();
    await expect(citada).toBeVisible();
    await citada.hover();
    await citada.getByRole('button', { name: 'Responder citando' }).click();

    // O campo mostra o que está sendo respondido.
    const respondendo = conversaCom(page, 'Ana').locator('.inbox-respondendo');
    await expect(respondendo).toBeVisible();
    await expect(respondendo).toContainText('Cliente: Vocês entregam no centro?');

    await campoDeMensagem(page).fill('Entregamos sim! Como posso ajudar?');
    await enviarMensagem(page, 'Ana');
    await expect(baloes(page).filter({ hasText: 'Entregamos sim! Como posso ajudar?' })).toBeVisible();

    // No banco: a resposta guardada aponta para a citada (o balão aparece antes de a gravação
    // terminar, então esperamos a linha aparecer).
    let resposta: MensagemNoBanco | undefined;
    await expect
      .poll(
        async () => {
          const mensagens = await mensagensNoBanco(request, CONVERSAS_DA_INBOX.ana);
          resposta = mensagens.find((m) => m.body_text === 'Entregamos sim! Como posso ajudar?');
          return resposta ? (resposta.reply_to_message_id ?? null) : null;
        },
        { message: 'a resposta citada devia estar guardada no banco' },
      )
      .toBeTruthy();

    // E a citação aparece em cima da resposta.
    await expect(
      baloes(page).filter({ hasText: 'Entregamos sim! Como posso ajudar?' }).locator('.balao-citacao'),
    ).toContainText('Cliente: Vocês entregam no centro?');

    // Depois de enviar, a faixa de citação sai do campo.
    await expect(respondendo).toHaveCount(0);
  });

  test('"Cancelar a citação" manda a mensagem sem citação', async ({ page, request }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    const citada = baloes(page).filter({ hasText: 'Vocês entregam no centro?' }).first();
    await citada.hover();
    await citada.getByRole('button', { name: 'Responder citando' }).click();
    const respondendo = conversaCom(page, 'Ana').locator('.inbox-respondendo');
    await expect(respondendo).toBeVisible();

    await respondendo.getByRole('button', { name: 'Cancelar a citação' }).click();
    await expect(respondendo).toHaveCount(0);

    await campoDeMensagem(page).fill('Sem citar nada.');
    await enviarMensagem(page, 'Ana');
    await expect(baloes(page).filter({ hasText: 'Sem citar nada.' })).toBeVisible();

    const mensagens = await mensagensNoBanco(request, CONVERSAS_DA_INBOX.ana);
    expect(mensagens.find((m) => m.body_text === 'Sem citar nada.')!.reply_to_message_id ?? null).toBeNull();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Procurar nesta conversa                                                                        */
/* ---------------------------------------------------------------------------------------------- */

test.describe('procurar nesta conversa', () => {
  test('acha o trecho, destaca a mensagem e diz quando não há nada', async ({ page }) => {
    // No cenário o Bruno já falou do frete ("Qual o valor do frete?").
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    await conversaCom(page, 'Bruno').waitFor();

    const daConversa = conversaCom(page, 'Bruno');
    await daConversa.getByPlaceholder('Procurar nesta conversa').fill('frete');
    await daConversa.getByRole('button', { name: 'Procurar nesta conversa' }).click();

    const resultados = daConversa.getByLabel('Resultados da busca na conversa');
    await expect(resultados).toBeVisible();
    await expect(resultados).toContainText('frete');

    // A mensagem em que o termo aparece fica destacada e com o termo marcado.
    const destacada = daConversa.locator('.balao--destacada');
    await expect(destacada).toBeVisible();
    await expect(destacada.locator('mark', { hasText: 'frete' })).toBeVisible();

    // Nada encontrado: aviso na própria busca.
    await daConversa.getByPlaceholder('Procurar nesta conversa').fill('coisa que não existe');
    await daConversa.getByRole('button', { name: 'Procurar nesta conversa' }).click();
    await expect(resultados).toContainText('Nada encontrado nesta conversa.');
  });

  test('não procura com menos de 2 letras', async ({ page }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();
    await conversaCom(page, 'Ana').getByPlaceholder('Procurar nesta conversa').fill('a');
    await conversaCom(page, 'Ana').getByRole('button', { name: 'Procurar nesta conversa' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'pelo menos 2 letras' })).toBeVisible();
  });

  test('"Procurar nas mensagens" acha o termo em outras conversas', async ({ page }) => {
    await abrirInbox(page, '/inbox?busca=frete');
    const encontradas = page.getByLabel('Mensagens encontradas');
    await page.getByRole('button', { name: 'Procurar nas mensagens' }).click();
    await expect(encontradas).toBeVisible();
    await expect(encontradas).toContainText('Qual o valor do frete?');
    await expect(encontradas.locator('mark', { hasText: 'frete' }).first()).toBeVisible();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Rascunho da IA                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

test.describe('rascunho da IA', () => {
  test('a IA escreve, nada é enviado e "Usar no campo" leva o texto ao campo', async ({ page, request }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    await conversaCom(page, 'Ana').getByRole('button', { name: 'Rascunho da IA' }).click();
    const painel = conversaCom(page, 'Ana').getByRole('group', { name: 'Rascunho feito pela IA' });
    await expect(painel).toBeVisible();
    await expect(painel).toContainText('Nada foi enviado ao cliente');
    // A IA de mentira responde citando a última fala do cliente.
    await expect(painel.locator('.inbox-rascunho-texto')).toContainText('Resposta de teste para');

    // Nada saiu: a Evolution não recebeu nada por causa do rascunho.
    expect(await enviadasPelaEvolution(request)).toHaveLength(0);

    await painel.getByRole('button', { name: 'Usar no campo' }).click();
    await expect(painel).toHaveCount(0);
    await expect(campoDeMensagem(page)).toHaveValue(/Resposta de teste para/);

    // O texto do rascunho pode ser editado antes de enviar.
    await campoDeMensagem(page).fill('Resposta revisada por mim.');
    await enviarMensagem(page, 'Ana');
    await expect(baloes(page).filter({ hasText: 'Resposta revisada por mim.' })).toBeVisible();
  });

  test('"Descartar" não deixa nada no campo', async ({ page }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();
    await conversaCom(page, 'Ana').getByRole('button', { name: 'Rascunho da IA' }).click();
    const painel = conversaCom(page, 'Ana').getByRole('group', { name: 'Rascunho feito pela IA' });
    await expect(painel.locator('.inbox-rascunho-texto')).toBeVisible();
    await painel.getByRole('button', { name: 'Descartar' }).click();
    await expect(painel).toHaveCount(0);
    await expect(campoDeMensagem(page)).toHaveValue('');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Janela de 24 h                                                                                */
/* ---------------------------------------------------------------------------------------------- */

test.describe('janela de 24 h do WhatsApp', () => {
  test('avisa quando o cliente está há mais de um dia sem falar', async ({ page, request }) => {
    await deixarJanelaFechada(request);
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    await conversaCom(page, 'Bruno').waitFor();
    await expect(conversaCom(page, 'Bruno').locator('.inbox-janela--fechada')).toContainText(
      'A janela de 24 h do WhatsApp fechou',
    );
  });

  test('não avisa quando o cliente acabou de falar', async ({ page }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();
    await expect(conversaCom(page, 'Ana').locator('.inbox-janela')).toHaveCount(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Ações em lote                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

test.describe('ações em lote', () => {
  test('silencia várias conversas de uma vez', async ({ page, request }) => {
    await abrirInbox(page);
    await expect(nomesNaLista(page).first()).toBeVisible();

    await lista(page).getByRole('button', { name: 'Selecionar' }).click();
    const barra = page.getByRole('region', { name: 'Ações em lote' });
    await expect(barra).toBeVisible();
    await lista(page).getByRole('checkbox', { name: 'Selecionar Ana' }).check();
    await lista(page).getByRole('checkbox', { name: 'Selecionar Bruno' }).check();
    await expect(barra).toContainText('2 selecionada(s)');

    await barra.getByRole('button', { name: 'Silenciar', exact: true }).click();
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).is_muted).toBe(true);
    expect((await conversaNoBanco(request, CONVERSAS_DA_INBOX.bruno)).is_muted).toBe(true);
  });

  test('marca lembrete em várias conversas e tira depois', async ({ page, request }) => {
    await abrirInbox(page);
    await expect(nomesNaLista(page).first()).toBeVisible();
    await lista(page).getByRole('button', { name: 'Selecionar' }).click();
    const barra = page.getByRole('region', { name: 'Ações em lote' });
    await lista(page).getByRole('checkbox', { name: 'Selecionar Ana' }).check();
    await lista(page).getByRole('checkbox', { name: 'Selecionar Bruno' }).check();

    const amanha = new Date(Date.now() + 24 * 60 * 60_000).toISOString().slice(0, 16);
    await barra.getByLabel('Lembretes em lote: data e hora do retorno').fill(amanha);
    await barra.getByRole('button', { name: 'Marcar lembrete' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Lembrete marcado em 2 conversas.' })).toBeVisible();
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).follow_up_at).toBeTruthy();

    await lista(page).getByRole('button', { name: 'Selecionar' }).click();
    await lista(page).getByRole('checkbox', { name: 'Selecionar Ana' }).check();
    await barra.getByRole('button', { name: 'Tirar lembrete' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Lembrete tirado de 1 conversa.' })).toBeVisible();
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).follow_up_at).toBeNull();
  });

  test('muda a etapa do funil das conversas escolhidas', async ({ page, request }) => {
    await abrirInbox(page);
    await expect(nomesNaLista(page).first()).toBeVisible();
    await lista(page).getByRole('button', { name: 'Selecionar' }).click();
    const barra = page.getByRole('region', { name: 'Ações em lote' });
    await lista(page).getByRole('checkbox', { name: 'Selecionar Ana' }).check();
    await barra.getByLabel('Mover selecionadas para etapa').selectOption('proposta');
    await expect.poll(async () => (await conversaNoBanco(request, CONVERSAS_DA_INBOX.ana)).crm_stage).toBe('proposta');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Automação das etapas (Kanban)                                                                  */
/* ---------------------------------------------------------------------------------------------- */

test.describe('automação das etapas', () => {
  test('guarda a etiqueta e a mensagem de uma etapa', async ({ page, request }) => {
    await abrirInbox(page, '/inbox?aba=kanban');
    await page.getByRole('button', { name: /Automação das etapas/ }).click();

    const janela = page.getByRole('dialog', { name: 'Automação das etapas' });
    await expect(janela).toBeVisible();
    const etapa = janela.locator('[data-etapa="proposta"]');

    await etapa.getByLabel('Dar uma etiqueta ao contato').check();
    // O cenário já tem etiquetas prontas: a opção 0 é "Escolha a etiqueta".
    const etiqueta = await etapa.getByLabel(/Etiqueta da etapa/).locator('option').nth(1).getAttribute('value');
    expect(etiqueta).toBeTruthy();
    await etapa.getByLabel(/Etiqueta da etapa/).selectOption(etiqueta as string);

    await etapa.getByLabel('Mandar uma mensagem ao cliente').check();
    await etapa.getByLabel(/Mensagem da etapa/).fill('Oi {{nome}}, preparei uma proposta para você.');
    await etapa.getByRole('button', { name: 'Salvar Negociação / Proposta' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'salva.' })).toBeVisible();

    const gravadas = (await (
      await request.get(`${SUPABASE}/controle/automacoes?workspace=${WORKSPACE_INBOX}`)
    ).json()) as Array<{ stage: string; enable_tag: boolean; enable_message: boolean; message_template: string | null }>;
    const proposta = gravadas.find((a) => a.stage === 'proposta');
    expect(proposta, 'a automação da etapa proposta devia estar guardada').toBeTruthy();
    expect(proposta!.enable_tag).toBe(true);
    expect(proposta!.enable_message).toBe(true);
    expect(proposta!.message_template).toContain('{{nome}}');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Contraste do balão nos dois temas                                                              */
/* ---------------------------------------------------------------------------------------------- */

test.describe('leitura confortável nos dois temas', () => {
  test('a hora do balão tem contraste no tema escuro e no claro', async ({ page }) => {
    await abrirInbox(page, `/inbox?c=${CONVERSAS_DA_INBOX.ana}`);
    await conversaCom(page, 'Ana').waitFor();

    for (const tema of ['escuro', 'claro'] as const) {
      if (tema === 'claro') {
        // O botão de tema fica na folha da conta ("Modo claro" / "Modo escuro").
        await page.getByRole('button', { name: /^Conta e preferências/ }).click();
        const folha = page.getByRole('dialog', { name: 'Conta e preferências' });
        await folha.getByRole('button', { name: /Modo claro/ }).click();
        await page.keyboard.press('Escape');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      }

      const contraste = await baloes(page)
        .first()
        .locator('.balao-rodape')
        .evaluate((el) => {
          const cor = getComputedStyle(el).color;
          const fundo = getComputedStyle(el.closest('.balao') as Element).backgroundColor;
          const rgb = (v: string) => (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
          const luminancia = (v: number[]) => {
            const [r, g, b] = v.map((c) => {
              const x = c / 255;
              return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
            }) as [number, number, number];
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const a = luminancia(rgb(cor));
          const b = luminancia(rgb(fundo));
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
      // 4,5:1 é o mínimo para texto pequeno (a hora do balão é 11px).
      expect(contraste, `contraste da hora no tema ${tema}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
