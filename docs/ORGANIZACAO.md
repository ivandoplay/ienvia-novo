# Organização do projeto e do workspace

## Workspace (privado)

```text
/home/user/
├── COMECE-AQUI.md              entrada e mapa de recuperação
├── ienvia/                    ÚNICA árvore ativa do projeto e Git
├── operacao/                  campanha real, recibos e ferramentas privadas
│   ├── ESTADO-PRIVADO.md
│   ├── campanhas/veiculos-fortaleza/
│   └── ferramentas/
├── arquivo/privado/           manifesto, recibos Drive e chave de recuperação
├── gestao/                    inventários e relatório da organização
├── uploads/                   originais anexados pelo usuário
├── dados/originais/            cópias obtidas do Drive
├── backups/                   backups anteriores, preservados
├── motor-testes-jeffersonivan/ laboratório ATIVO, preservado no caminho original
├── .env                       credenciais do operador; nunca versionar
└── .cache/                    dependências/artefatos regeneráveis; não persistem
```

Aliases `motor-640-consolidacao → ienvia` e `campanha-veiculos → operacao/campanhas/veiculos-fortaleza` existem apenas para compatibilidade com ferramentas antigas. Não trabalhar em duas cópias. Não mover o laboratório ativo para atender a estética da árvore.

## Dentro do repositório

| Pasta | Responsabilidade |
|---|---|
| `web/src/` | Produto web: telas, rotas, ações de servidor e integrações |
| `web/public/` | Recursos estáticos necessários ao produto |
| `shared/src/` | Regras puras compartilhadas |
| `motor/src/` | Runtime do motor e supervisor |
| `supabase/migrations/` | Migrações versionadas, não reaplicar histórico em produção |
| `supabase/functions/` | Edge Functions |
| `cloudflare/`, `landing/` | Porteiro e site institucional |
| `scripts/` | Ferramentas mantidas de desenvolvimento, orçamento e recuperação |
| `tests/README.md` | Índice único de todos os tipos de teste e seus comandos |
| `docs/` | Documentação mantida; começar por CONTINUIDADE.md |

Os testes permanecem junto aos respectivos pacotes (ver índice). Isso respeita TypeScript, Vitest e Playwright e evita um rearranjo artificial que quebraria imports/configuração. Evidências e arquivos de produção não pertencem aos diretórios de testes.

## O que saiu do código

Galerias HTML com imagens embutidas, ZIPs de capturas, relatórios Lighthouse e PNGs de auditoria foram retirados da árvore ativa e do novo commit. O histórico anterior do Git **não foi reescrito**. As versões locais foram preservadas com hash no arquivo privado cifrado do Drive.

Scripts manuais históricos em `web/auditoria/` são ferramentas de referência, **não** a suíte automatizada e não devem ser executados contra produção sem revisão. Alguns podem criar dados reais. Documentos antigos que apontam para galerias removidas são referências históricas: recuperar os artefatos do arquivo privado ou do histórico Git.

## Evitar novo estouro

- Novas capturas automatizadas: `web/.cache/evidencias/`.
- Build Next, relatório de teste e dependências ficam em pastas geradas e ignoradas.
- Não incluir `node_modules`, `.next`, `.runtime`, `data`, `wa_auth`, `.env`, listas de contatos, exportações de conversas nem recibos operacionais no Git.
- Nunca usar diretórios de cache para a única cópia de código, chaves ou backup.
- Antes do commit: `npm run repo:check` (checagem preventiva, não substitui revisão de segredos).
- Antes de encerrar sessão: `npm run workspace:check -- /home/user`. Limites conservadores: 128.000.000 bytes e 10.000 arquivos; manter margem.
- `.gitignore` não reduz por si só o orçamento do workspace. Mover arquivos para uma pasta ignorada pelo Git não basta: o histórico pesado foi de fato retirado da área persistida depois de copiado, cifrado e validado no Drive.

## Recuperar o histórico privado

O recibo com IDs do Drive está em `/home/user/arquivo/privado/recibo-drive.json`; o manifesto contém nomes, tamanhos e SHA-256 dos arquivos preservados. Os dois objetos estão cifrados individualmente com AES-256-GCM; foram conferidos por tamanho/MD5 e acesso somente do proprietário após upload.

A chave é `/home/user/arquivo/privado/chave-backup.json` (permissão 0600); **nunca** publicar esse arquivo. Perder a chave impede a recuperação. O proprietário deve guardar uma cópia em armazenamento privado seguro, separada das partes cifradas.

Baixar as duas partes e executar `scripts/recuperar-arquivo-privado.py` conforme `--help`. O utilitário valida as tags de autenticação e o SHA-256 antes de concluir. Ele não extrai automaticamente sobre o projeto, não lê o `.env` e não altera produção.
