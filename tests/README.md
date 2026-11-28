# Índice único dos testes

Execute comandos na raiz do repositório, exceto quando indicado. Testes automatizados usam dublês ou banco em memória; não devem depender da conta real nem enviar mensagens a clientes.

| Tipo | Local | Comando |
|---|---|---|
| Regras compartilhadas + unitários web | `shared/test/`, `web/test/` | `npm run test:unit` |
| Banco, isolamento, RLS e integrações em memória | `supabase/tests/`, `web/test-com-banco/` | `npm run test:db` |
| Navegador (desktop e celular) | `web/e2e/` | `npm run test:e2e` |
| Regras de orçamento/ferramentas | `tests/tooling/` | `npm run test:tooling` |
| Runtime do motor | `motor/test/` | `cd motor && npm test` |
| Tipos e contratos | configurações dos pacotes | `npm run check` |
| Build de produção | `web/` | `npm run build` |

## Regressão rápida de campanhas

```bash
cd web
npx playwright test e2e/campanhas.spec.ts e2e/campanhas-rascunho.spec.ts --project=computador --project=celular
```

`campanhas.spec.ts` cobre criação, mídia, prévia obrigatória, início, pausa/retomada e resolução de envio incerto **em ambiente simulado**. `campanhas-rascunho.spec.ts` acrescenta reabertura de rascunho com preservação de dados, acesso ao controle de áudio e ausência de transbordamento horizontal nos pontos verificados. Não é prova de reprodução sonora em todo navegador/aparelho nem de despacho real.

## Artefatos

Capturas futuras em `web/.cache/evidencias/`; builds de E2E em `web/.cache/next-e2e/`; falhas de Playwright em `web/test-results/`. Não versionar vídeos, traces, galerias e ZIPs gerados. Se uma evidência precisar ser guardada, arquivá-la privadamente, com contexto e hash, fora do código.

## Testes reais

Somente quando explicitamente autorizados e no destino permitido. Não executar automaticamente scripts antigos de envio/publicação a partir do histórico. A campanha real não é fixture de teste. Consultar `docs/CONTINUIDADE.md` e o estado privado antes de qualquer operação que possa ter efeitos externos.

## Diagnóstico exploratório histórico

`tests/exploratorios/auditoria-ampla.ts` preserva a varredura ampla anterior e usa somente dublês. Fica fora da suíte padrão: há achados conhecidos de hidratação e seletores desatualizados, documentados em continuidade. Não interpretar a existência desse arquivo como teste aprovado. Ao retomar essa auditoria, configurar uma execução Playwright explícita a partir da raiz e salvar resultados em `.cache/evidencias/`. Não copiá-lo para produção nem usar dados reais para fazê-lo passar.
