import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { audioDeExemplo, fotoDeExemplo } from './apoio/arquivos-de-exemplo.mjs';
import { CONVERSAS_DA_INBOX } from './apoio/dados.mjs';
import { entrar } from './apoio/sessao';

const SUPABASE = 'http://127.0.0.1:54399';
const EVOLUTION = 'http://127.0.0.1:54398';
const IA_FALSA = 'http://127.0.0.1:54397';

test.describe('Fase 6 — Catálogo & PIX, Áudios, Simulador e Atalhos na Inbox', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
    await request.post(`${SUPABASE}/controle/reiniciar-ia`);
    await request.post(`${SUPABASE}/controle/reiniciar-fase6`);
    await request.post(`${IA_FALSA}/controle/reiniciar`);
    await request.delete(`${EVOLUTION}/controle/enviadas`);
  });

  test('cadastra item no catálogo com foto, ativa PIX com prévia EMV, cria áudio estratégico, simula tudo na IA e dispara rápido na Inbox', async ({
    page,
    request,
  }) => {
    await entrar(page, 'inbox');

    // 1. /catalogo — acessibilidade + item com foto + PIX com QR EMV ao vivo
    await page.goto('/catalogo');
    await expect(page.getByRole('heading', { level: 1, name: 'Catálogo & PIX' })).toBeVisible();
    const a11yCatalogo = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(a11yCatalogo.violations).toEqual([]);

    await page.getByRole('button', { name: 'Novo item do catálogo' }).click();
    await page.getByLabel('Nome do produto / serviço').fill('Vestido Midi Linho');
    await page.getByLabel('Categoria', { exact: true }).fill('Vestidos');
    await page.getByLabel('Preço / faixa (ex.: 149,90)').fill('249,90');
    await page.getByLabel('Detalhes para a IA usar na resposta').fill('Tecido 100% linho, tamanhos P ao GG.');

    await page.locator('input[type="file"][accept*="image/jpeg"]').setInputFiles({
      name: 'vestido-linho.png',
      mimeType: 'image/png',
      buffer: fotoDeExemplo(),
    });
    await expect(page.getByRole('button', { name: 'Remover vestido-linho.png' })).toBeVisible();
    await page.getByRole('button', { name: 'Salvar item' }).click();
    await expect(page.getByText('Item "Vestido Midi Linho" salvo no catálogo.')).toBeVisible();

    // Alterna para aba PIX & QR Code, preenche chave, confirma prévia EMV ao vivo e salva
    await page.getByRole('tab', { name: /PIX e QR Code/ }).click();
    await page.getByRole('checkbox', { name: 'Ativo' }).check();
    await page.getByLabel('Tipo de chave PIX').selectOption('email');
    await page.getByLabel('Chave PIX', { exact: true }).fill('pagamentos@flordesal.com.br');
    await page.getByLabel('Nome do favorecido (aparece no QR Code)').fill('FLOR DE SAL MODA');
    await page.getByLabel('Cidade (padrão EMV)').fill('FORTALEZA');
    await expect(page.getByRole('img', { name: 'QR Code PIX de prévia' })).toBeVisible();
    await expect(page.getByText(/BR\.GOV\.BCB\.PIX/i)).toBeVisible();
    await page.getByRole('button', { name: 'Salvar configuração PIX' }).click();
    await expect(page.getByText('Configuração de PIX e QR Code salva.')).toBeVisible();

    // 2. /audios — acessibilidade + upload WAV com decodificação + transcrição
    await page.goto('/audios');
    await expect(page.getByRole('heading', { level: 1, name: 'Biblioteca de Áudios' })).toBeVisible();
    const a11yAudios = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(a11yAudios.violations).toEqual([]);

    await page.getByRole('button', { name: 'Novo áudio estratégico' }).click();
    await page.locator('input[type="file"][accept*="audio/ogg"]').setInputFiles({
      name: 'boas-vindas.wav',
      mimeType: 'audio/wav',
      buffer: audioDeExemplo(2),
    });
    await expect(page.getByText(/Arquivo pronto:/)).toBeVisible();
    await page.getByLabel('Nome identificador do áudio').fill('Boas-vindas Flor de Sal');
    await page.getByLabel('Quando a IA deve acionar este áudio?').fill('Primeira dúvida sobre entrega ou troca');
    await page.getByLabel('Transcrição exata do que é falado (obrigatória)').fill('Oi! Tudo bem? Entregamos em toda Fortaleza no mesmo dia útil.');
    await page.getByRole('button', { name: 'Salvar áudio' }).click();
    await expect(page.getByText('Áudio "Boas-vindas Flor de Sal" salvo na biblioteca.')).toBeVisible();

    // 3. /simulador — verifica contexto carregado, resposta com tags Catálogo + Áudio + PIX e Skill S06
    await page.goto('/simulador');
    await expect(page.getByRole('heading', { level: 1, name: 'Simulador de Atendimento' })).toBeVisible();
    const a11ySim = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(a11ySim.violations).toEqual([]);
    await expect(page.getByText(/Catálogo ativo:\s*1 itens/)).toBeVisible();
    await expect(page.getByText(/Áudios liberados para IA:\s*1 áudios/)).toBeVisible();
    await expect(page.getByText(/PIX automático:\s*Ativo \(pagamentos@flordesal\.com\.br\)/)).toBeVisible();

    // Descobre os IDs salvos para programar uma resposta realista da IA falsa
    await request.post(`${IA_FALSA}/controle/proxima-resposta`, {
      data: {
        texto:
          'Claro! Separei o Vestido Midi Linho e nossos dados de PIX para você.\n[[ENVIAR_ITEM:Vestido Midi Linho]]\n[[ENVIAR_AUDIO:Boas-vindas Flor de Sal]]\n[[ENVIAR_PIX:249.90]]',
      },
    });

    await page.getByLabel('Mensagem de teste').fill('Quero o Vestido Midi Linho, manda foto e PIX!');
    await page.getByRole('button', { name: 'Simular' }).click();

    await expect(page.getByText('Catálogo enviado: Vestido Midi Linho')).toBeVisible();
    await expect(page.getByText('Áudio PTT: Boas-vindas Flor de Sal')).toBeVisible();
    await expect(page.getByRole('img', { name: 'QR Code PIX simulado' })).toBeVisible();
    await expect(page.getByText(/DADOS PARA PAGAMENTO VIA PIX/)).toBeVisible();

    // Limpa conversa simulada
    await page.getByRole('button', { name: 'Nova conversa simulada' }).click();
    await expect(page.getByText('Sessão isolada e segura')).toBeVisible();

    // 4. /inbox — atalhos manuais de Catálogo, Áudio e PIX enviam direto para a conversa via Evolution
    await page.goto(`/inbox?c=${CONVERSAS_DA_INBOX.bruno}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Bruno Lima' })).toBeVisible();

    // Dispara do catálogo
    await page.getByRole('button', { name: 'Enviar do catálogo' }).click();
    await expect(page.getByRole('region', { name: 'Catálogo para envio rápido' })).toBeVisible();
    await page.getByRole('region', { name: 'Catálogo para envio rápido' }).getByRole('button', { name: /Vestido Midi Linho/ }).click();
    await expect(page.getByRole('region', { name: 'Catálogo para envio rápido' })).toHaveCount(0);

    // Dispara áudio estratégico
    await page.getByRole('button', { name: 'Enviar áudio estratégico' }).click();
    await expect(page.getByRole('region', { name: 'Áudios estratégicos para envio rápido' })).toBeVisible();
    await page
      .getByRole('region', { name: 'Áudios estratégicos para envio rápido' })
      .getByRole('button', { name: /Boas-vindas Flor de Sal/ })
      .click();
    await expect(page.getByRole('region', { name: 'Áudios estratégicos para envio rápido' })).toHaveCount(0);

    // Dispara cobrança PIX
    await page.getByRole('button', { name: 'Enviar PIX' }).click();
    const popPix = page.getByRole('region', { name: 'Envio rápido de cobrança PIX' });
    await expect(popPix).toBeVisible();
    await popPix.getByPlaceholder('Valor opcional (ex.: 149,90)').fill('249,90');
    await popPix.getByRole('button', { name: 'Enviar PIX' }).click();
    await expect(popPix).toHaveCount(0);

    // Confere na Evolution falsa que saíram texto do item, foto do item, áudio, texto PIX, PNG QR e BR Code
    const envRes = await request.get(`${EVOLUTION}/controle/enviadas`);
    const enviadas = await envRes.json();
    expect(enviadas.some((e: { texto?: string }) => e.texto?.includes('*Vestido Midi Linho*'))).toBe(true);
    expect(enviadas.filter((e: { tipo?: string }) => e.tipo === 'image').length).toBe(2);
    expect(enviadas.some((e: { tipo?: string; bytes?: number }) => e.tipo === 'audio' && (e.bytes ?? 0) > 100)).toBe(true);
    expect(enviadas.some((e: { texto?: string }) => e.texto?.includes('*DADOS PARA PAGAMENTO VIA PIX*'))).toBe(true);
    expect(enviadas.some((e: { texto?: string }) => e.texto?.toLowerCase().includes('br.gov.bcb.pix'))).toBe(true);
  });
});
