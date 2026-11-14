/** Print do "Assumir / Devolver para a IA" no celular e no computador, com a IA ligada na conversa. */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { entrar } from './apoio/sessao';
import { CHIP_VENDAS, CONVERSAS_DA_INBOX } from './apoio/dados.mjs';

const SUPABASE = 'http://127.0.0.1:54399';
const CONVERSA_ANA = CONVERSAS_DA_INBOX.ana;

for (const alvo of ['computador', 'celular'] as const) {
  test(`print assumir ${alvo}`, async ({ page, request }, info) => {
    test.skip(info.project.name !== alvo, 'cada tamanho no seu projeto');
    mkdirSync('auditoria-visual/correcoes-12-11', { recursive: true });

    // Liga a IA no chip de vendas e deixa a conversa da Ana com a IA respondendo.
    await request.post(`${SUPABASE}/controle/reiniciar-inbox`);
    await request.post(`${SUPABASE}/controle/reiniciar-ia`);
    await request.post(`${SUPABASE}/controle/ia-do-chip?chip=${CHIP_VENDAS}&ligada=sim`);
    await request.post(`${SUPABASE}/controle/ia-na-conversa?conversa=${CONVERSA_ANA}&estado=respondendo`);

    await entrar(page, 'inbox');
    await page.goto(`/inbox?c=${CONVERSA_ANA}`);
    await page.waitForTimeout(900);

    const faixa = page.getByRole('group', { name: 'A IA nesta conversa' });
    await expect(faixa).toBeVisible();
    const assumir = faixa.getByRole('button', { name: 'Assumir' });
    const caixa = await assumir.boundingBox();
    console.log(`[${alvo}] botão Assumir: ${Math.round(caixa?.width ?? 0)}x${Math.round(caixa?.height ?? 0)}`);
    await page.screenshot({ path: `auditoria-visual/correcoes-12-11/${alvo}-07-assumir.png` });

    await assumir.click();
    await expect(faixa).toContainText('assumida por uma pessoa');
    const devolver = faixa.getByRole('button', { name: 'Devolver para a IA' });
    const caixa2 = await devolver.boundingBox();
    console.log(`[${alvo}] botão Devolver: ${Math.round(caixa2?.width ?? 0)}x${Math.round(caixa2?.height ?? 0)}`);
    await page.screenshot({ path: `auditoria-visual/correcoes-12-11/${alvo}-08-devolver.png` });
  });
}
