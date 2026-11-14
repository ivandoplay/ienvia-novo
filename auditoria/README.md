# Auditoria — landing Ienvia (ienvia.online)

Data: 13/11/2026 · Ambiente: Playwright Chromium 1254 + Lighthouse 12 (headless)

## 1. Mobile-first: antes vs. depois

| Métrica (390×844, isMobile/hasTouch) | Antes | Depois |
|---|---|---|
| Largura do documento (`scrollWidth`) | **745 px** (viewport esticado) | **390 px** ✅ |
| Elementos vazando da tela | header, aviso, hero, mock, CTA fixo | nenhum (só ticker/off-screen intencionais) |
| Campos com fonte < 16px (zoom iOS) | 13 | **0** ✅ |
| Alvos de toque < 44px | 34 | **0** ✅ |
| Sobreposição de cards no mock do hero | sim (cobriam o chat) | cards empilhados abaixo do mock ✅ |
| Kanban no celular | dependia de arrastar | pills de etapa + `‹ Anterior` / `Mover para X ›` ✅ |
| Comparativo | tabela achatada ilegível | 1 card por linha (Hoje / Ienvia) ✅ |
| Badge “RECOMENDADO” | cortado pela borda | centralizado, com ícone, sem corte ✅ |

Testado em **360×800**, **390×844** e **1440×900**, temas **escuro e claro**, em todas as seções.

## 2. Verificações funcionais (19/19 no domínio real)

Menu mobile · âncoras com header sticky · troca de tema · simulador de IA (texto + respostas rápidas + modo humano) · Kanban por toque (mover e pular etapa) · PIX EMV com **CRC16 recalculado e válido** (`…63047CBD`) · FAQ · modal de demonstração · modal LGPD · calculadora ROI · CTA fixo inteligente. **0 erros de console, 0 requisições 4xx/5xx.**

## 3. Lighthouse (produção, `https://ienvia.online`)

| | Performance | Acessibilidade | Boas práticas | SEO |
|---|---|---|---|---|
| **Mobile** | **97** | 100 | 100 | 100 |
| **Desktop** | **99** | 100 | 100 | 100 |

Métricas mobile: FCP 2,0 s · LCP 2,1 s · TBT 70 ms · CLS 0 · Speed Index 2,0 s · peso 180 KiB · DOM 1.598 elementos.

## 4. Otimizações aplicadas (skills/ferramentas instaladas e usadas)

- **Lighthouse 12** (npm) rodando contra o domínio real, mobile e desktop.
- **Fontes self-hosted**: Space Grotesk, Manrope e JetBrains Mono em `woff2` variável (subset latin + latin-ext, **144 KB**), com `preload`, `font-display:swap` e `Cache-Control: immutable`. Zero dependência de `fonts.googleapis.com`.
- **esbuild**: `app.js` extraído do HTML e minificado (**59 → 39 KB**), carregado com `defer` — sai do caminho crítico.
- **CSS minificado** dentro do HTML (**~228 → 160 KB**).
- **QR Codes em SVG path único**: DOM de **3.467 → 1.598** elementos (−54%).
- **Grão de filme removido** (era `feTurbulence` em tela cheia, caro no paint) e **`backdrop-filter` desligado no mobile** (economia de Style & Layout).
- **Cloudflare Zone**: ofuscação de e-mail desativada (removia 250 ms de script render-blocking); Rocket Loader permanece off.
- **Cloudflare Web Analytics** ativado (`site_tag 36017ba24be94a9e9c5516cf0515d841`) e liberado na CSP.
- **IndexNow** configurado (`/105752cb8e2c5345ea2b8cc213ded85f.txt`) com envio das 3 URLs — HTTP 202 (Bing/Yandex).
- **`_headers`** com CSP, HSTS-friendly, Permissions-Policy, cache por tipo (fontes immutable) e `app.js` com revalidação.
- **URLs canônicas sem `.html`** (`/privacidade`, `/termos`) com `sitemap.xml` atualizado.

## 5. Deploys (Cloudflare Pages · projeto `ienvia-landing`)

`f4d20bc7` → `d80c09e1` → `618fd012` → `d34d06ff` → `b5f43616` → `e3db6bcd` → `ecd6a643` → **`49c185ee` (atual)**

Domínios servindo: `ienvia.online`, `www.ienvia.online` (200) · `/privacidade`, `/termos` (200) · `sitemap.xml`, `robots.txt`, `og-image.png` (200).

## 6. Pendências conhecidas / próximos passos

1. **Cloudflare “HTML tidy”** converte `/privacidade.html` → `/privacidade` via 308; por isso não existe função `_redirects` no Pages. Se algum link externo antigo com `.html` for divulgado, o redirect protege.
2. **Search Console**: cadastrar `https://ienvia.online/sitemap.xml` e verificar o domínio (registro TXT). O IndexNow já avisou Bing/Yandex; o Google depende do Search Console.
3. **LCP ~2,1 s no mobile**: restante é o CSS inline grande. Próximo passo de maior ganho seria modular o CSS (crítico inline + resto em `defer`), o que exige um passo de build — hoje o site é estático puro.
4. **Verificação e2e de e-mail** (`contato@ienvia.online`): ofuscação desligada na zona, então o endereço aparece como texto puro (também melhora para leitores de tela e para o `mailto:`).
