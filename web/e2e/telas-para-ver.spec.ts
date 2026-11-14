/**
 * Só tira prints: percorre cada tela do painel, no computador e no celular, e guarda as imagens em
 * "auditoria-visual/todas-as-telas/<tamanho>/". Não altera nada de verdade (ambiente de mentira).
 *
 * Rodar: npx playwright test e2e/telas-para-ver.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

const PASTA = 'auditoria-visual/todas-as-telas';

type Tela = { nome: string; ir: (page: Page) => Promise<void>; conferir?: (page: Page) => Promise<void> };

const abrir = (caminho: string, titulo?: string): Tela['ir'] => async (page) => {
  await page.goto(caminho);
  if (titulo) await expect(page.getByRole('heading', { level: 1, name: titulo })).toBeVisible();
  await page.waitForTimeout(600);
};

const TELAS: Tela[] = [
  { nome: '01-login', ir: async (page) => { await page.goto('/login'); await page.waitForTimeout(500); } },
  { nome: '02-visao-geral', ir: async (page) => { await page.goto('/visao-geral'); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); await page.waitForTimeout(700); } },
  { nome: '03-inbox-lista', ir: abrir('/inbox') },
  {
    nome: '04-inbox-conversa',
    ir: async (page) => {
      await page.goto('/inbox');
      await page.getByRole('region', { name: /^(Fila de atendimento|Resultado da busca)$/ }).getByRole('link', { name: /Ana Souza/ }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Ana Souza' })).toBeVisible();
      await page.waitForTimeout(500);
    },
  },
  { nome: '05-campanhas', ir: abrir('/campanhas') },
  {
    nome: '06-campanhas-nova',
    ir: async (page) => {
      await page.goto('/campanhas');
      await page.getByRole('tab', { name: /Montar campanha/ }).click();
      await page.waitForTimeout(500);
    },
  },
  { nome: '07-treinamento', ir: abrir('/treinamento') },
  {
    nome: '08-treinamento-regras',
    ir: async (page) => {
      await page.goto('/treinamento');
      await page.getByRole('tab', { name: 'Regras' }).click();
      await page.waitForTimeout(500);
    },
  },
  {
    nome: '09-treinamento-perguntas',
    ir: async (page) => {
      await page.goto('/treinamento');
      await page.getByRole('tab', { name: /^Perguntas frequentes/ }).click();
      await page.waitForTimeout(500);
    },
  },
  {
    nome: '10-treinamento-skills',
    ir: async (page) => {
      await page.goto('/treinamento');
      await page.getByRole('tab', { name: 'Estúdio de Skills' }).click();
      await page.waitForTimeout(500);
    },
  },
  {
    nome: '11-treinamento-cerebro',
    ir: async (page) => {
      await page.goto('/treinamento');
      await page.getByRole('tab', { name: 'Cérebro e Pacote' }).click();
      await page.waitForTimeout(500);
    },
  },
  { nome: '12-catalogo', ir: abrir('/catalogo') },
  {
    nome: '13-catalogo-pix',
    ir: async (page) => {
      await page.goto('/catalogo');
      await page.getByRole('tab', { name: /PIX e QR Code/ }).click();
      await page.waitForTimeout(500);
    },
  },
  { nome: '14-audios', ir: abrir('/audios') },
  {
    nome: '15-audios-novo',
    ir: async (page) => {
      await page.goto('/audios');
      await page.getByRole('button', { name: 'Novo áudio estratégico' }).click();
      await expect(page.getByText(/Novo áudio estratégico/).first()).toBeVisible();
      await page.waitForTimeout(500);
    },
  },
  { nome: '16-simulador', ir: abrir('/simulador') },
  { nome: '17-motor-de-ia', ir: abrir('/inteligencia-artificial') },
  { nome: '18-instancias', ir: abrir('/instancias') },
  { nome: '19-conexoes', ir: abrir('/conexoes') },
  { nome: '20-configuracoes', ir: abrir('/configuracoes') },
  { nome: '21-seguranca', ir: abrir('/seguranca') },
  {
    nome: '22-seguranca-horario',
    ir: async (page) => {
      await page.goto('/seguranca');
      await page.getByRole('tab', { name: /Horário & Alertas/ }).click();
      await page.waitForTimeout(500);
    },
  },
  {
    nome: '23-seguranca-ignorados',
    ir: async (page) => {
      await page.goto('/seguranca');
      await page.getByRole('tab', { name: /Contatos Ignorados/ }).click();
      await page.waitForTimeout(500);
    },
  },
  {
    nome: '24-seguranca-fila',
    ir: async (page) => {
      await page.goto('/seguranca');
      await page.getByRole('tab', { name: /Fila Segura/ }).click();
      await page.waitForTimeout(500);
    },
  },
  {
    nome: '25-menu-conta',
    ir: async (page) => {
      await page.goto('/visao-geral');
      await page.waitForTimeout(400);
      const folha = await abrirMenuDaConta(page);
      await expect(folha).toBeVisible();
      await page.waitForTimeout(400);
    },
  },
  {
    nome: '26-menu-completo',
    ir: async (page) => {
      await page.goto('/visao-geral');
      await page.waitForTimeout(400);
      // No celular existe o botão "Mais" da barra de baixo; no computador o menu já está na tela.
      const menu = page.getByRole('button', { name: /^Mais/ });
      if (await menu.count()) {
        await menu.click();
        await page.waitForTimeout(700);
      }
    },
  },
];

/** O painel rola dentro de "#conteudo", então "página inteira" não existe: a gente rola e fotografa. */
async function fotografar(page: Page, caminho: string) {
  await page.screenshot({ path: `${caminho}.png` });
  const rolagem = await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('#conteudo');
    if (!area) return null;
    return { altura: area.scrollHeight, janela: area.clientHeight };
  });
  if (!rolagem || rolagem.altura <= rolagem.janela + 8) return;
  await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('#conteudo');
    if (area) area.scrollTop = area.scrollHeight;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${caminho}-parte2.png` });
}

for (const tela of TELAS) {
  test(`print ${tela.nome}`, async ({ page }, info) => {
    const tamanho = info.project.name === 'celular' ? 'celular' : 'computador';
    const pasta = `${PASTA}/${tamanho}`;
    mkdirSync(pasta, { recursive: true });

    // Telas internas precisam de sessão; o login é capturado sem ela.
    if (tela.nome !== '01-login') await entrar(page, 'inbox');
    // No computador, uma janela alta mostra a tela quase toda de uma vez (o painel tem rolagem própria).
    if (tamanho === 'computador') await page.setViewportSize({ width: 1440, height: 1500 });
    await tela.ir(page);
    await fotografar(page, `${pasta}/${tela.nome}`);
  });
}

// Telas exclusivas do administrador (clientes SaaS): entram com o master.
test('print 27-clientes-saas', async ({ page }, info) => {
  const tamanho = info.project.name === 'celular' ? 'celular' : 'computador';
  const pasta = `${PASTA}/${tamanho}`;
  mkdirSync(pasta, { recursive: true });
  await entrar(page, 'master@exemplo.com');
  await page.goto('/contas');
  if (tamanho === 'computador') await page.setViewportSize({ width: 1440, height: 1500 });
  await expect(page.getByRole('heading', { level: 1, name: 'Clientes SaaS' })).toBeVisible();
  await page.waitForTimeout(600);
  await fotografar(page, `${pasta}/27-clientes-saas`);
});
