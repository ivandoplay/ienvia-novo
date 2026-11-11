# Ienvia

Atendimento inteligente e CRM para WhatsApp: vários chips, atendente de IA, caixa de entrada,
campanhas e contas separadas por cliente.

Esta é a **reescrita limpa** do sistema antigo (`zap-ia-studio`). O plano completo, com as fases e
as decisões, está em [docs/PLANO.md](docs/PLANO.md). A lista do que fica e do que sai está em
[docs/O-QUE-FICA-E-O-QUE-SAI.md](docs/O-QUE-FICA-E-O-QUE-SAI.md).

**Situação:** Fase 0 (fundação) pronta — login, moldura do painel, Visão geral e testes.
As outras abas aparecem no menu e avisam em que fase ficam prontas.

## O que tem em cada pasta

```
web/        O painel (Next.js). É o que o cliente abre no navegador.
shared/     Regras usadas pelo painel e pelo motor local (código puro, sem rede).
supabase/   O banco: migrações em ordem e os testes de segurança.
docs/       O plano e a lista do que fica e do que sai.
```

O motor local do WhatsApp (pasta `motor/`) entra na Fase 4.

## Rodar no seu computador

Precisa do Node 22.12 ou mais novo (recomendado: 24).

```bash
npm install
cp web/.env.example web/.env.local   # depois preencha o endereço e a chave pública do Supabase
npm run dev                          # abre em http://localhost:3000
```

Sem o `.env.local`, o painel sobe e mostra uma tela explicando o que falta configurar.

## Conferir se está tudo certo

```bash
npm run verificar
```

Esse comando roda tudo, em ordem, e para no primeiro problema:

| Etapa | Comando sozinho | O que confere |
| --- | --- | --- |
| Tipos | `npm run check` | Erros de programação que dá para pegar sem rodar nada. |
| Estilo | `npm run lint` | Padrões do código do painel. |
| Regras e banco | `npm test` | 136 testes: login, menu, datas, e as regras de acesso do banco. |
| Montagem | `npm run build` | O painel monta para produção. |
| Navegador | `npm run test:e2e` | 50 testes num navegador de verdade, em tela de computador e de celular. |

Na primeira vez, os testes de navegador pedem: `npx playwright install chromium`.

### Como os testes protegem os dados

- **Banco** (`supabase/tests`): sobem um Postgres de verdade na memória, aplicam as migrações e
  conferem, tabela por tabela, que uma empresa não lê os dados de outra, que visitante sem login
  não lê nada e que o navegador não consegue fazer o que é trabalho do servidor.
- **Retrato do banco real** (`impressao-digital.remoto.json`): um teste compara o banco montado a
  partir do Git com o banco real. Se alguém mudar o banco por fora, o teste acusa.
- **Navegador** (`web/e2e`): usam um "Supabase de mentira" com contas inventadas. Nenhum teste
  encosta no banco real.

## Regras da casa

1. **Segredo não vai para o Git.** Só `web/.env.example` é versionado. No painel só entra a chave
   *pública* do Supabase; a chave secreta (service_role) nunca aparece no código do navegador.
2. **Migração aplicada não se edita.** Toda mudança no banco é um arquivo novo em
   `supabase/migrations/`, com teste, e só é aplicada no banco real com autorização do dono.
3. **Uma coisa, um lugar.** Menu em `web/src/lib/navegacao.ts`, moldura em
   `web/src/components/casca/`, cada tela na sua pasta em `web/src/app/`.
4. **Nada finge funcionar.** Tela que ainda não foi refeita diz isso com clareza.
5. **Tudo em português**, na tela e no código.

## Variáveis de ambiente

Explicadas uma a uma em [web/.env.example](web/.env.example).

| Variável | Para quê |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Endereço do projeto Supabase. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Chave pública do projeto. |
| `AUTH_DOMINIO_USUARIO` | (Opcional) Domínio interno dos logins por nome de usuário. Padrão: `zapia.local`. |
