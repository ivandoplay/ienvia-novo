import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

/**
 * Tela "Treinamento", do começo ao fim, contra o Supabase de mentira.
 *
 * A "Empresa da Inbox" (usuário "inbox") começa com duas bases: a Principal (padrão; loja Flor de Sal Moda,
 * atendente Lia, 3 perguntas frequentes e 1 arquivo) e a de Suporte (sem perguntas nem arquivos, usada pelo chip Suporte).
 * A "Loja da Maria" (usuário "dona") começa sem treinamento nenhum.
 */
const SUPABASE = 'http://127.0.0.1:54399';

const comecarDoZero = (request: APIRequestContext) => request.post(`${SUPABASE}/controle/reiniciar-ia`);

async function abrirTreinamento(page: Page, usuario = 'inbox') {
  await entrar(page, usuario);
  await page.goto('/treinamento');
  await expect(page.getByRole('heading', { name: 'Treinamento', level: 1 })).toBeVisible();
}

const bases = (page: Page) => page.getByRole('navigation', { name: 'Bases de treinamento' });
const aba = (page: Page, nome: string | RegExp) => page.getByRole('tab', { name: nome });
const salvar = (page: Page) => page.getByRole('button', { name: 'Salvar treinamento' });
const barraDeSalvar = (page: Page) => page.locator('.barra-de-salvar-recado');
const arquivos = (page: Page) => page.getByRole('list', { name: 'Arquivos anexados' });
const recadoDosArquivos = (page: Page) => page.locator('#treino-painel-arquivos').getByRole('status');

/** Escolhe um arquivo e manda anexar, como a pessoa faria na janela de arquivos do computador. */
async function anexar(page: Page, nome: string, tipo: string, dados: Buffer) {
  await page.getByLabel('Arquivo para anexar').setInputFiles({ name: nome, mimeType: tipo, buffer: dados });
  await page.getByRole('button', { name: 'Anexar arquivo' }).click();
}

