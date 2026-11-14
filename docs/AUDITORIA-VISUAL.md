# Auditoria visual do painel — 14/11/2026

Tudo o que está aqui foi **medido**, não deduzido: prints + números (largura/altura em px) e,
sempre que possível, conferido no build de produção (`next start`), que é o que o cliente usa.
A versão com as imagens lado a lado está em `docs/auditoria-antes-depois.html`.

## Como a auditoria foi feita

1. `web/auditoria/semear-conversas.mjs` — cria 8 contatos, 8 conversas e 32 mensagens no workspace
   de teste (`Teste automático (pode apagar)`), além de dois chips: um conectado e um desconectado,
   para medir a tela nos dois estados. `--limpar` apaga tudo antes de semear de novo.
2. `web/auditoria/varredura-producao.mjs` — percorre as 13 telas logadas e mede rolagem lateral,
   elemento fora da janela, erro de console e erro de HTTP ≥ 500.
3. `web/auditoria/texto-cortado.mjs` — detector de texto cortado/estouro, em desktop e celular,
   ignorando `sr-only` e áreas que rolam por projeto (os falsos positivos da primeira rodada).
4. Scripts pontuais: `medir-composer.mjs`, `medir-topo-conversa.mjs`, `checa-pilula.mjs`,
   `inbox-detalhado.mjs`, `estado-conectado*.mjs`.

## O que era bug de verdade, e o que foi corrigido

| # | Achado | Medida antes | Depois |
|---|--------|--------------|--------|
| 1 | **Campo de escrever da Inbox esmagado** | 92px no desktop (1440) e 26px no celular; a dica "Enter envia…" vazava por cima do texto | 214px / 208px, linha de 105–116px, nada sobreposto |
| 2 | **Cabeçalho da conversa esmagado** | nome virava "M." e o telefone quebrava em 4 linhas | nome inteiro, telefone em 1 linha, botões descem quando falta espaço |
| 3 | **Rótulo truncado no código**: "Etiquetas & /" | texto cortado na fonte, não no CSS | "Etiquetas & respostas" |
| 4 | **Pílula do topo cortada no celular** | "1 de 2 conectados" aparecia como "1 de ..." | "1/2 chips" (87px → 34–41px de texto) |
| 5 | **"Chip X" sem dois-pontos** | lia errado na conversa | "Chip: X" |

Arquivos alterados: `web/src/styles/inbox.css`, `web/src/app/(painel)/inbox/painel-da-inbox.tsx`,
`web/src/lib/formato.ts`, `web/test/formato.test.ts`.

## O que NÃO era bug (não mexer)

- **"Olá --:--"** — só aparece no modo de desenvolvimento deste ambiente, onde o cliente React não
  hidrata (o HMR não conecta). No build de produção o relógio anda certo (`00:10 → 00:11`).
- **"Nova conversa não abre"** — no build de produção o modal abre normalmente
  (`dialog[open]`, "Iniciar conversa manual no WhatsApp"). Era o mesmo problema de hidratação no dev.
- **Abas Contatos/Kanban "não encontradas"** — são links (`?aba=contatos` / `?aba=kanban`), não botões.
  O script de auditoria é que procurava botão.
- **"Texto cortado" em série na primeira varredura** — eram elementos `.so-leitor-de-tela` (1×1, por design).
- **`/contas`** — é o painel do administrador da plataforma; a conta de teste é dona de um workspace.
  Redirecionar para "Página não encontrada" nesse caso está correto.
- **`/crm`** — rota antiga: `/inbox?aba=kanban` é o nome atual. Não há link para `/crm` em lugar nenhum.

## Estado depois das correções

- 13 telas varridas: **0 rolagem lateral, 0 elemento fora da janela, 0 texto cortado**.
- `npm run check` (typegen + tsc + tsc dos testes): limpo.
- `npm run lint`: 0 erros (2 avisos em scripts de auditoria, não em código do produto).
- `npm test`: **1011 testes / 52 arquivos**, todos passando.
- `npm run build`: OK. Deploy em `a39da90` está **READY** na Vercel e `app.ienvia.online` já responde
  com "Etiquetas & respostas" e "1/2 chips".

---

