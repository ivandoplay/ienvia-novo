import fs from 'node:fs';
import { iniciarPainelTerminal } from './painel-terminal.mjs';
import { invalidarAcessoRevogado, pedirNovoCodigo } from './repareamento.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectarPlataformaMotor,
  lerConfiguracao,
  metadataDoAparelho,
  normalizarCodigoPareamento,
  salvarConfiguracao,
} from './config.mjs';
import { recuperarAtualizacaoInterrompida, verificarEAtualizar } from './atualizador.mjs';
import { SupervisorDeSessoes } from './sessoes.mjs';
import { iniciarPaginaLocal } from './pagina-local.mjs';
import { iniciarEscoamento } from './escoamento.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

function lerVersaoLocal(rootDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  return pkg.version || '6.0.0';
}

function lerArgumentos(argv) {
  const args = { pair: '', url: '', checkUpdate: false, once: false, semPagina: false, porta: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pair' && argv[i + 1]) args.pair = argv[++i];
    else if (a === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (a === '--check-update') args.checkUpdate = true;
    else if (a === '--once') args.once = true;
    else if (a === '--sem-pagina' || a === '--no-ui') args.semPagina = true;
    else if ((a === '--porta' || a === '--port') && argv[i + 1]) args.porta = Number(argv[++i]) || 0;
  }
  return args;
}

export async function parearComPainel({ rootDir, panelUrl, code, versaoAtual, fetchFn = fetch }) {
  const codigo = normalizarCodigoPareamento(code);
  if (!codigo) {
    throw new Error('Código de pareamento inválido. Use o formato IENV-XXXX-XXXX.');
  }
  const baseUrl = String(panelUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('Informe o endereço do painel (ex.: https://app.ienvia.com.br).');
  }
  const resp = await fetchFn(`${baseUrl}/api/motor/parear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: codigo,
      platform: detectarPlataformaMotor(),
      version: versaoAtual,
      metadata: metadataDoAparelho(),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok || !dados.device_token) {
    throw new Error(dados.erro || `Falha no pareamento (HTTP ${resp.status}).`);
  }
  salvarConfiguracao(rootDir, {
    panelUrl: baseUrl,
    deviceToken: dados.device_token,
    executorId: dados.executor_id,
    workspaceId: dados.workspace_id,
    displayName: dados.display_name,
  });
  return dados;
}

/** Fica de olho no arquivo de configuração até o pareamento acontecer (ou até Ctrl+C). */
async function esperarPareamento(pagina, cfgInicial) {
  let cfg = cfgInicial;
  let sinalizado = false;
  const parar = () => {
    sinalizado = true;
  };
  process.once('SIGINT', parar);
  process.once('SIGTERM', parar);
  while (!sinalizado) {
    cfg = lerConfiguracao(ROOT_DIR);
    if (cfg.panelUrl && cfg.deviceToken) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  process.off('SIGINT', parar);
  process.off('SIGTERM', parar);
  if (!sinalizado) {
    console.log(`[motor] Aparelho "${cfg.displayName}" ligado ao painel ${cfg.panelUrl}.`);
  } else if (pagina) {
    console.log('[motor] Página fechada. O motor continua ligado; reabra com o comando de sempre.');
  }
  return cfg;
}

export async function rodarLoopPrincipal(args = lerArgumentos(process.argv.slice(2))) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 ou superior necessario. No Linux, inicie por bash ./scripts/iniciar.sh para preparar o runtime correto.');
  const versaoAtual = lerVersaoLocal(ROOT_DIR);

  if (recuperarAtualizacaoInterrompida(ROOT_DIR)) {
    console.log('[motor] Atualização interrompida revertida com segurança.');
  }

  let cfg = lerConfiguracao(ROOT_DIR);
  const panelUrl = (args.url || cfg.panelUrl).trim().replace(/\/+$/, '');

  if (args.pair) {
    console.log('[motor] Pareando este aparelho com o painel...');
    const res = await parearComPainel({ rootDir: ROOT_DIR, panelUrl, code: args.pair, versaoAtual });
    console.log(`[motor] Pareado com sucesso! Aparelho: ${res.display_name} (${res.executor_id})`);
    if (args.once) return;
    cfg = lerConfiguracao(ROOT_DIR);
  }

  if (args.checkUpdate) {
    if (!panelUrl) throw new Error('Endereço do painel não configurado.');
    const upd = await verificarEAtualizar({ rootDir: ROOT_DIR, panelUrl, versaoAtual });
    console.log('[motor] Verificação de atualização:', upd);
    return;
  }

  // Sem pareamento: em vez de morrer com uma linha de erro, abre a página local para a pessoa
  // ligar o aparelho (senha da conta ou código). O loop só começa depois que o pareamento existe.
  if ((!cfg.panelUrl || !cfg.deviceToken) && process.stdin.isTTY) {
    const ok = await pedirNovoCodigo({
      parear: code => parearComPainel({ rootDir: ROOT_DIR, panelUrl: panelUrl || 'https://app.ienvia.online', code, versaoAtual }),
    });
    if (!ok) return;
    cfg = lerConfiguracao(ROOT_DIR);
  }
  if (!cfg.panelUrl || !cfg.deviceToken) {
    if (args.semPagina) {
      console.error('[motor] Aparelho ainda não pareado.');
      console.error('Rode sem --sem-pagina para abrir a página do motor, ou use:');
      console.error('  node src/index.mjs --url https://app.ienvia.online --pair IENV-XXXX-XXXX');
      process.exitCode = 1;
      return;
    }

    let pagina;
    try {
      pagina = await iniciarPaginaLocal({
        rootDir: ROOT_DIR,
        porta: args.porta || Number(process.env.IENVIA_MOTOR_PORTA || 4599),
        lerConfiguracao,
        salvarConfiguracao,
      });
    } catch (err) {
      console.error(`[motor] Não consegui abrir a página local (${err.message}).`);
      console.error('Use o modo terminal: node src/index.mjs --url https://app.ienvia.online --pair IENV-XXXX-XXXX');
      process.exitCode = 1;
      return;
    }

    cfg = await esperarPareamento(pagina, cfg);
    await pagina.fechar();
    if (!cfg.panelUrl || !cfg.deviceToken) {
      console.error('[motor] Página fechada sem pareamento. Nada foi alterado.');
      process.exitCode = 1;
      return;
    }
  }

  console.log(`[motor] Ienvia Motor v${versaoAtual} iniciado (${detectarPlataformaMotor()}) — painel: ${cfg.panelUrl}`);
  const supervisor = new SupervisorDeSessoes({
    rootDir: ROOT_DIR,
    panelUrl: cfg.panelUrl,
    deviceToken: cfg.deviceToken,
    onLog: () => {}, // O painel exibe estados; nao despejar logs internos na tela.
  });

  let estadoPainel = 'Conectando';
  let avisoOperacao = '';
  const painel = args.once ? null : iniciarPainelTerminal({ obterVisao: () => {
    const fila = supervisor.filaHistorico.contagem();
    const chips = [...supervisor.estados].map(([id, e]) => ({ desde: e.desde, nome: supervisor.nomes.get(id) || 'WhatsApp', estado: e.estado, emSegundos: e.proxima ? Math.max(1, Math.ceil((e.proxima-Date.now())/1000)) : null }));
    const comProblema = chips.find(c => c.estado === 'reconnecting' || c.estado === 'disconnected' || c.estado === 'pairing');
    return { versao: versaoAtual, painel: estadoPainel, chips, live: fila.live, history: fila.history, recebidas: supervisor.historicoRecebido, envios: supervisor.enviosAtivos,
      sincronizacao: fila.history ? 'Importando' : supervisor.ultimoHistorico ? 'Lotes recebidos processados' : 'Aguardando WhatsApp',
      aviso: avisoOperacao || (comProblema?.estado === 'pairing' ? 'Abra o painel para concluir o QR ou codigo do WhatsApp.' : comProblema?.estado === 'reconnecting' ? (Date.now()-(comProblema.desde || Date.now()) > 300000 ? 'Sem WhatsApp ha mais de 5 min. Verifique a rede; novas tentativas continuam.' : 'Conexao caiu. Reconectando automaticamente.') : comProblema ? 'Abra o painel e verifique o numero desconectado.' : '') };
  }});
  const pendencias = supervisor.filaHistorico.contagem();
  console.log(`[motor] Fila prioritária: ${pendencias.live} novas; ${pendencias.history} históricas. Processamento independente ativado.`);
  const pararEscoamento = args.once ? async () => {} : iniciarEscoamento(supervisor, { onError: () => { avisoOperacao = 'Comunicacao instavel. Filas preservadas para nova tentativa.'; } });
  let encerrado = false;
  let acessoRevogado = false;
  const parar = async () => {
    if (encerrado) return;
    encerrado = true;
    supervisor.encerrando = true;
    await pararEscoamento();
    await supervisor.encerrarTudo();
  };
  process.once('SIGINT', parar);
  process.once('SIGTERM', parar);

  let ultimoPulso = 0;
  let ultimaChecagemUpdate = 0;
  const plataforma = detectarPlataformaMotor();
  const meta = metadataDoAparelho();

  try {
  while (!encerrado) {
    const agora = Date.now();

    if (agora - ultimoPulso >= 25_000) {
      ultimoPulso = agora;
      try {
        const pulso = await supervisor.chamarApi('/api/motor/pulso', {
          platform: plataforma,
          version: versaoAtual,
          metadata: { ...meta, diagnostico: supervisor.diagnosticoOperacional() },
        });
        estadoPainel = 'Conectado';
        avisoOperacao = '';
        for (const inst of pulso.instances || []) {
          supervisor.nomes.set(inst.id, inst.display_name || inst.name || 'WhatsApp');
          if (!supervisor.estados.has(inst.id)) supervisor.estados.set(inst.id, { estado: inst.status });
          if ((inst.status === 'connected' || (['connecting','disconnected'].includes(inst.status) && supervisor.intencoes.tem(inst.id))) && !supervisor.sessoes.has(inst.id) && !supervisor.reconexoes.has(inst.id)) {
            const cred = path.join(ROOT_DIR, 'data', 'wa_auth', inst.id, 'creds.json');
            if (fs.existsSync(cred)) {
              supervisor.iniciarConexao(inst.id, { mode: 'qr' }).catch(() => {
                if (!supervisor.encerrando) supervisor.agendarReconexao(inst.id, { mode: 'qr', tentativa: 1 }, 4000);
              });
            }
          }
        }
      } catch (err) {
        estadoPainel = 'Sem comunicacao';
        avisoOperacao = 'Sem acesso ao painel. Verifique a internet; nova tentativa automatica.';
        if (err.status === 401) {
          console.error('[motor] Acesso revogado. Voltando ao pareamento com um novo código.');
          acessoRevogado = true;
          await parar();
          break;
        }
        console.warn(`[motor] Falha no heartbeat: ${err.message}`);
      }
    }

    try {
      const lote = await supervisor.chamarApi('/api/motor/comandos', null, 'GET');
      for (const cmd of lote.commands || []) {
        await supervisor.executarComando(cmd);
      }
    } catch (err) {
      avisoOperacao = 'Consulta de comandos indisponivel. Verifique a rede; nova tentativa automatica.';
      if (err.status === 401) {
        console.error('[motor] Acesso revogado. Voltando ao pareamento com um novo código.');
        acessoRevogado = true;
        await parar();
        break;
      }
    }

    if (args.once) await supervisor.escoarHistorico().catch(err => console.error('[motor] Histórico pendente:', err.message));

    if (agora - ultimaChecagemUpdate >= 10 * 60_000) {
      ultimaChecagemUpdate = agora;
      let drenagemDaAtualizacao = false;
      try {
        const upd = await verificarEAtualizar({ rootDir: ROOT_DIR, panelUrl: cfg.panelUrl, versaoAtual, antesDeAplicar: async () => {
          if (encerrado) throw new Error('Encerramento solicitado');
          drenagemDaAtualizacao = true;
          avisoOperacao = 'Atualizacao validada. Salvando filas e reiniciando automaticamente.';
          painel?.atualizar();
          await parar();
        } });
        if (upd.updated) {
          console.log(`[motor] Atualizado para v${upd.newVersion}! Reinicie ou aguarde o launcher.`);
          await parar();
          process.off('SIGINT', parar); process.off('SIGTERM', parar);
          process.exitCode = 42;
          return;
        }
      } catch (err) {
        if (drenagemDaAtualizacao) { process.exitCode = 42; return; }
        if (encerrado) return;
        avisoOperacao = 'Atualizacao adiada com seguranca. Nova tentativa automatica.';
        console.warn(`[motor] Checagem de atualização ignorada: ${err.message}`);
      }
    }

    if (args.once) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  } finally {
    painel?.parar();
    process.off('SIGINT', parar); process.off('SIGTERM', parar);
  }
  process.off('SIGINT', parar); process.off('SIGTERM', parar);
  if (acessoRevogado) {
    invalidarAcessoRevogado(ROOT_DIR, cfg.panelUrl);
    if (args.once) { process.exitCode = 1; return; }
    return 'reparear';
  }
}

export async function iniciarMotor() {
  let args = lerArgumentos(process.argv.slice(2));
  while (await rodarLoopPrincipal(args) === 'reparear') {
    // Código de uso único da primeira inicialização nunca é reutilizado.
    args = { ...args, pair: '' };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  iniciarMotor().catch((err) => {
    console.error('[motor] Erro fatal:', err.message);
    process.exitCode = 1;
  });
}