test.describe('Treinamento', () => {
  test.beforeEach(async ({ request }) => {
    await comecarDoZero(request);
  });

  test('abre a base padrão, com as partes do treinamento e o aviso de onde ele vale', async ({ page }) => {
    await abrirTreinamento(page);
    await expect(page).toHaveTitle('Treinamento · Ienvia');
    await expect(page.getByText('2 bases de treinamento')).toBeVisible();
    await expect(page.locator('.pilha-de-avisos .aviso').first()).toContainText('A IA usa este treinamento nas conversas dos chips que estão com ela ligada');

    // As duas bases; a aberta é a padrão.
    await expect(bases(page).locator('.treino-base')).toHaveText([/^Principal\s*padrão\s*3 perguntas · 1 arquivo$/i, /^Suporte\s*0 perguntas · 0 arquivos$/]);
    await expect(bases(page).locator('[aria-current="page"]')).toContainText('Principal');

    await expect(page.getByRole('tab')).toHaveText(['Identidade', 'Regras', 'Perguntas frequentes (3)', 'Arquivos (1)']);
    await expect(aba(page, 'Identidade')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Nome da empresa ou do profissional')).toHaveValue('Flor de Sal Moda');
    await expect(page.getByLabel('Nome de quem atende no WhatsApp')).toHaveValue('Lia');
    await expect(page.getByLabel('Tom de voz nas conversas')).toHaveValue('acolhedor');
    await expect(page.getByLabel('Nome desta base de treinamento')).toHaveValue('Principal');

    // Sem alterações, não há o que salvar; e a tela não finge o que ainda não foi refeito.
    await expect(salvar(page)).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Ainda em reconstrução nesta aba' })).toBeVisible();
    await expect(page.getByText('Estúdio de Skills')).toBeVisible();
  });

  test('identidade e regras: o que se muda fica gravado; desfazer volta ao que estava', async ({ page }) => {
    await abrirTreinamento(page);

    await page.getByLabel('Nome da empresa ou do profissional').fill('  Flor de Sal Moda e Acessórios ');
    await page.getByLabel('Tom de voz nas conversas').selectOption('descontraido');
    await expect(barraDeSalvar(page)).toHaveText('Há alterações que ainda não foram salvas.');
    // Com alterações por salvar, as instruções mostrariam o treinamento antigo: o botão espera.
    await expect(page.getByRole('button', { name: 'Ver instruções geradas' })).toBeDisabled();

    await aba(page, 'Regras').click();
    await page.getByLabel('Regras de ouro (o que fazer e o que nunca inventar)').fill('- Nunca prometa entrega no mesmo dia.\n- Não dê desconto.');
    await page.getByRole('switch', { name: 'Trava permanente depois de passar para uma pessoa' }).check();
    await page.getByRole('switch', { name: 'Blindagem contra tentativas de manipular a IA' }).uncheck();
    await page.getByRole('radio', { name: /^Dizer que é a assistente virtual/ }).check();
    await salvar(page).click();
    await expect(barraDeSalvar(page)).toHaveText('Treinamento salvo.');
    await expect(salvar(page)).toBeDisabled();

    await page.reload();
    // Os espaços das pontas saem ao gravar.
    await expect(page.getByLabel('Nome da empresa ou do profissional')).toHaveValue('Flor de Sal Moda e Acessórios');
    await expect(page.getByLabel('Tom de voz nas conversas')).toHaveValue('descontraido');
    await aba(page, 'Regras').click();
    await expect(page.getByLabel('Regras de ouro (o que fazer e o que nunca inventar)')).toHaveValue('- Nunca prometa entrega no mesmo dia.\n- Não dê desconto.');
    await expect(page.getByRole('switch', { name: 'Trava permanente depois de passar para uma pessoa' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Blindagem contra tentativas de manipular a IA' })).not.toBeChecked();
    await expect(page.getByRole('radio', { name: /^Dizer que é a assistente virtual/ })).toBeChecked();

    // Desfazer.
    await page.getByLabel('Instruções extras e observações finais').fill('Texto que não vai ficar.');
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(page.getByLabel('Instruções extras e observações finais')).toHaveValue('');
    await expect(salvar(page)).toBeDisabled();
  });

  test('1ª pessoa: os rótulos mudam para quem atende sozinho', async ({ page }) => {
    await abrirTreinamento(page);
    await page.getByRole('switch', { name: 'Atuação individual, em 1ª pessoa (sem empresa e sem equipe)' }).check();
    await expect(page.getByLabel('Seu nome profissional')).toHaveValue('Flor de Sal Moda');
    await expect(page.getByLabel('Como você assina as mensagens')).toHaveValue('Lia');
    await salvar(page).click();
    await expect(barraDeSalvar(page)).toHaveText('Treinamento salvo.');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Atuação individual, em 1ª pessoa (sem empresa e sem equipe)' })).toBeChecked();
  });

  test('o que não pode ser gravado é explicado, e a tela abre a parte onde está o problema', async ({ page }) => {
    await abrirTreinamento(page);

    // Pergunta sem resposta: o erro leva para a parte das perguntas.
    await aba(page, /^Perguntas frequentes/).click();
    await page.getByRole('button', { name: 'Adicionar pergunta' }).click();
    await page.getByLabel('Pergunta 4').fill('Vocês parcelam?');
    await aba(page, 'Regras').click();
    await salvar(page).click();
    await expect(barraDeSalvar(page)).toHaveText('A pergunta 4 está sem a resposta.');
    await expect(aba(page, /^Perguntas frequentes/)).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Resposta 4').fill('Sim, em até 3x sem juros.');

    // Base sem nome: o erro leva para a identidade.
    await aba(page, 'Identidade').click();
    await page.getByLabel('Nome desta base de treinamento').fill('   ');
    await aba(page, 'Regras').click();
    await salvar(page).click();
    await expect(barraDeSalvar(page)).toHaveText('Dê um nome para esta base de treinamento.');
    await expect(aba(page, 'Identidade')).toHaveAttribute('aria-selected', 'true');

    // Texto comprido demais: o contador avisa antes de salvar.
    await page.getByLabel('Nome desta base de treinamento').fill('Principal');
    await page.getByLabel('Nicho ou área de atuação').fill('x'.repeat(121));
    await expect(page.getByText('121 de 120 caracteres.')).toBeVisible();
    await salvar(page).click();
    await expect(barraDeSalvar(page)).toHaveText('O nicho ou área de atuação passou do limite: tem 121 caracteres e cabem 120.');

    // Nada foi gravado no caminho.
    await page.reload();
    await expect(page.getByRole('tab')).toHaveText(['Identidade', 'Regras', 'Perguntas frequentes (3)', 'Arquivos (1)']);
    await expect(page.getByLabel('Nicho ou área de atuação')).toHaveValue('Moda feminina');
  });

  test('perguntas frequentes: acrescentar, remover e gravar', async ({ page }) => {
    await abrirTreinamento(page);
    await aba(page, /^Perguntas frequentes/).click();
    await expect(page.locator('.treino-perguntas > li')).toHaveCount(3);
    const primeira = await page.getByLabel('Pergunta 1').inputValue();
    const segunda = await page.getByLabel('Pergunta 2').inputValue();

    await page.getByRole('button', { name: 'Adicionar pergunta' }).click();
    await page.getByLabel('Pergunta 4').fill('Vocês parcelam?');
    await page.getByLabel('Resposta 4').fill('Sim, em até 3x sem juros.');
    // Uma linha deixada em branco não atrapalha: é ignorada ao gravar.
    await page.getByRole('button', { name: 'Adicionar pergunta' }).click();
    await page.getByRole('button', { name: 'Remover a pergunta 1' }).click();
    await expect(page.getByLabel('Pergunta 1')).toHaveValue(segunda);
    await expect(aba(page, /^Perguntas frequentes/)).toHaveText('Perguntas frequentes (3)');

    await salvar(page).click();
    await expect(barraDeSalvar(page)).toHaveText('Treinamento salvo.');
    await expect(page.locator('.treino-perguntas > li')).toHaveCount(3);
    await expect(bases(page).locator('[aria-current="page"]')).toContainText('3 perguntas');

    await page.reload();
    await aba(page, /^Perguntas frequentes/).click();
    await expect(page.locator('.treino-perguntas > li')).toHaveCount(3);
    await expect(page.getByLabel('Pergunta 3')).toHaveValue('Vocês parcelam?');
    await expect(page.getByLabel('Resposta 3')).toHaveValue('Sim, em até 3x sem juros.');
    for (const numero of [1, 2, 3]) await expect(page.getByLabel(`Pergunta ${numero}`)).not.toHaveValue(primeira);
  });

  test('arquivos de conhecimento: só texto de verdade entra, e inteiro', async ({ page }) => {
    await abrirTreinamento(page);
    await aba(page, /^Arquivos/).click();
    await expect(arquivos(page).getByRole('listitem')).toHaveCount(1);
    await expect(arquivos(page)).toContainText('tabela-de-precos.csv');

    // Sem escolher arquivo.
    await page.getByRole('button', { name: 'Anexar arquivo' }).click();
    await expect(recadoDosArquivos(page)).toHaveText('Escolha um arquivo primeiro.');

    // Um PDF: recusado com a explicação do que fazer.
    await anexar(page, 'catalogo.pdf', 'application/pdf', Buffer.from('%PDF-1.7 conteúdo'));
    await expect(recadoDosArquivos(page)).toHaveText('Só servem arquivos de texto: .txt, .csv, .md ou .json. Para PDF, Word ou planilha, copie o texto para um arquivo .txt.');

    // Uma planilha antiga salva fora do UTF-8 (o "ç" vira um byte solto).
    await anexar(page, 'precos-antigos.csv', 'text/csv', Buffer.from([0x70, 0x72, 0x65, 0xe7, 0x6f, 0x3b, 0x31, 0x30]));
    await expect(recadoDosArquivos(page)).toContainText('não está no formato de texto UTF-8');

    // Grande demais: recusado inteiro, nunca cortado.
    await anexar(page, 'manual-enorme.txt', 'text/plain', Buffer.from('a'.repeat(30_001)));
    await expect(recadoDosArquivos(page)).toHaveText('O arquivo tem 30.001 caracteres e cabem 30.000 por arquivo. Ele não foi cortado: divida em arquivos menores.');
    await expect(arquivos(page).getByRole('listitem')).toHaveCount(1);

    // Um arquivo bom (com acento no nome e no conteúdo).
    await anexar(page, 'Política de trocas.md', 'text/markdown', Buffer.from('# Trocas\r\nAté 7 dias, com a etiqueta.\r\nNão trocamos peças íntimas.\r\n', 'utf8'));
    await expect(recadoDosArquivos(page)).toHaveText('Arquivo "Política de trocas.md" anexado.');
    await expect(arquivos(page).getByRole('listitem')).toHaveCount(2);
    await expect(arquivos(page).getByRole('listitem').last()).toContainText('Política de trocas.md');
    await expect(arquivos(page).getByRole('listitem').last()).toContainText('64 caracteres');
    await expect(aba(page, /^Arquivos/)).toHaveText('Arquivos (2)');
    await expect(page.getByLabel('Arquivo para anexar')).toHaveValue('');

    // O arquivo entra nas instruções da IA, inteiro.
    await page.getByRole('button', { name: 'Ver instruções geradas' }).click();
    await expect(page.getByRole('dialog', { name: 'Instruções geradas' }).getByLabel('Texto das instruções')).toContainText('Não trocamos peças íntimas.');
    await page.getByRole('dialog', { name: 'Instruções geradas' }).getByRole('button', { name: 'Fechar' }).last().click();

    // Apagar pede confirmação.
    await page.getByRole('button', { name: 'Apagar o arquivo Política de trocas.md' }).click();
    await page.getByRole('dialog', { name: 'Apagar arquivo' }).getByRole('button', { name: 'Cancelar' }).click();
    await expect(arquivos(page).getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: 'Apagar o arquivo Política de trocas.md' }).click();
    await page.getByRole('dialog', { name: 'Apagar arquivo' }).getByRole('button', { name: 'Apagar o arquivo' }).click();
    await expect(recadoDosArquivos(page)).toHaveText('Arquivo "Política de trocas.md" apagado.');
    await expect(arquivos(page).getByRole('listitem')).toHaveCount(1);

    await page.reload();
    await expect(page.getByRole('tab')).toHaveText(['Identidade', 'Regras', 'Perguntas frequentes (3)', 'Arquivos (1)']);
  });

  test('ver instruções geradas: o texto que a IA recebe, com o negócio, as perguntas, o arquivo e a regra de honestidade', async ({ page }) => {
    await abrirTreinamento(page);
    await page.getByRole('button', { name: 'Ver instruções geradas' }).click();
    const janela = page.getByRole('dialog', { name: 'Instruções geradas' });
    const texto = janela.getByLabel('Texto das instruções');
    await expect(texto).toContainText('Você é *Lia*, da equipe de atendimento de *Flor de Sal Moda* (segmento: Moda feminina).');
    await expect(texto).toContainText('=== PERGUNTAS FREQUENTES ===');
    await expect(texto).toContainText('<arquivos_de_consulta_json>');
    await expect(texto).toContainText('tabela-de-precos.csv');
    // Perguntaram se é robô: a IA não nega; passa para uma pessoa.
    await expect(texto).toContainText('não negue e não confirme. Responda SOMENTE com [[CHAMAR_HUMANO:Perguntou se é robô]]');
    await expect(texto).toContainText('Nunca afirme ser uma pessoa de carne e osso');
    await expect(janela).toContainText(/São [\d.]+ caracteres\./);
  });

  test('modelo pronto: troca os textos na tela, e só grava quando a pessoa salva', async ({ page }) => {
    await abrirTreinamento(page);
    await page.getByRole('button', { name: 'Começar com um modelo pronto…' }).click();
    const modelos = page.getByRole('dialog', { name: 'Começar com um modelo pronto' });
    await expect(modelos.getByRole('listitem')).toHaveCount(9);
    await modelos.getByRole('button', { name: /^Loja \/ Comércio de Produtos/ }).click();

    const confirmacao = page.getByRole('dialog', { name: 'Usar este modelo?' });
    await expect(confirmacao).toContainText('vai substituir os textos que estão na tela');
    // Cancelar não muda nada.
    await confirmacao.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByLabel('Nome de quem atende no WhatsApp')).toHaveValue('Lia');

    await page.getByRole('button', { name: 'Começar com um modelo pronto…' }).click();
    await page.getByRole('dialog', { name: 'Começar com um modelo pronto' }).getByRole('button', { name: /^Loja \/ Comércio de Produtos/ }).click();
    await page.getByRole('dialog', { name: 'Usar este modelo?' }).getByRole('button', { name: 'Usar o modelo' }).click();
    await expect(barraDeSalvar(page)).toHaveText('Modelo "Loja / Comércio de Produtos" aplicado na tela. Confira e salve.');
    await expect(page.getByLabel('Nome de quem atende no WhatsApp')).toHaveValue('Clara');
    await expect(page.getByLabel('Nome da empresa ou do profissional')).toHaveValue('Loja Modelo (Varejo)');
    // O nome da base não muda com o modelo.
    await expect(page.getByLabel('Nome desta base de treinamento')).toHaveValue('Principal');

    // Recarregar sem salvar: nada foi gravado.
    await page.reload();
    await expect(page.getByLabel('Nome de quem atende no WhatsApp')).toHaveValue('Lia');

    // Agora aplicando e salvando.
    await page.getByRole('button', { name: 'Começar com um modelo pronto…' }).click();
    await page.getByRole('dialog', { name: 'Começar com um modelo pronto' }).getByRole('button', { name: /^Clínica \/ Salão \/ Estúdio/ }).click();
    await page.getByRole('dialog', { name: 'Usar este modelo?' }).getByRole('button', { name: 'Usar o modelo' }).click();
    await salvar(page).click();
    await expect(barraDeSalvar(page)).toHaveText('Treinamento salvo.');
    await page.reload();
    await expect(page.getByLabel('Tom de voz nas conversas')).toHaveValue('acolhedor');
    await expect(page.getByLabel('Nome da empresa ou do profissional')).not.toHaveValue('Flor de Sal Moda');
    // Os arquivos anexados continuam.
    await expect(aba(page, /^Arquivos/)).toHaveText('Arquivos (1)');
  });

  test('várias bases: abrir outra, criar, tornar padrão, escolher a base de cada chip e apagar', async ({ page }) => {
    await abrirTreinamento(page);

    // Cada chip começa na sua base.
    await expect(page.getByLabel('Vendas', { exact: true })).toHaveValue(/.+/);
    const principal = await page.getByLabel('Vendas', { exact: true }).inputValue();
    const suporte = await page.getByLabel('Suporte', { exact: true }).inputValue();
    expect(principal).not.toBe(suporte);

    // Abrir a base de Suporte.
    await bases(page).getByRole('link', { name: /^Suporte/ }).click();
    await expect(page).toHaveURL(new RegExp(`/treinamento\\?base=${suporte}$`));
    await expect(page.getByLabel('Nome desta base de treinamento')).toHaveValue('Suporte');
    await expect(page.getByLabel('Tom de voz nas conversas')).toHaveValue('profissional');
    await expect(page.getByRole('tab')).toHaveText(['Identidade', 'Regras', 'Perguntas frequentes', 'Arquivos']);

    // Criar uma base nova; nome repetido é recusado.
    await page.getByRole('button', { name: 'Nova base' }).click();
    const nova = page.getByRole('dialog', { name: 'Nova base de treinamento' });
    await nova.getByRole('button', { name: 'Criar base' }).click();
    await expect(nova.getByRole('alert')).toHaveText('Dê um nome para a base (por exemplo: Suporte).');
    await nova.getByLabel('Nome da base').fill('suporte');
    await nova.getByRole('button', { name: 'Criar base' }).click();
    await expect(nova.getByRole('alert')).toHaveText('Já existe uma base com este nome. Escolha outro.');
    await nova.getByLabel('Nome da base').fill('Pós-venda');
    await nova.getByRole('button', { name: 'Criar base' }).click();
    await expect(page.getByLabel('Nome desta base de treinamento')).toHaveValue('Pós-venda');
    await expect(page.getByText('3 bases de treinamento')).toBeVisible();
    await expect(bases(page).locator('[aria-current="page"]')).toContainText('Pós-venda');

    // O chip Vendas passa a usar a base nova.
    const posVenda = new URL(page.url()).searchParams.get('base')!;
    await page.getByLabel('Vendas', { exact: true }).selectOption(posVenda);
    await expect(page.locator('.treino-chips').locator('..').getByRole('status')).toHaveText('Base do chip alterada.');
    await page.reload();
    await expect(page.getByLabel('Vendas', { exact: true })).toHaveValue(posVenda);

    // Tornar a base nova a padrão.
    await page.getByRole('button', { name: 'Tornar "Pós-venda" a base padrão' }).click();
    await expect(page.getByText('"Pós-venda" agora é a base padrão.')).toBeVisible();
    await expect(bases(page).locator('[aria-current="page"]')).toContainText(/padrão/i);
    // A padrão não pode ser apagada: os botões somem dela.
    await expect(page.getByRole('button', { name: 'Apagar esta base' })).toHaveCount(0);

    // Apagar a base Principal (que deixou de ser a padrão): os dados dela vão junto.
    await bases(page).getByRole('link', { name: /^Principal/ }).click();
    await expect(page.getByLabel('Nome desta base de treinamento')).toHaveValue('Principal');
    await page.getByRole('button', { name: 'Apagar esta base' }).click();
    const apagar = page.getByRole('dialog', { name: 'Apagar base de treinamento' });
    await expect(apagar).toContainText('Os chips que usam esta base passam a usar a base padrão.');
    await apagar.getByRole('button', { name: 'Apagar a base' }).click();
    await expect(page).toHaveURL(/\/treinamento$/);
    await expect(page.getByText('2 bases de treinamento')).toBeVisible();
    await expect(page.getByLabel('Nome desta base de treinamento')).toHaveValue('Pós-venda');
    await expect(bases(page).locator('.treino-base')).toHaveCount(2);
  });

  test('com alterações por salvar, a tela não deixa abrir outra base (para nada se perder)', async ({ page }) => {
    await abrirTreinamento(page);
    await page.getByLabel('Nicho ou área de atuação').fill('Moda praia');
    await expect(bases(page).getByRole('link')).toHaveCount(0);
    await expect(page.getByText('Salve ou desfaça as alterações para abrir outra base.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nova base' })).toBeDisabled();
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(bases(page).getByRole('link', { name: /^Suporte/ })).toBeVisible();
  });

  test('conta que ainda não treinou: começa em branco ou com um modelo do ramo', async ({ page }) => {
    await abrirTreinamento(page, 'dona');
    await expect(page.getByRole('heading', { name: 'Comece o treinamento' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);

    await page.getByRole('button', { name: 'Começar com um modelo pronto' }).click();
    await page.getByRole('dialog', { name: 'Começar com um modelo pronto' }).getByRole('button', { name: /^Delivery \/ Restaurante \/ Lanchonete/ }).click();
    // A base nasce como "Principal", padrão, já com os textos do modelo gravados.
    await expect(page.getByLabel('Nome desta base de treinamento')).toHaveValue('Principal');
    await expect(page.getByText('1 base de treinamento')).toBeVisible();
    await expect(bases(page).locator('[aria-current="page"]')).toContainText(/padrão/i);
    await expect(page.getByLabel('Tom de voz nas conversas')).toHaveValue('descontraido');
    await expect(page.getByLabel('Nome da empresa ou do profissional')).not.toHaveValue('');
    await expect(salvar(page)).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel('Tom de voz nas conversas')).toHaveValue('descontraido');
  });

  test('conta que ainda não treinou: começar em branco', async ({ page }) => {
    await abrirTreinamento(page, 'dona');
    await page.getByRole('button', { name: 'Começar em branco' }).click();
    await expect(page.getByLabel('Nome desta base de treinamento')).toHaveValue('Principal');
    await expect(page.getByLabel('Nome da empresa ou do profissional')).toHaveValue('');
    await expect(page.getByRole('tab')).toHaveText(['Identidade', 'Regras', 'Perguntas frequentes', 'Arquivos']);
    // Com uma base só e nenhum chip com base própria, a lista de chips nem aparece.
    await expect(page.getByText('Qual base cada chip usa')).toHaveCount(0);
  });

  test('a atendente vê o treinamento, mas não muda nada', async ({ page }) => {
    await abrirTreinamento(page, 'colega');
    await expect(page.getByText('Só o dono da conta altera o treinamento.')).toBeVisible();
    await expect(page.getByLabel('Nome da empresa ou do profissional')).toHaveValue('Flor de Sal Moda');
    for (const campo of [page.getByLabel('Nome da empresa ou do profissional'), page.getByLabel('Tom de voz nas conversas'), page.getByLabel('Vendas', { exact: true })]) {
      await expect(campo).toBeDisabled();
    }
    await expect(salvar(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Nova base|modelo pronto|Apagar|Tornar/ })).toHaveCount(0);
    await aba(page, /^Arquivos/).click();
    await expect(page.getByLabel('Arquivo para anexar')).toHaveCount(0);
    await expect(arquivos(page)).toContainText('tabela-de-precos.csv');
    await aba(page, /^Perguntas frequentes/).click();
    await expect(page.getByLabel('Pergunta 1')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Adicionar pergunta' })).toHaveCount(0);

    // Ver as instruções ela pode.
    await page.getByRole('button', { name: 'Ver instruções geradas' }).click();
    await expect(page.getByRole('dialog', { name: 'Instruções geradas' }).getByLabel('Texto das instruções')).toContainText('Flor de Sal Moda');
  });

  test('cada empresa tem o seu treinamento', async ({ page }) => {
    await abrirTreinamento(page);
    const suporte = await page.getByLabel('Suporte', { exact: true }).inputValue();
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: 'Sair desta conta' }).click();
    await expect(page).toHaveURL(/\/login/);

    // A outra conta não vê as bases desta, nem pedindo pelo endereço.
    await entrar(page, 'dona');
    await page.goto(`/treinamento?base=${suporte}`);
    await expect(page.getByRole('heading', { name: 'Comece o treinamento' })).toBeVisible();
    await expect(page.getByText('Flor de Sal Moda')).toHaveCount(0);
  });

  test('no celular, nada passa da largura da tela', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Só vale para tela de celular.');
    await abrirTreinamento(page);
    for (const nome of ['Identidade', 'Regras', /^Perguntas frequentes/, /^Arquivos/]) {
      await aba(page, nome).click();
      const larguras = await page.evaluate(() => ({ pagina: document.documentElement.scrollWidth, janela: window.innerWidth }));
      expect(larguras.pagina, String(nome)).toBeLessThanOrEqual(larguras.janela);
    }
  });
});

