/** Mede o campo de escrever da Inbox e diz exatamente o que está cortado. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3100';
const env = Object.fromEntries(
  readFileSync('/home/user/.env', 'utf8').split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const navegador = await chromium.launch();
for (const tamanho of [{ width: 1440, height: 900, nome: 'desktop' }, { width: 390, height: 844, nome: 'celular' }]) {
  const contexto = await navegador.newContext({ viewport: tamanho, locale: 'pt-BR' });
  const pagina = await contexto.newPage();
  await pagina.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await pagina.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await pagina.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await pagina.getByRole('button', { name: /entrar|acessar/i }).first().click();
  await pagina.waitForTimeout(2000);
  await pagina.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
  await pagina.waitForTimeout(1200);
  await pagina.locator('button, [role="button"], li, a').filter({ hasText: 'Lucas Martins' }).first().click();
  await pagina.waitForTimeout(2500);

  const medidas = await pagina.evaluate(`(() => {
    const campo = document.querySelector('.inbox-escrever-campo');
    if (!campo) return { erro: 'campo não existe', url: location.href,
      dialogoAberto: !!document.querySelector('dialog[open]'),
      textoNaTela: (document.querySelector('main')?.innerText || '').replace(/\\s+/g,' ').slice(0, 120) };
    const r = campo.getBoundingClientRect();
    const s = getComputedStyle(campo);
    const linha = campo.closest('.inbox-escrever-linha');
    const rl = linha?.getBoundingClientRect();
    const container = document.querySelector('.inbox-escrever');
    const rc = container?.getBoundingClientRect();
    // quem está por cima do campo? (o que o usuário vê cobrindo o texto)
    const sobre = document.elementsFromPoint(r.left + 12, r.top + Math.min(14, r.height / 2))
      .map((e) => e.tagName.toLowerCase() + '.' + String(e.className).slice(0, 40)).slice(0, 4);
    return {
      campo: { largura: Math.round(r.width), altura: Math.round(r.height), topo: Math.round(r.top), base: Math.round(r.bottom) },
      estilo: { font: s.fontSize, lineHeight: s.lineHeight, minHeight: s.minHeight, padding: s.padding, overflow: s.overflow },
      linha: rl ? { altura: Math.round(rl.height), base: Math.round(rl.bottom) } : null,
      container: rc ? { altura: Math.round(rc.height), base: Math.round(rc.bottom) } : null,
      janela: { altura: window.innerHeight },
      quemCobreOCampo: sobre,
    };
  })()`);
  console.log(`\n=== ${tamanho.nome} (${tamanho.width}x${tamanho.height}) ===`);
  console.log(JSON.stringify(medidas, null, 2));
  await pagina.screenshot({ path: `/home/user/ienvia/auditoria-visual/inbox/composer-${tamanho.nome}.png` });
  await contexto.close();
}
await navegador.close();
