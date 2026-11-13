import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { VERSAO_ATUAL_DO_MOTOR } from '@ienvia/shared';
import { WORKSPACE_CHIPS } from './apoio/dados.mjs';
import { abrirMenuDaConta, entrar } from './apoio/sessao';

const SUPABASE = 'http://127.0.0.1:54399';

test.describe('Conexões / Motor e chip Baileys', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${SUPABASE}/controle/reiniciar-chips?workspace=${WORKSPACE_CHIPS}`);
  });

  test('pareia dispositivo local, cria chip Baileys, exibe QR code, conecta e revoga', async ({ page, request }) => {
    await entrar(page, 'chips');
    await page.goto('/conexoes');

    await expect(page.getByRole('heading', { level: 1, name: 'Conexões / Motor' })).toBeVisible();
    await expect(page.getByText(`v${VERSAO_ATUAL_DO_MOTOR}`, { exact: true }).first()).toBeVisible();

    // API pública de versão e pacote zip respondem com integridade.
    const verRes = await request.get('/api/motor/versao');
    expect(verRes.status()).toBe(200);
    const verJson = (await verRes.json()) as { manifest: { version: string; sha256: string } };
    expect(verJson.manifest.version).toBe(VERSAO_ATUAL_DO_MOTOR);
    expect(verJson.manifest.sha256).toMatch(/^[a-f0-9]{64}$/);

    const zipRes = await request.get('/api/motor/pacote');
    expect(zipRes.status()).toBe(200);
    expect(zipRes.headers()['content-type']).toContain('application/zip');

    // Gera código único de pareamento na tela.
    await page.getByRole('button', { name: 'Parear dispositivo' }).click();
    const modal = page.getByRole('dialog', { name: 'Parear novo dispositivo' });
    await modal.getByLabel('Nome do dispositivo').fill('Notebook Escritório');
    await modal.getByRole('button', { name: 'Gerar código de pareamento' }).click();
    await expect(modal).toBeHidden();

    const banner = page.locator('.pareamento-banner');
    await expect(banner).toBeVisible();
    const codigoTexto = (await banner.locator('.pareamento-codigo').textContent())?.trim() ?? '';
    expect(codigoTexto).toMatch(/^IENV-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Simula o script local chamando /api/motor/parear com o código humano.
    const pairRes = await request.post('/api/motor/parear', {
      data: { code: codigoTexto, platform: 'linux', version: VERSAO_ATUAL_DO_MOTOR },
    });
    expect(pairRes.status()).toBe(200);
    const paired = (await pairRes.json()) as { device_token: string; executor_id: string };
    expect(paired.device_token).toBeTruthy();

    // Tela passa a mostrar o dispositivo online sem depender de código pendente.
    await page.reload();
    await expect(page.locator('.executor-item', { hasText: 'Notebook Escritório' }).getByText('Online', { exact: true })).toBeVisible();

    // Agora cria um chip Baileys na aba Instâncias vinculado ao dispositivo pareado.
    await page.goto('/instancias');
    await page.getByRole('button', { name: 'Adicionar chip' }).click();
    const janela = page.getByRole('dialog', { name: 'Adicionar chip' });
    await janela.getByLabel('Apelido do chip').fill('Zap Local');
    await janela.getByRole('radio', { name: /^Motor local/ }).check();
    await janela.getByLabel('Aparelho do Motor local').selectOption(paired.executor_id);
    await janela.getByRole('button', { name: 'Criar e conectar' }).click();
    await expect(janela).toBeHidden();

    const cartao = page.getByRole('article', { name: 'Zap Local' });
    await expect(cartao.getByText('Motor local', { exact: true })).toBeVisible();
    await expect(cartao.getByText('Notebook Escritório (online)')).toBeVisible();

    // O motor consulta a fila de comandos e encontra o pedido de connect_qr.
    const cmdRes = await request.get('/api/motor/comandos', {
      headers: { authorization: `Bearer ${paired.device_token}` },
    });
    expect(cmdRes.status()).toBe(200);
    const cmds = (await cmdRes.json()) as { commands: Array<{ id: string; instance_id: string; command_type: string }> };
    expect(cmds.commands).toHaveLength(1);
    expect(cmds.commands[0]?.command_type).toBe('connect_qr');
    const instanceId = cmds.commands[0]!.instance_id;

    // O motor local envia a string do QR do WhatsApp via /api/motor/estado e o painel renderiza o QR Code!
    const stQr = await request.post('/api/motor/estado', {
      headers: { authorization: `Bearer ${paired.device_token}` },
      data: { instance_id: instanceId, status: 'connecting', pairing_qr: '2@IENVIA-TEST-QR-DATA' },
    });
    expect(stQr.status()).toBe(200);
    await expect(cartao.getByRole('img', { name: 'QR Code para conectar o chip Zap Local' })).toBeVisible({ timeout: 10_000 });

    // O usuário lê o QR Code no WhatsApp; o motor reporta "connected" + número.
    const stOpen = await request.post('/api/motor/estado', {
      headers: { authorization: `Bearer ${paired.device_token}` },
      data: { instance_id: instanceId, status: 'connected', connected_phone: '+5585988887777', pairing_qr: null },
    });
    expect(stOpen.status()).toBe(200);
    await expect(cartao.getByText('Chip conectado!')).toBeVisible({ timeout: 10_000 });
    await expect(cartao.getByText('+55 (85) 98888-7777')).toBeVisible();

    // Volta em /conexoes e revoga o dispositivo: o chip ligado a ele é desconectado e o token passa a receber 401.
    await page.goto('/conexoes');
    await page.locator('.executor-item', { hasText: 'Notebook Escritório' }).getByRole('button', { name: 'Revogar' }).click();
    await page.getByRole('dialog', { name: 'Revogar dispositivo' }).getByRole('button', { name: 'Revogar aparelho' }).click();
    await expect(page.locator('.executor-item', { hasText: 'Notebook Escritório' })).toHaveCount(0);

    const revogadoRes = await request.post('/api/motor/pulso', {
      headers: { authorization: `Bearer ${paired.device_token}` },
      data: {},
    });
    expect(revogadoRes.status()).toBe(401);
  });

  test('acessibilidade WCAG em /conexoes nos modos escuro e claro', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await entrar(page, 'chips');
    await page.goto('/conexoes');
    await expect(page).toHaveTitle(/Conexões/);

    const medir = async () => {
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      return res.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.help} → ${v.nodes[0]?.target.join(' ')}`);
    };

    expect(await medir()).toEqual([]);

    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: /Modo claro/ }).click();
    await folha.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await medir()).toEqual([]);
  });
});
