/** Abre uma conversa de forma resiliente (espera o React hidratar) e mede o cabeçalho da conversa. */
export async function abrirConversa(pagina, nomeContato, { tentativas = 12 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const alvo = pagina.locator('button, [role="button"], li, a').filter({ hasText: nomeContato }).first();
    if (await alvo.count()) {
      await alvo.click({ force: true }).catch(() => {});
      await pagina.waitForTimeout(700);
      if (/[?&]c=/.test(pagina.url())) return true;
    }
    await pagina.waitForTimeout(500);
  }
  return false;
}
