# Ienvia Motor 6.4

## Abrir

Extraia a pasta inteira em um local particular, com permissao de escrita. Nao execute dentro do ZIP.

- **Windows:** abra `INICIAR-WINDOWS.bat`. O PowerShell prepara Node 24+ portatil, se necessario, com verificacao SHA-256. Nao exige administrador. Requer Windows compativel com Node 24 e acesso HTTPS aos servidores oficiais.
- **Linux:** execute `bash INICIAR-LINUX.sh`. O runtime e local e nao substitui o Node do sistema. Download automatico para Linux x64/ARM64 compativel com os binarios oficiais do Node. Requer bash, curl, tar/xz e sha256sum.
- **Termux:** extraia em `$HOME`, nunca em `/sdcard` ou armazenamento compartilhado. Execute `bash INICIAR-TERMUX.sh`. A preparacao instala Node/ICU pelo gerenciador do Termux, sem atualizar indiscriminadamente todos os pacotes. Git nao e requisito das dependencias desta versao.

A primeira abertura precisa de internet para preparar os componentes npm. Proximas aberturas reaproveitam os componentes verificados. Nao e um pacote de instalacao offline.

Cole o codigo temporario `IENV-XXXX-XXXX` gerado em **Conexoes / Motor**. Ele vincula o computador a conta, nao substitui a confirmacao do WhatsApp. Depois conecte o numero pelo painel. Nao informe nem salve sua senha da conta no terminal.

## Atualizacao sem intervencao

Antes de conectar os chips, o motor consulta o canal oficial. Se indisponivel, usa a versao instalada. Durante o funcionamento consulta a cada 15 minutos, com dispersao de ate 1 minuto. Valida assinatura, hash, tamanho e runtime antes de trocar os arquivos.

A transferencia ocorre em segundo plano. A aplicacao aguarda as operacoes em andamento, preserva filas e reinicia pelo supervisor. Pode existir uma breve interrupcao da conexao WhatsApp. Nao e necessario esvaziar todo o historico.

O backup de codigo e de componentes fica retido ate o processo sinalizar inicializacao e permanecer estavel por 30 segundos. Se a versao nova falhar ou nao inicializar em 3 minutos, o supervisor restaura a anterior e adia essa mesma versao por 24 horas. Isso valida saude do processo, nao garante que a internet ou o WhatsApp estejam acessiveis.

Use os iniciadores oficiais. A entrada antiga `node src/index.mjs` tambem encaminha ao supervisor. O codigo de saida 42 representa reinicio de atualizacao, nao uma falha comum.

## Dados preservados

`data/` guarda credenciais e filas. Nao apague, envie a terceiros ou publique essa pasta. `.runtime/`, `.env` e `node_modules/` nao sao substituidos pelo pacote do atualizador. Os componentes npm sao preparados em staging antes da troca; os anteriores sao retidos durante a verificacao de saude.

Somente os ultimos 30 dias sao importados como historico. Itens antigos ja pendentes ficam preservados fora da fila ativa. Mensagens novas sao prioritarias. A IA nao deve responder a importacoes. Uma fila vazia nao comprova que o WhatsApp disponibilizou todo o historico.

Uma segunda abertura na mesma pasta e bloqueada. Nao copie a mesma sessao para dois motores em execucao simultanea.

## Audio

Mensagem de voz: OGG/Opus valido, MIME com codec, duracao e forma de onda calculadas por decodificador WASM. Nao exige FFmpeg no aparelho. Limite de 16 MB e 15 minutos para processamento como voz. Outros formatos ou duracoes devem ser convertidos antes ou enviados como audio comum. O motor nao disfarca MP3 como voz.

## Inicializacao automatica (opcional)

Primeiro vincule o motor. Execute com o mesmo Node usado pelo iniciador:

```
node src/inicializacao.mjs
```

Esse comando apenas explica os requisitos. Para configurar conscientemente:

```
node src/inicializacao.mjs --ativar
```

- Linux com `systemd --user`: cria servico do usuario e habilita no proximo login. Em VPS, funcionamento sem login depende da configuracao de linger pelo administrador. Nao pressupomos systemd no antiX; nesse caso use o gerenciador de servicos da distribuicao.
- Windows: cria tarefa para o login do usuario, sem senha embutida ou privilegio elevado. Nao inicia antes do login.
- Termux: cria script particular de boot. Requer **Termux:Boot** instalado e aberto uma vez, e orientacoes de bateria. Android ainda pode encerrar o aplicativo.

Nenhuma opcao de inicializacao e ativada automaticamente na instalacao. A configuracao nao abre um segundo processo imediatamente. Arquivos existentes nunca sao sobrescritos.

## Resolver problemas

- **Painel conectado** nao significa WhatsApp conectado. Confira o estado de cada chip.
- **Reconectando:** aguarde o tempo indicado. Nao gere codigos repetidamente.
- **Sem internet:** filas ficam salvas; tentativas sao automaticas.
- **Envio incerto:** nao repita cegamente, pois pode duplicar.
- **Historico pendente:** o processamento e separado das mensagens novas.
- **Runtime incompativel:** use o iniciador da plataforma, nao um Node antigo global.
- **Relogio incorreto:** sincronize pelo mecanismo do sistema. O motor nao altera o relogio do computador.
- **Encerrar:** Ctrl+C; aguarde a drenagem. Fechar a janela a forca pode interromper operacoes, embora as filas duraveis sejam preservadas.

A interface se ajusta ao tamanho real do terminal e funciona sem cores. Logs operacionais nao devem exibir textos de conversas, QR, codigos de pareamento ou tokens na tela principal.
