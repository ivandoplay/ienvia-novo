import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { audioDeExemplo, fotoDeExemplo, pdfDeExemplo } from './apoio/arquivos-de-exemplo.mjs';
import { CONVERSAS_DA_INBOX, SEGREDO_DO_AVISO_DO_CHIP_VENDAS, WORKSPACE_INBOX } from './apoio/dados.mjs';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * A Inbox, do começo ao fim, contra o Supabase e a Evolution de mentira.
 *
 * O cenário (e2e/apoio/dados.mjs, "Empresa da Inbox") volta ao começo antes de cada teste:
 *   Ana (nova, 2 não lidas) · Bruno (com você, 1 não lida) · Carla (nova, chip desconectado) ·
 *   um contato sem nome (aguardando o cliente) · Elisa (o número não tem WhatsApp) ·
 *   Fábio (a Evolution dá erro) · Diego e Gabi (resolvidas; a da Gabi é de um chip removido) ·
 *   Helena (aguardando o cliente; a conversa dos arquivos: foto, áudio, documento, figurinha...).
 */
const SUPABASE = 'http://127.0.0.1:54399';
const EVOLUTION = 'http://127.0.0.1:54398';
const SEM_NOME = '+55 (11) 97777-0003';

interface Envio {
  instancia: string;
  numero: string;
  texto: string;
}

/** Um arquivo que saiu pela Evolution. */
interface EnvioDeArquivo {
  instancia: string;
  numero: string;
  tipo: string;
  legenda: string | null;
  nome: string | null;
  conteudo: string | null;
  bytes: number;
}

const enviadasPelaEvolution = async (request: APIRequestContext) =>
  (await (await request.get(`${EVOLUTION}/controle/enviadas?prefixo=ienvia-fixo`)).json()) as Envio[];
const tentativasNaEvolution = async (request: APIRequestContext) =>
  (await (await request.get(`${EVOLUTION}/controle/tentativas?prefixo=ienvia-fixo`)).json()) as Envio[];
const arquivosEnviadosPelaEvolution = async (request: APIRequestContext) =>
  (await (await request.get(`${EVOLUTION}/controle/enviadas?prefixo=ienvia-fixo`)).json()) as EnvioDeArquivo[];
/** As vezes em que o painel pediu à Evolution o arquivo de uma mensagem recebida. */
const buscasNaEvolution = async (request: APIRequestContext) =>
  (await (await request.get(`${EVOLUTION}/controle/buscas?prefixo=ienvia-fixo`)).json()) as Array<{ instancia: string; id: string; comAMensagemInteira: boolean }>;

/** Uma mensagem do jeito que está guardada no "banco", com a ficha do arquivo dela. */
interface MensagemGuardada {
  body_text: string | null;
  status: string;
  direction: string;
  provider_message_id: string | null;
  arquivo: { tipo: string; situacao: string; nome: string | null; conteudo: string; tamanho: number; caminho: string; guardado: boolean } | null;
}
const mensagensGuardadas = async (request: APIRequestContext, conversa: string) =>
  (await (await request.get(`${SUPABASE}/controle/mensagens?conversa=${conversa}`)).json()) as MensagemGuardada[];
/** O que está no depósito de arquivos, na pasta de envios de uma conversa. */
const enviosNoDeposito = async (request: APIRequestContext, conversa: string) =>
  (await (await request.get(`${SUPABASE}/controle/arquivos?prefixo=${WORKSPACE_INBOX}/${conversa}/envios/`)).json()) as Array<{ caminho: string; tamanho: number; conteudo: string }>;

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
const anexoNoCampo = (page: Page) => page.getByRole('group', { name: 'Arquivo anexado' });

/** Escolhe um arquivo no "clipe", como a pessoa faria na janela de arquivos do computador ou do celular. */
const anexar = (page: Page, nome: string, tipo: string, dados: Buffer) =>
  page.getByTestId('arquivo-para-enviar').setInputFiles({ name: nome, mimeType: tipo, buffer: dados });

/** O mesmo, para arquivos grandes: o arquivo é criado dentro da página (só zeros), sem viajar pelo teste. */
const anexarArquivoGrande = (page: Page, nome: string, tipo: string, bytes: number) =>
  page.getByTestId('arquivo-para-enviar').evaluate(
    (entrada, arquivo) => {
      const dados = new DataTransfer();
      dados.items.add(new File([new Uint8Array(arquivo.bytes)], arquivo.nome, { type: arquivo.tipo }));
      (entrada as HTMLInputElement).files = dados.files;
      entrada.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { nome, tipo, bytes },
  );

/** Um aviso da Evolution chega ao painel pela porta de verdade (a mesma que a Evolution usa). */
function evolutionAvisa(request: APIRequestContext, id: string, mensagem: Record<string, unknown>, numero = '5585988880009') {
  return request.post('/api/webhooks/evolution', {
    headers: { authorization: `Bearer ${SEGREDO_DO_AVISO_DO_CHIP_VENDAS}` },
    data: {
      event: 'messages.upsert',
      instance: 'ienvia-fixo-vendas',
      data: {
        key: { remoteJid: `${numero}@s.whatsapp.net`, fromMe: false, id },
        pushName: 'Helena Castro',
        message: mensagem,
        messageType: Object.keys(mensagem)[0],
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    },
  });
}

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
  await request.delete(`${EVOLUTION}/controle/buscas`);
});

