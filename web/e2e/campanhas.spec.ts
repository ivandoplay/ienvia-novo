import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { WORKSPACE_INBOX } from './apoio/dados.mjs';
import { entrar } from './apoio/sessao';

const SUPABASE = 'http://127.0.0.1:54399';

test.describe('Campanhas e Pastas de Mídia', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
    await request.post(`${SUPABASE}/controle/reiniciar-fase5`);
  });

  test('cria pasta de áudio, envia arquivo, monta campanha multi-bloco, valida prévia obrigatória, confirma e resolve envio incerto', async ({
    page,
    request,
  }) => {
    await entrar(page, 'inbox');
    await page.goto('/campanhas');

    await expect(page.getByRole('heading', { level: 1, name: 'Campanhas' })).toBeVisible();
    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations).toEqual([]);

    // 1. Cria pasta de áudio e envia um arquivo via signed URL
    await page.getByRole('tab', { name: /Pastas de mídia/ }).click();
    await page.getByLabel('Nome da pasta').fill('Áudios Boas-Vindas');
    await page.getByLabel('Tipo da pasta').selectOption('audio');
    await page.getByRole('button', { name: 'Criar pasta' }).click();
    await expect(page.getByText('Pasta "Áudios Boas-Vindas" criada.')).toBeVisible();

    await page.getByLabel('Adicionar arquivos na pasta').setInputFiles({
      name: 'saudacao.ogg',
      mimeType: 'audio/ogg',
      buffer: Buffer.from('OggS-audio-ficticio'),
    });
    await expect(page.getByText('saudacao.ogg')).toBeVisible();

    // 2. Monta campanha com texto Spintax + bloco de Áudio PTT + lista via CSV colado
    await page.getByRole('tab', { name: /Montar campanha/ }).click();
    await page.getByLabel('Nome da campanha').fill('Campanha Outubro');
    await page.getByLabel('Ou cole uma lista (Nome;Telefone;Cidade...)').fill(
      'Nome;Telefone;Cidade\nJoão Silva;86999110011;Teresina\nMaria Costa;86999110022;Parnaíba',
    );
    await page.getByLabel('Mensagem').fill('{Oi|Olá} {{primeiro_nome}}, temos oferta para {{cidade}}!');
    await page.getByRole('button', { name: '+ Bloco de áudio' }).click();
    await expect(page.getByLabel('Enviar como mensagem de voz (PTT)')).toBeChecked();

    // 3. Gera prévia obrigatória e confirma disparo
    await page.getByRole('button', { name: 'Salvar rascunho e gerar prévia' }).click();
    await expect(page.getByText('Prévia obrigatória antes do disparo')).toBeVisible();
    await expect(page.getByText(/2 contato\(s\) pronto\(s\)/)).toBeVisible();

    await page.getByRole('button', { name: 'Confirmar e iniciar disparo' }).click();
    await expect(page.getByText('Campanha confirmada e iniciada em ritmo seguro.')).toBeVisible();
    await expect(page.getByText('João Silva')).toBeVisible();

    // 4. Pausa e retoma a campanha
    await page.getByRole('button', { name: 'Pausar' }).click();
    await expect(page.getByText('Campanha pausada.')).toBeVisible();
    await page.getByRole('button', { name: 'Retomar' }).click();
    await expect(page.getByText('Campanha retomada.')).toBeVisible();

    // 5. Simula envio incerto na campanha e confirma resolução na UI
    await request.post(`${SUPABASE}/controle/simular-envio-incerto?workspace=${WORKSPACE_INBOX}&alvo=campanha`);
    await page.getByRole('button', { name: 'Atualizar' }).click();
    await expect(page.getByText('Envios aguardando confirmação humana')).toBeVisible();
    await page.getByRole('button', { name: 'Foi enviada' }).click();
    await expect(page.getByText('Confirmado que a mensagem saiu.')).toBeVisible();
  });
});