test.describe('Treinamento: acessibilidade', () => {
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

  test('tema escuro: as quatro partes, com alterações por salvar e um erro à mostra', async ({ page }) => {
    await abrirTreinamento(page);
    expect(await problemasGraves(page), 'identidade').toEqual([]);
    await page.getByLabel('Nicho ou área de atuação').fill('x'.repeat(121));
    await salvar(page).click();
    await expect(barraDeSalvar(page)).toContainText('passou do limite');
    expect(await problemasGraves(page), 'identidade com erro').toEqual([]);
    for (const nome of ['Regras', /^Perguntas frequentes/, /^Arquivos/]) {
      await aba(page, nome).click();
      expect(await problemasGraves(page), String(nome)).toEqual([]);
    }
  });

  test('tema claro', async ({ page }) => {
    await abrirTreinamento(page);
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: /Modo claro/ }).click();
    await folha.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await problemasGraves(page), 'identidade').toEqual([]);
    await aba(page, 'Regras').click();
    expect(await problemasGraves(page), 'regras').toEqual([]);
    await aba(page, /^Arquivos/).click();
    await anexar(page, 'catalogo.pdf', 'application/pdf', Buffer.from('%PDF'));
    await expect(recadoDosArquivos(page)).toContainText('Só servem arquivos de texto');
    expect(await problemasGraves(page), 'arquivos com erro').toEqual([]);
  });

  test('janelas: modelos prontos e instruções geradas', async ({ page }) => {
    await abrirTreinamento(page);
    await page.getByRole('button', { name: 'Começar com um modelo pronto…' }).click();
    await expect(page.getByRole('dialog', { name: 'Começar com um modelo pronto' })).toBeVisible();
    expect(await problemasGraves(page), 'modelos').toEqual([]);
    await page.getByRole('dialog', { name: 'Começar com um modelo pronto' }).getByRole('button', { name: 'Cancelar' }).click();

    await page.getByRole('button', { name: 'Ver instruções geradas' }).click();
    await expect(page.getByRole('dialog', { name: 'Instruções geradas' })).toBeVisible();
    expect(await problemasGraves(page), 'instruções').toEqual([]);
  });

  test('conta sem treinamento', async ({ page }) => {
    await abrirTreinamento(page, 'dona');
    await expect(page.getByRole('heading', { name: 'Comece o treinamento' })).toBeVisible();
    expect(await problemasGraves(page), 'conta sem treinamento').toEqual([]);
  });

  test('atendente, só leitura', async ({ page }) => {
    await abrirTreinamento(page, 'colega');
    await expect(page.getByText('Só o dono da conta altera o treinamento.')).toBeVisible();
    expect(await problemasGraves(page)).toEqual([]);
  });
});