test.describe('Inbox — lista de conversas', () => {
  test('mostra as conversas em aberto, da mais recente para a mais antiga, com as não lidas em destaque', async ({ page }) => {
    await abrirInbox(page);

    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    await expect(nomesNaLista(page)).toHaveText(['Ana Souza', 'Bruno Lima', 'Carla Dias', SEM_NOME, 'Elisa Prado', 'Fábio Nunes', 'Helena Castro']);
    await expect(lista(page)).toContainText('7 conversas');

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
    await expect(nomesNaLista(page)).toHaveCount(7);
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
    await expect(nomesNaLista(page)).toHaveCount(7);
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
    await expect(nomesNaLista(page)).toHaveCount(6);
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

test.describe('Inbox — arquivos (fotos, áudios, vídeos, documentos e figurinhas)', () => {
  const MB = 1024 * 1024;

  test('a conversa mostra foto, áudio, documento e figurinha, e explica o que não dá para mostrar', async ({ page }) => {
    await abrirInbox(page);
    // Na lista, a última mensagem aparece pelo tipo do arquivo e a legenda.
    await expect(lista(page).getByRole('link', { name: /Helena Castro/ })).toContainText('📷 Foto: Nossa fachada nova');

    await abrirConversa(page, /Helena Castro/, 'Helena Castro');
    const conversa = conversaCom(page, 'Helena Castro');
    await expect(baloes(page)).toHaveCount(7);

    // Foto recebida, com a legenda embaixo. A imagem carrega de verdade, vinda do depósito fechado.
    const foto = conversa.getByRole('button', { name: 'Abrir a foto: Olha a vitrine como ficou' });
    await foto.scrollIntoViewIfNeeded();
    await expect(baloes(page).first()).toContainText('Olha a vitrine como ficou');
    await expect.poll(() => foto.locator('img').evaluate((imagem) => (imagem as HTMLImageElement).naturalWidth)).toBe(480);

    // Mensagem de voz: um tocador, com a duração e o tamanho ao lado.
    const audio = conversa.locator('audio');
    await expect(audio).toHaveCount(1);
    await expect(audio).toHaveAttribute('aria-label', /^Mensagem de voz · 0:03 · \d+ KB$/);
    // Se o navegador não souber tocar, dá para baixar.
    await expect(conversa.getByRole('link', { name: 'Baixar o áudio' })).toHaveAttribute('href', /\/api\/inbox\/midia\/.+\?baixar=audio-\d{4}-\d{2}-\d{2}-\d{4}\.wav$/);
    const duracao = await audio.evaluate(
      (som) =>
        new Promise<number>((pronto, falhou) => {
          const tocador = som as HTMLAudioElement;
          tocador.addEventListener('loadedmetadata', () => pronto(tocador.duration), { once: true });
          tocador.addEventListener('error', () => falhou(new Error('o áudio não carregou')), { once: true });
          tocador.load();
        }),
    );
    expect(Math.round(duracao)).toBe(3);

    // Documento enviado pelo painel: o nome que a pessoa conhece, e baixa com esse mesmo nome.
    const documento = conversa.getByRole('link', { name: /Tabela de preços\.pdf/ });
    await expect(documento).toContainText(/Baixar · \d+ B|Baixar · \d+ KB/);
    const baixado = await page.request.get(String(await documento.getAttribute('href')));
    expect(baixado.status()).toBe(200);
    expect(baixado.headers()['content-type']).toBe('application/pdf');
    expect(baixado.headers()['content-disposition']).toBe("attachment; filename*=UTF-8''Tabela%20de%20pre%C3%A7os.pdf");
    expect((await baixado.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Figurinha.
    await expect(conversa.getByRole('img', { name: 'Figurinha' })).toBeVisible();

    // O que o painel não tem para mostrar vem com a explicação e, quando dá, com o que fazer.
    await expect(conversa).toContainText('Este vídeo é grande demais para o painel guardar (40,0 MB). Veja no celular do chip.');
    await expect(conversa).toContainText('O painel não conseguiu trazer esta foto do WhatsApp.');
    await expect(conversa.getByRole('button', { name: 'Buscar de novo' })).toHaveCount(1);

    // Foto enviada pelo painel.
    await expect(conversa.getByRole('button', { name: 'Abrir a foto: Nossa fachada nova' })).toBeVisible();

    // Nada estoura a largura da tela (no celular, principalmente).
    const sobra = await page.getByRole('log', { name: 'Mensagens da conversa' }).evaluate((area) => area.scrollWidth - area.clientWidth);
    expect(sobra).toBeLessThanOrEqual(1);
  });

  test('abrir a foto em tamanho maior, baixar e fechar', async ({ page }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    const botao = conversaCom(page, 'Helena Castro').getByRole('button', { name: 'Abrir a foto: Olha a vitrine como ficou' });
    await botao.click();

    const janela = page.getByRole('dialog', { name: 'Foto' });
    await expect(janela).toBeVisible();
    await expect(janela.getByRole('img', { name: 'Foto: Olha a vitrine como ficou' })).toBeVisible();
    await expect(janela).toContainText('Olha a vitrine como ficou');
    // A foto cabe na tela, sem a janela precisar rolar para os lados.
    const caixa = await janela.getByRole('img').boundingBox();
    const tela = page.viewportSize();
    expect(caixa && tela && caixa.x >= 0 && caixa.x + caixa.width <= tela.width).toBe(true);

    // Baixa com um nome que diz o que é e de quando é (a foto não tem nome próprio).
    const baixar = janela.getByRole('link', { name: 'Baixar a foto' });
    await expect(baixar).toHaveAttribute('href', /\/api\/inbox\/midia\/.+\?baixar=foto-\d{4}-\d{2}-\d{2}-\d{4}\.png$/);
    const baixado = await page.request.get(String(await baixar.getAttribute('href')));
    expect(baixado.headers()['content-type']).toBe('image/png');
    expect(baixado.headers()['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''foto-[\d-]+\.png$/);

    await page.keyboard.press('Escape');
    await expect(janela).toHaveCount(0);
    // O foco volta para a foto que abriu a janela.
    await expect(botao).toBeFocused();
  });

  test('"Buscar de novo" traz do WhatsApp a foto que não tinha vindo', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    const conversa = conversaCom(page, 'Helena Castro');
    await expect(conversa.getByRole('button', { name: 'Abrir a foto', exact: true })).toHaveCount(0);

    await conversa.getByRole('button', { name: 'Buscar de novo' }).click();

    await expect(conversa.getByRole('button', { name: 'Abrir a foto', exact: true })).toBeVisible();
    await expect(conversa.getByRole('button', { name: 'Buscar de novo' })).toHaveCount(0);
    await expect(conversa).not.toContainText('O painel não conseguiu trazer esta foto do WhatsApp.');

    // O painel pediu à Evolution uma vez só, pela identificação da mensagem, e guardou o que veio.
    expect(await buscasNaEvolution(request)).toMatchObject([{ instancia: 'ienvia-fixo-vendas', comAMensagemInteira: false }]);
    const guardadas = await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena);
    expect(guardadas.filter((mensagem) => mensagem.arquivo?.situacao === 'failed')).toHaveLength(0);
    expect(guardadas.filter((mensagem) => mensagem.arquivo && mensagem.arquivo.situacao === 'stored' && !mensagem.arquivo.guardado)).toHaveLength(0);
  });

  test('enviar uma foto com legenda', async ({ page, request, isMobile }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    const foto = fotoDeExemplo({ tom: 'tarde', largura: 640, altura: 480 });

    await expect(page.getByRole('button', { name: 'Anexar arquivo' })).toBeVisible();
    await anexar(page, 'Promoção de verão.png', 'image/png', foto);

    // Antes de enviar, a pessoa vê o que anexou e como vai chegar.
    await expect(anexoNoCampo(page)).toContainText('Promoção de verão.png');
    await expect(anexoNoCampo(page)).toContainText('Vai como foto');
    // O campo de texto passa a ser a legenda, e já fica com o cursor.
    const legenda = page.getByLabel('Legenda do arquivo');
    await expect(legenda).toBeFocused();
    await expect(legenda).toHaveAttribute('placeholder', 'Legenda (opcional)');
    await legenda.fill('Olha a promoção!');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();

    const balao = baloes(page).last();
    await expect(balao).toContainText('Olha a promoção!');
    await expect(balao).toContainText('Enviada');
    const naConversa = balao.getByRole('button', { name: 'Abrir a foto: Olha a promoção!' });
    await expect(naConversa).toBeVisible();
    await expect.poll(() => naConversa.locator('img').evaluate((imagem) => (imagem as HTMLImageElement).naturalWidth)).toBe(640);
    await expect(baloes(page)).toHaveCount(8);

    // O campo volta ao normal, vazio e sem anexo.
    await expect(anexoNoCampo(page)).toHaveCount(0);
    await expect(campoDeMensagem(page)).toHaveValue('');
    await expect(etapaNoTopo(page)).toHaveText('Aguardando o cliente');

    // Saiu pelo chip certo, para o número certo, uma vez só, com o arquivo inteiro.
    expect(await arquivosEnviadosPelaEvolution(request)).toMatchObject([
      { instancia: 'ienvia-fixo-vendas', numero: '5585988880009', tipo: 'image', legenda: 'Olha a promoção!', nome: null, bytes: foto.length },
    ]);
    expect(await tentativasNaEvolution(request)).toHaveLength(1);

    // Ficou guardado: a mensagem com a ficha do arquivo, e o arquivo no depósito, na pasta de envios da conversa.
    const guardada = (await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).at(-1);
    expect(guardada).toMatchObject({
      body_text: 'Olha a promoção!',
      status: 'sent',
      direction: 'outbound',
      arquivo: { tipo: 'image', situacao: 'stored', conteudo: 'image/png', tamanho: foto.length, guardado: true },
    });
    expect(guardada?.provider_message_id).toMatch(/^3EB0/);
    const noDeposito = await enviosNoDeposito(request, CONVERSAS_DA_INBOX.helena);
    expect(noDeposito.filter((arquivo) => arquivo.caminho.endsWith('/Promocao-de-verao.png'))).toMatchObject([{ tamanho: foto.length, conteudo: 'image/png' }]);

    // Na lista, a conversa passa a mostrar a foto como última mensagem.
    await verALista(page, isMobile);
    await expect(lista(page).getByRole('link', { name: /Helena Castro/ })).toContainText('📷 Foto: Olha a promoção!');
  });

  test('enviar um documento, com o nome que a pessoa conhece', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    const pdf = pdfDeExemplo(['Orcamento 12', 'Total ........ R$ 480,00']);

    await anexar(page, 'Orçamento nº 12.pdf', 'application/pdf', pdf);
    await expect(anexoNoCampo(page)).toContainText('Orçamento nº 12.pdf');
    await expect(anexoNoCampo(page)).toContainText('Vai como documento');
    await page.getByLabel('Legenda do arquivo').fill('Segue o orçamento.');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();

    const balao = baloes(page).last();
    await expect(balao).toContainText('Enviada');
    await expect(balao).toContainText('Segue o orçamento.');
    await expect(balao.getByRole('link', { name: /Orçamento nº 12\.pdf/ })).toHaveAttribute('href', /baixar=Or%C3%A7amento%20n%C2%BA%2012\.pdf$/);

    expect(await arquivosEnviadosPelaEvolution(request)).toMatchObject([
      { numero: '5585988880009', tipo: 'document', legenda: 'Segue o orçamento.', nome: 'Orçamento nº 12.pdf', conteudo: 'application/pdf', bytes: pdf.length },
    ]);
    expect((await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).at(-1)).toMatchObject({
      status: 'sent',
      arquivo: { tipo: 'document', situacao: 'stored', nome: 'Orçamento nº 12.pdf', conteudo: 'application/pdf', guardado: true },
    });
  });

  test('enviar um áudio: vai como mensagem de voz, sem legenda, e o que estava escrito fica para depois', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    const audio = audioDeExemplo(2);

    await campoDeMensagem(page).fill('Escuta este recado');
    await anexar(page, 'recado.wav', 'audio/wav', audio);
    await expect(anexoNoCampo(page)).toContainText('recado.wav');
    await expect(anexoNoCampo(page)).toContainText('Vai como mensagem de voz, sem legenda');
    // Com um áudio anexado, o campo de texto fica só para ler: o WhatsApp não aceita legenda em áudio.
    const campo = page.getByLabel('Mensagem (o áudio vai sem legenda)');
    await expect(campo).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();

    const balao = baloes(page).last();
    await expect(balao).toContainText('Enviada');
    await expect(balao.locator('audio')).toHaveAttribute('aria-label', /^Mensagem de voz · 0:02 · /);
    await expect(balao).not.toContainText('Escuta este recado');

    expect(await arquivosEnviadosPelaEvolution(request)).toMatchObject([{ numero: '5585988880009', tipo: 'audio', legenda: null, bytes: audio.length }]);
    expect((await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).at(-1)).toMatchObject({
      body_text: null,
      status: 'sent',
      arquivo: { tipo: 'audio', situacao: 'stored', conteudo: 'audio/wav', guardado: true },
    });

    // O texto continua no campo e sai em seguida, como mensagem comum.
    await expect(campoDeMensagem(page)).toHaveValue('Escuta este recado');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(baloes(page).last()).toContainText('Escuta este recado');
    await expect(baloes(page).last()).toContainText('Enviada');
    expect(await tentativasNaEvolution(request)).toHaveLength(2);
  });

  test('tirar o anexo antes de enviar; arquivo vazio e arquivo grande demais são recusados na hora', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    const erro = page.locator('.inbox-anexo-erro');

    await anexar(page, 'vazio.txt', 'text/plain', Buffer.alloc(0));
    await expect(erro).toHaveText('Este arquivo está vazio.');
    await expect(anexoNoCampo(page)).toHaveCount(0);

    await anexarArquivoGrande(page, 'backup.zip', 'application/zip', 26 * MB);
    await expect(erro).toHaveText('Este arquivo tem 26,0 MB. O painel envia arquivos de até 25,0 MB.');
    await expect(anexoNoCampo(page)).toHaveCount(0);
    // Sem anexo e sem texto, não há o que enviar.
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeDisabled();

    // Um arquivo bom limpa o erro; e dá para desistir dele antes de enviar.
    await anexar(page, 'Catálogo.pdf', 'application/pdf', pdfDeExemplo());
    await expect(erro).toHaveCount(0);
    await expect(anexoNoCampo(page)).toContainText('Catálogo.pdf');
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeEnabled();
    await anexoNoCampo(page).getByRole('button', { name: 'Remover o anexo' }).click();
    await expect(anexoNoCampo(page)).toHaveCount(0);
    await expect(campoDeMensagem(page)).toBeFocused();

    // Nada subiu e nada saiu (os dois arquivos que já estavam na pasta de envios são os da conversa de exemplo).
    expect(await enviosNoDeposito(request, CONVERSAS_DA_INBOX.helena)).toHaveLength(2);
    expect(await tentativasNaEvolution(request)).toHaveLength(0);
    await expect(baloes(page)).toHaveCount(7);
  });

  test('vídeo acima de 16 MB: o painel avisa que vai como documento, e ele chega inteiro', async ({ page, request, isMobile }) => {
    test.skip(isMobile, 'Arquivo pesado: basta conferir uma vez, no computador.');
    test.setTimeout(90_000);
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);

    await anexarArquivoGrande(page, 'inauguração.mp4', 'video/mp4', 17 * MB);
    await expect(anexoNoCampo(page)).toContainText('17,0 MB');
    await expect(anexoNoCampo(page)).toContainText('Passa de 16,0 MB: vai como documento');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();

    const balao = baloes(page).last();
    await expect(balao).toContainText('Enviada', { timeout: 60_000 });
    await expect(balao.getByRole('link', { name: /inauguração\.mp4/ })).toContainText('Baixar · 17,0 MB');

    expect(await arquivosEnviadosPelaEvolution(request)).toMatchObject([{ tipo: 'document', nome: 'inauguração.mp4', bytes: 17 * MB }]);
    expect((await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).at(-1)).toMatchObject({
      status: 'sent',
      arquivo: { tipo: 'document', situacao: 'stored', conteudo: 'video/mp4', tamanho: 17 * MB, guardado: true },
    });
  });

  test('se o arquivo não sobe, nada é enviado; "Tentar de novo" envia uma vez só', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    await request.post(`${SUPABASE}/controle/falha-ao-subir?vezes=1`);
    const foto = fotoDeExemplo();

    await anexar(page, 'vitrine.png', 'image/png', foto);
    await page.getByLabel('Legenda do arquivo').fill('Vitrine nova');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();

    const balao = baloes(page).last();
    await expect(balao).toContainText('Não enviada');
    await expect(balao.getByRole('alert')).toContainText('O arquivo não subiu. Confira a internet e tente de novo.');
    // A foto e a legenda continuam à vista, para a pessoa saber do que se trata.
    await expect(balao.getByRole('img', { name: 'Foto vitrine.png' })).toBeVisible();
    await expect(balao).toContainText('Vitrine nova');
    expect(await tentativasNaEvolution(request)).toHaveLength(0);
    expect(await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).toHaveLength(7);

    await balao.getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(baloes(page).last()).toContainText('Enviada');
    await expect(baloes(page).last().getByRole('button', { name: 'Abrir a foto: Vitrine nova' })).toBeVisible();
    await expect(baloes(page)).toHaveCount(8);

    expect(await arquivosEnviadosPelaEvolution(request)).toMatchObject([{ tipo: 'image', legenda: 'Vitrine nova', bytes: foto.length }]);
    expect(await tentativasNaEvolution(request)).toHaveLength(1);
    expect(await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).toHaveLength(8);
  });

  test('desistir de um envio que não subiu tira o balão da conversa', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    await request.post(`${SUPABASE}/controle/falha-ao-subir?vezes=1`);

    await anexar(page, 'Catálogo.pdf', 'application/pdf', pdfDeExemplo());
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    const balao = baloes(page).last();
    await expect(balao).toContainText('Catálogo.pdf');
    await expect(balao).toContainText('Não enviada');

    await balao.getByRole('button', { name: 'Descartar' }).click();
    await expect(baloes(page)).toHaveCount(7);
    expect(await tentativasNaEvolution(request)).toHaveLength(0);
    expect(await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).toHaveLength(7);
  });

  test('número sem WhatsApp: o arquivo fica como não enviado, com o motivo', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.elisa}`);
    await anexar(page, 'Catálogo.pdf', 'application/pdf', pdfDeExemplo());
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();

    const conversa = conversaCom(page, 'Elisa Prado');
    await expect(conversa.locator('.inbox-aviso')).toContainText('A mensagem não foi enviada: este número não tem WhatsApp.');
    const balao = baloes(page).last();
    await expect(balao).toContainText('Catálogo.pdf');
    await expect(balao).toContainText('Não enviada');
    await expect(balao).toContainText('Este arquivo não foi enviado. Para tentar de novo, anexe o arquivo outra vez.');
    expect(await arquivosEnviadosPelaEvolution(request)).toHaveLength(0);
    expect(await tentativasNaEvolution(request)).toHaveLength(1);
  });

  test('sem confirmação: o arquivo não é reenviado sozinho; a pessoa confere e decide', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.fabio}`);
    await anexar(page, 'vitrine.png', 'image/png', fotoDeExemplo());
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();

    const balao = baloes(page).last();
    await expect(balao).toContainText('Sem confirmação');
    await page.waitForTimeout(1_500);
    expect(await tentativasNaEvolution(request)).toHaveLength(1);

    await balao.getByRole('button', { name: 'Foi enviada', exact: true }).click();
    await expect(balao).not.toContainText('Sem confirmação');
    await expect(balao).toContainText('Enviada');
    expect(await tentativasNaEvolution(request)).toHaveLength(1);
  });

  test('colar um print ou arrastar um arquivo para o campo também anexa', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Colar e arrastar arquivos é coisa de computador.');
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);

    // Colar (Ctrl+V) um print.
    await campoDeMensagem(page).evaluate(
      (campo, bytes) => {
        const dados = new DataTransfer();
        dados.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
        campo.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dados, bubbles: true, cancelable: true }));
      },
      [...fotoDeExemplo({ largura: 64, altura: 48 })],
    );
    await expect(anexoNoCampo(page)).toContainText('image.png');
    await expect(anexoNoCampo(page)).toContainText('Vai como foto');
    await anexoNoCampo(page).getByRole('button', { name: 'Remover o anexo' }).click();
    await expect(anexoNoCampo(page)).toHaveCount(0);

    // Arrastar um arquivo para cima do campo.
    const arrastado = await page.evaluateHandle(
      (bytes) => {
        const dados = new DataTransfer();
        dados.items.add(new File([new Uint8Array(bytes)], 'Catálogo.pdf', { type: 'application/pdf' }));
        return dados;
      },
      [...pdfDeExemplo()],
    );
    const formulario = page.locator('form.inbox-escrever');
    await formulario.dispatchEvent('dragover', { dataTransfer: arrastado });
    await expect(formulario).toHaveClass(/inbox-escrever--soltando/);
    await formulario.dispatchEvent('drop', { dataTransfer: arrastado });
    await expect(formulario).not.toHaveClass(/inbox-escrever--soltando/);
    await expect(anexoNoCampo(page)).toContainText('Catálogo.pdf');
    await expect(anexoNoCampo(page)).toContainText('Vai como documento');
  });

  test('chegam pelo WhatsApp uma foto, um áudio, um documento e um vídeo: aparecem sozinhos na conversa aberta', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    const conversa = conversaCom(page, 'Helena Castro');
    await expect(baloes(page)).toHaveCount(7);
    const carimbo = Date.now();

    // Foto com legenda. O aviso da Evolution traz só a "ficha" do arquivo; o painel responde na hora e busca o arquivo depois.
    const aviso = await evolutionAvisa(request, `E2E-FOTO-${carimbo}`, {
      imageMessage: { caption: 'Chegou o pedido!', mimetype: 'image/jpeg', fileLength: '182000', width: 480, height: 360, mediaKey: 'chave-de-teste', directPath: '/v/t62/teste' },
    });
    expect(aviso.status()).toBe(200);
    expect(await aviso.json()).toEqual({ ok: true, resultado: 'accepted' });

    const foto = conversa.getByRole('button', { name: 'Abrir a foto: Chegou o pedido!' });
    await expect(foto).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => foto.locator('img').evaluate((imagem) => (imagem as HTMLImageElement).naturalWidth)).toBe(480);
    await expect(etapaNoTopo(page)).toHaveText('Com você');

    // Mensagem de voz.
    expect((await evolutionAvisa(request, `E2E-AUDIO-${carimbo}`, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 2, ptt: true, fileLength: '9000' } })).status()).toBe(200);
    await expect(conversa.locator('audio')).toHaveCount(2, { timeout: 20_000 });
    await expect(conversa.locator('audio').last()).toHaveAttribute('aria-label', /^Mensagem de voz · 0:02 · /);

    // Documento, com o nome que o cliente deu.
    expect(
      (await evolutionAvisa(request, `E2E-DOC-${carimbo}`, { documentMessage: { fileName: 'Pedido 123.pdf', mimetype: 'application/pdf', fileLength: '700', caption: 'Meu pedido' } })).status(),
    ).toBe(200);
    const documento = conversa.getByRole('link', { name: /Pedido 123\.pdf/ });
    await expect(documento).toBeVisible({ timeout: 20_000 });
    await expect(baloes(page).last()).toContainText('Meu pedido');
    await expect(baloes(page)).toHaveCount(10);

    // Vídeo com legenda: um tocador que só carrega quando a pessoa aperta, e o link para baixar.
    expect(
      (await evolutionAvisa(request, `E2E-VIDEO-${carimbo}`, { videoMessage: { mimetype: 'video/mp4', seconds: 12, fileLength: '2048', caption: 'A fachada nova', width: 360, height: 640 } })).status(),
    ).toBe(200);
    const video = conversa.locator('video');
    await expect(video).toHaveCount(1, { timeout: 20_000 });
    await expect(video).toHaveAttribute('aria-label', 'Vídeo: A fachada nova');
    await expect(video).toHaveAttribute('preload', 'none');
    await expect(video).toHaveAttribute('src', /\/api\/inbox\/midia\/.+\/video$/);
    await expect(baloes(page).last()).toContainText('A fachada nova');
    await expect(baloes(page).last()).toContainText(/Vídeo · 0:12 · /);
    await expect(conversa.getByRole('link', { name: 'Baixar o vídeo' })).toHaveAttribute('href', /\/api\/inbox\/midia\/.+\?baixar=video-\d{4}-\d{2}-\d{2}-\d{4}\.mp4$/);
    await expect(conversa.getByRole('link', { name: 'Baixar o áudio' })).toHaveCount(2);
    await expect(baloes(page)).toHaveCount(11);

    // O painel pediu cada arquivo à Evolution uma vez, mandando o aviso inteiro, e guardou os quatro.
    expect(await buscasNaEvolution(request)).toEqual([
      { instancia: 'ienvia-fixo-vendas', id: `E2E-FOTO-${carimbo}`, comAMensagemInteira: true },
      { instancia: 'ienvia-fixo-vendas', id: `E2E-AUDIO-${carimbo}`, comAMensagemInteira: true },
      { instancia: 'ienvia-fixo-vendas', id: `E2E-DOC-${carimbo}`, comAMensagemInteira: true },
      { instancia: 'ienvia-fixo-vendas', id: `E2E-VIDEO-${carimbo}`, comAMensagemInteira: true },
    ]);
    const novas = (await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).slice(-4);
    expect(novas).toMatchObject([
      { body_text: 'Chegou o pedido!', direction: 'inbound', arquivo: { tipo: 'image', situacao: 'stored', guardado: true } },
      { body_text: null, direction: 'inbound', arquivo: { tipo: 'audio', situacao: 'stored', guardado: true } },
      { body_text: 'Meu pedido', direction: 'inbound', arquivo: { tipo: 'document', situacao: 'stored', nome: 'Pedido 123.pdf', guardado: true } },
      { body_text: 'A fachada nova', direction: 'inbound', arquivo: { tipo: 'video', situacao: 'stored', guardado: true } },
    ]);

    // O mesmo aviso repetido (a Evolution reenvia quando acha que não foi entregue) não duplica nada.
    const repetido = await evolutionAvisa(request, `E2E-FOTO-${carimbo}`, { imageMessage: { caption: 'Chegou o pedido!', mimetype: 'image/jpeg', fileLength: '182000' } });
    expect(await repetido.json()).toEqual({ ok: true, resultado: 'duplicate' });
    expect(await buscasNaEvolution(request)).toHaveLength(4);
    expect(await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena)).toHaveLength(11);
  });

  test('chega um arquivo que a Evolution não consegue entregar: a conversa explica e "Buscar de novo" responde com clareza', async ({ page, request }) => {
    await abrirInbox(page, 'inbox', `/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
    const conversa = conversaCom(page, 'Helena Castro');
    await expect(baloes(page)).toHaveCount(7);

    const aviso = await evolutionAvisa(request, `E2E-${Date.now()}-SEM-ARQUIVO`, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 7, ptt: true, fileLength: '15000' } });
    expect(aviso.status()).toBe(200);

    const balao = baloes(page).last();
    await expect(balao).toContainText('O painel não conseguiu trazer este áudio do WhatsApp.', { timeout: 20_000 });
    await expect(baloes(page)).toHaveCount(8);

    await balao.getByRole('button', { name: 'Buscar de novo' }).click();
    await expect(conversa.locator('.inbox-aviso')).toContainText(
      'Não foi possível trazer este arquivo do WhatsApp agora. Confira se o chip está conectado e tente de novo; ele continua no celular.',
    );
    // O botão continua lá, para tentar mais tarde.
    await expect(balao.getByRole('button', { name: 'Buscar de novo' })).toBeEnabled();
    // Duas buscas: a de quando a mensagem chegou e a que a pessoa pediu.
    expect(await buscasNaEvolution(request)).toMatchObject([{ comAMensagemInteira: true }, { comAMensagemInteira: false }]);
  });

  test('arquivo de uma empresa não abre para quem é de outra, nem para quem não fez login', async ({ page, request }) => {
    const guardadas = await mensagensGuardadas(request, CONVERSAS_DA_INBOX.helena);
    const caminho = guardadas.find((mensagem) => mensagem.arquivo?.tipo === 'image' && mensagem.arquivo.guardado)?.arquivo?.caminho;
    expect(caminho).toMatch(new RegExp(`^${WORKSPACE_INBOX}/${CONVERSAS_DA_INBOX.helena}/`));
    const endereco = `/api/inbox/midia/${caminho}`;

    // Sem login: igual a um arquivo que não existe.
    const semLogin = await request.get(endereco, { maxRedirects: 0 });
    expect(semLogin.status()).toBe(404);
    expect(semLogin.headers().location).toBeUndefined();

    // Quem participa da empresa recebe um endereço assinado do depósito, e o arquivo abre.
    await entrar(page, 'inbox');
    const daEmpresa = await page.request.get(endereco, { maxRedirects: 0 });
    expect(daEmpresa.status()).toBe(302);
    expect(daEmpresa.headers().location).toMatch(/^http:\/\/127\.0\.0\.1:54399\/storage\/v1\/object\/sign\/midias\/.+\?token=.+/);
    const aberto = await page.request.get(endereco);
    expect(aberto.status()).toBe(200);
    expect(aberto.headers()['content-type']).toBe('image/png');

    // Outra pessoa, de outra empresa, com login válido: "não encontrado".
    await page.context().clearCookies();
    await entrar(page, 'dona');
    const deFora = await page.request.get(endereco, { maxRedirects: 0 });
    expect(deFora.status()).toBe(404);
    expect(deFora.headers().location).toBeUndefined();

    // E um caminho fora do formato nem chega ao depósito.
    expect((await page.request.get(`/api/inbox/midia/${WORKSPACE_INBOX}/..%2F..%2Fsegredo`, { maxRedirects: 0 })).status()).toBe(404);
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
      await expect(nomesNaLista(page)).toHaveCount(7);
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

  for (const tema of ['escuro', 'claro'] as const) {
    test(`conversa com arquivos, arquivo anexado e foto aberta, tema ${tema}`, async ({ page }) => {
      await entrar(page, 'inbox');
      if (tema === 'claro') await ligarTemaClaro(page);

      await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.helena}`);
      await expect(baloes(page)).toHaveCount(7);
      expect(await problemasGraves(page)).toEqual([]);

      // Um arquivo recusado (o aviso em vermelho) e, depois, um arquivo anexado.
      await anexar(page, 'vazio.txt', 'text/plain', Buffer.alloc(0));
      await expect(page.locator('.inbox-anexo-erro')).toBeVisible();
      expect(await problemasGraves(page)).toEqual([]);
      await anexar(page, 'Orçamento nº 12.pdf', 'application/pdf', pdfDeExemplo());
      await expect(anexoNoCampo(page)).toBeVisible();
      expect(await problemasGraves(page)).toEqual([]);

      await conversaCom(page, 'Helena Castro').getByRole('button', { name: 'Abrir a foto: Olha a vitrine como ficou' }).click();
      await expect(page.getByRole('dialog', { name: 'Foto' })).toBeVisible();
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