# Segunda rodada — 14/11, pedidos do usuário

## 1. Transcrição automática na Biblioteca de Áudios (novo)

O modal de gravar/subir áudio ganhou o botão **"Transcrever automaticamente (Gemini)"**, ao lado do
campo de transcrição. Quem preferir continua digitando à mão.

- Usa a **chave do Gemini que o cliente já cadastrou em Motor de IA** (guardada cifrada no cofre do servidor).
  Sem chave cadastrada, o botão responde: "Nenhuma chave do Gemini cadastrada…".
- Fica desativado enquanto não houver arquivo enviado (não há o que transcrever).
- O áudio é baixado do depósito pelo servidor e enviado ao Gemini; a chave nunca vai para o navegador.
- Modelos tentados em ordem: `gemini-2.5-flash` → `gemini-2.0-flash` → `gemini-flash-latest`.
- Erros são traduzidos (chave recusada, sem crédito, limite, áudio longo, conteúdo bloqueado).
- Código: `web/src/lib/ia/provedores.ts` (`transcreverAudio`), `web/src/app/(painel)/audios/acoes.ts`
  (`transcreverAudioEstrategico`) e o botão em `painel-de-audios.tsx`.

## 2. Exclusão de clientes na área SaaS (novo)

Cada cliente em `/contas` ganhou **"Excluir cliente"**, com janela de confirmação pedindo o motivo.
O que acontece na hora: o cliente fica `closed` (perde acesso), campanhas rodando pausam, chips
desligam. **Os dados não são apagados na hora** — o botão **"Desfazer exclusão"** vale por 30 dias.

- Migração `supabase/migrations/20261120120000_platform_delete_workspace.sql`
  (`delete_platform_workspace`, `restore_platform_workspace`, auditoria `platform_workspace_deleted/restored`).
- Aplicada no banco real; retrato do banco atualizado (funções 190 → 192).
- Teste de banco novo em `supabase/tests/contas_suporte.test.ts`: dono/atendente/intruso são barrados,
  motivo é obrigatório, chips desligam, histórico registra e o desfazer funciona.

## 3. Aba "Horário & Alertas" — testada de ponta a ponta

Testei em produção e no celular: abre, edita, salva e persiste (`always` → `business_hours_only`,
08:30–19:15, domingo desligado, mensagem fora do horário). Não há bug de bloqueio.

O que existia de verdade: **para quem não é dono da conta**, a aba abria com tudo desativado e **sem
botão de salvar** — parecia travada. Agora mostra, no mesmo lugar do botão, "Somente o dono da conta
altera estes números". Vale para as abas Anti-ban e Horário.

## 4. Motor no Linux — causa do erro

O erro `Cannot find module .../ienvia-motor/scripts/src/index.mjs` acontece porque o comando foi
rodado **de dentro da pasta `scripts/`**. O `node` procura `src/` a partir da pasta atual.

- `./scripts/iniciar.sh --url ... --pair ...` — roda de qualquer pasta (agora ele entra na pasta do
  motor sozinho e avisa se o `src/index.mjs` não estiver lá).
- `node src/index.mjs` — só funciona na raiz `ienvia-motor/`.
- O `README.txt` do pacote baixado passou a explicar os dois casos, com o erro citado.
- Testado com o pacote que está no ar: baixei de `app.ienvia.online/api/motor/pacote`, rodei
  `setup-linux.sh` e `iniciar.sh` de dentro de `scripts/` — funciona.

## Observações que valem uma decisão sua

1. **Estado vazio da lista de conversas no celular.** Ao abrir `/inbox` no celular com a lista vazia
   (sem conversa escolhida), o centro da tela fica em branco — não há mensagem de "escolha uma
   conversa" nessa largura. No desktop aparece. Dá para preencher com o mesmo aviso da versão desktop.
2. **Filtro "Ver por chip"** só aparece quando há mais de um chip; com um chip só ele some, e o botão
   "Etiquetas & respostas" fica sozinho na linha. Funciona, mas parece faltar algo.
3. **`/contas` para o administrador** continua existindo e funciona; só não é acessível para a conta
   de teste. Se quiser, posso criar um atalho de "área do administrador" no menu quando `ehMaster`.
