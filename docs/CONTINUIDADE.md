# Continuidade — leia antes de alterar o sistema

Este é o resumo operacional atual. Documentos de auditoria antigos são históricos, não a descrição automática da produção atual.

## Fonte de verdade

- Repositório: `ivandoplay/ienvia-novo`, branch `main`.
- Pasta de trabalho canônica neste workspace: `/home/user/ienvia`.
- `motor-640-consolidacao` é apenas um alias de compatibilidade para essa pasta; não é outra versão.
- Painel: `web/`, projeto Vercel `ienvia-novo`, diretório raiz de deploy `web`.
- Motor publicado: **6.4.1**. Não incrementar versão nem republicar pacote para uma alteração de organização/documentação.
- Nunca publicar outra árvore histórica inteira sobre esta.

## Trabalho recente concluído

### Motor

A versão 6.4.1 prioriza eventos novos (mais novos primeiro), mantém histórico em baixa prioridade, resolve identidades e exibe diagnóstico de entrada. Release validado com 109 testes do motor. Teste de saída de voz no Termux foi recebido pelo usuário. Isso **não prova** que todos os problemas anteriores de entrada de mensagens foram resolvidos.

### Campanhas

- Áudios realmente convertidos para OGG/Opus e preparados como PTT; não apenas renomeados.
- Player disponível na biblioteca, no editor e no detalhe, com URL temporária e autorização por workspace.
- Leitura de até 5.000 destinatários, contagem total correta e tabela paginada de 50 em 50.
- Acesso a rascunhos salvos por “Editar e preparar envio”, preservando blocos e contatos.
- Fluxo: editar → salvar e gerar prévia → confirmar início; pausar/retomar disponíveis conforme status.
- Índices de busca por telefone corrigem o tempo limite ao salvar listas maiores, sem remover verificações de bloqueados/ignorados/opt-out.
- Permissão de execução da função pura `private.phone_core(text)` concedida somente a `authenticated`, necessária para manter os índices ao cadastrar/corrigir contatos; testes de RLS e esquema conferidos novamente.
- Layout de campanhas testado em navegador com viewport móvel e desktop; isso não equivale a testar todo aparelho físico.

## Operação real: cuidados obrigatórios

Há campanha real iniciada pelo usuário. Estado corrente deve ser consultado no banco/painel, não inferido deste documento. Identificadores e recibos ficam **fora do Git**, em `/home/user/operacao/`.

- Não iniciar, reiniciar, reenviar ou duplicar mensagens para testar uma mudança.
- Não revogar aparelhos, limpar autenticação, trocar vínculo de chip nem apagar sessões.
- Não ligar IA globalmente para corrigir uma campanha; preservar pausas manuais por conversa.
- Campanha de voz configurada: um dos seis áudios por destinatário, sorteio, sem texto; intervalos de 60–200 s, lotes de 5–8, pausas de 300–600 s, sem restrição de horário e limite adicional diário zero (sem limite).
- Lista: 795 entradas únicas; 793 com formato nacional foram importadas. Duas sem DDD ficaram fora. Formato não é validação de existência no WhatsApp.
- Não usar destinatários da campanha como testes. Testes reais somente entre os dois números expressamente autorizados pelo usuário, documentados em operação privada.
- O laboratório `/home/user/motor-testes-jeffersonivan` tem processo e dados próprios; não é a campanha Termux. Não mover seu diretório nem tocar em `data/` ou `.runtime/` com o processo ativo.
- Sandbox de desenvolvimento não é hospedagem 24/7.

## Pendências conhecidas (não declarar resolvidas sem prova)

1. Entrada individual de mensagens no Termux: problema anterior não foi encerrado com evidência suficiente. “Conectado” e saída funcionando não provam entrada funcionando.
2. Auditoria ampla anterior identificou erro de hidratação na área de contas e aviso legado. Não corrigidos neste trabalho de organização; relatório histórico no arquivo privado.
3. Validar feedback do usuário no aparelho físico sobre o layout móvel de campanhas.
4. Preservar escopo: a organização não deve executar migrações históricas nem scripts antigos de publicação/envio.

## Como continuar sem o histórico do chat

1. Ler este arquivo, `docs/ORGANIZACAO.md` e `tests/README.md`.
2. Ler `git status`, `git log -5 --oneline` e o estado privado em `/home/user/operacao/ESTADO-PRIVADO.md` se houver operação real envolvida.
3. Inspecionar os arquivos da área antes de editar. Credenciais locais não devem ser impressas.
4. Trabalhar com testes simulados; executar check/build e os testes pertinentes.
5. Fazer commit somente de código, testes e documentação sem dados operacionais. Conferir `npm run repo:check`.
6. Conferir orçamento com `npm run workspace:check -- /home/user`.
7. Ao terminar, atualizar este resumo com fatos comprovados, testes executados e pendências. O Git guarda a história; o chat não é o único registro.
