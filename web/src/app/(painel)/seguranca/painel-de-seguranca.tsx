'use client';

import { useState, useTransition } from 'react';
import {
  EVENTOS_ALERTA_SEGURANCA_INFO,
  PRESETS_ANTIBAN,
  formatarTelefoneLegivel,
  type ConfiguracaoDeSeguranca,
  type EventoAlertaSeguranca,
  type ModoHorario,
  type PresetAntiban,
} from '@ienvia/shared/seguranca';
import {
  importarDestinatariosDeTexto,
  importarDestinatariosDeXlsx,
  type ResultadoImportacaoDestinatarios,
} from '@ienvia/shared/campanhas-importacao';
import { Icone } from '@/components/ui/icone';
import type { DadosDaFilaSegura, DadosDeSeguranca, ListaIgnorados } from '@/lib/dados/seguranca';
import {
  adicionarNumeroIgnorado,
  iniciarFilaSegura,
  limparFilaSegura,
  pausarFilaSegura,
  removerNumeroIgnorado,
  resolverIncertoDaFila,
  retomarFilaSegura,
  salvarRegrasDeSeguranca,
  testarAlertaDeSeguranca,
} from './acoes';

export type SecaoSeguranca = 'antiban' | 'horario' | 'fila' | 'ignorados';

interface Props {
  dados: DadosDeSeguranca;
  secaoInicial: SecaoSeguranca;
}

const PRESETS: Array<{ id: PresetAntiban; titulo: string; desc: string }> = [
  {
    id: 'conservador',
    titulo: 'Conservador',
    desc: 'Chip novo ou aquecendo: ritmo mais lento, pausas maiores e limite diário baixo (15/dia).',
  },
  {
    id: 'equilibrado',
    titulo: 'Equilibrado',
    desc: 'Recomendado para o dia a dia: resposta natural e até 25 abordagens ativas/dia por chip.',
  },
  {
    id: 'moderado',
    titulo: 'Moderado',
    desc: 'Chip antigo e estável: respostas rápidas mantendo proteção contra loop e até 40/dia.',
  },
  {
    id: 'personalizado',
    titulo: 'Personalizado',
    desc: 'Ajuste cada tempo, cadência e limite exatamente como preferir.',
  },
];

const DIAS_SEMANA = [
  { num: 0, rotulo: 'Dom' },
  { num: 1, rotulo: 'Seg' },
  { num: 2, rotulo: 'Ter' },
  { num: 3, rotulo: 'Qua' },
  { num: 4, rotulo: 'Qui' },
  { num: 5, rotulo: 'Sex' },
  { num: 6, rotulo: 'Sáb' },
];

const FUSOS = [
  { id: 'America/Fortaleza', rotulo: 'Brasília / Nordeste (Fortaleza · UTC-3)' },
  { id: 'America/Sao_Paulo', rotulo: 'São Paulo (UTC-3)' },
  { id: 'America/Manaus', rotulo: 'Manaus (UTC-4)' },
  { id: 'America/Belem', rotulo: 'Belém (UTC-3)' },
  { id: 'America/Rio_Branco', rotulo: 'Rio Branco (UTC-5)' },
];

const ROTULO_STATUS_FILA: Record<string, string> = {
  idle: 'Parada',
  running: 'Enviando em ritmo seguro',
  paused: 'Pausada',
  completed: 'Concluída',
};

const ROTULO_ITEM_FILA: Record<string, { texto: string; classe: string }> = {
  pending: { texto: 'Na fila', classe: 'estado' },
  sending: { texto: 'Enviando…', classe: 'estado estado--ia' },
  awaiting_human_confirmation: { texto: 'Sem confirmação', classe: 'estado estado--atencao' },
  sent: { texto: 'Enviada', classe: 'estado estado--ok' },
  failed: { texto: 'Não enviada', classe: 'estado' },
  suppressed: { texto: 'Suprimida', classe: 'estado' },
};

const MOTIVO_PAUSA_FILA: Record<string, string> = {
  manual: 'Pausada manualmente por alguém da equipe.',
  uncertain_send: 'Pausada por segurança: uma mensagem ficou sem confirmação. Confira abaixo antes de retomar.',
  chip_offline: 'Pausada porque o chip desconectou ou o Motor local ficou offline.',
  daily_limit: 'Pausada porque os chips conectados atingiram o teto diário configurado.',
};

const MOTIVO_SUPRESSAO: Record<string, string> = {
  ignored: 'Número ignorado',
  opted_out: 'Pediu para parar',
  blocked: 'Bloqueado',
  own_chip: 'Chip próprio',
  invalid_phone: 'Número inválido',
};

export function PainelDeSeguranca({ dados, secaoInicial }: Props) {
  const [aba, setAba] = useState<SecaoSeguranca>(secaoInicial);
  const [cfg, setCfg] = useState<ConfiguracaoDeSeguranca>(dados.configuracao);
  const [ignorados, setIgnorados] = useState<ListaIgnorados>(dados.ignorados);
  const [fila, setFila] = useState<DadosDaFilaSegura>(dados.fila);

  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [pendente, iniciarTransicao] = useTransition();

  // Contatos ignorados
  const [novoNome, setNovoNome] = useState('');
  const [novoTelefone, setNovoTelefone] = useState('');
  const [novaNota, setNovaNota] = useState('');

  // Fila segura
  const [modoFila, setModoFila] = useState<'auto_rotate' | 'single'>(fila.state.mode);
  const [chipFilaId, setChipFilaId] = useState<string>(fila.state.fixed_instance_id ?? fila.chips[0]?.id ?? '');
  const [modeloFila, setModeloFila] = useState<string>(
    fila.state.message_template || 'Olá {{primeiro_nome}}, tudo bem? Estou passando para confirmar se podemos conversar rapidinho.',
  );
  const [textoContatosFila, setTextoContatosFila] = useState('');
  const [importacaoFila, setImportacaoFila] = useState<ResultadoImportacaoDestinatarios | null>(null);

  const podeEditar = dados.podeEditarRegras;
  const chipsConectadosCampanha = fila.chips.filter((c) => c.status === 'connected');

  function selecionarPreset(preset: PresetAntiban) {
    if (!podeEditar) return;
    const encontrado = PRESETS_ANTIBAN.find((p) => p.valor === preset);
    setCfg((atual) =>
      encontrado
        ? {
            ...atual,
            antibanPreset: preset,
            minTypingMs: encontrado.minTypingMs,
            maxTypingMs: encontrado.maxTypingMs,
            maxRepliesPerMinutePerContact: encontrado.maxRepliesPerMinutePerContact,
            proactiveMinDelaySec: encontrado.proactiveMinDelaySec,
            proactiveMaxDelaySec: encontrado.proactiveMaxDelaySec,
            dailyProactiveLimit: encontrado.dailyProactiveLimit,
          }
        : { ...atual, antibanPreset: 'personalizado' },
    );
  }

  function atualizarCampo<K extends keyof ConfiguracaoDeSeguranca>(chave: K, valor: ConfiguracaoDeSeguranca[K], marcarPersonalizado = true) {
    setCfg((atual) => ({
      ...atual,
      [chave]: valor,
      ...(marcarPersonalizado ? { antibanPreset: 'personalizado' as const } : {}),
    }));
  }

  function alternarDia(dia: number) {
    if (!podeEditar) return;
    setCfg((atual) => {
      const existe = atual.scheduleWorkDays.includes(dia);
      const proximo = existe
        ? atual.scheduleWorkDays.filter((d) => d !== dia)
        : [...atual.scheduleWorkDays, dia].sort((a, b) => a - b);
      return { ...atual, scheduleWorkDays: proximo };
    });
  }

  function alternarEvento(evento: EventoAlertaSeguranca) {
    if (!podeEditar) return;
    setCfg((atual) => {
      const existe = atual.adminAlertEvents.includes(evento);
      const proximo = existe
        ? atual.adminAlertEvents.filter((e) => e !== evento)
        : [...atual.adminAlertEvents, evento];
      return { ...atual, adminAlertEvents: proximo };
    });
  }

  function salvarSeguranca() {
    setAviso(null);
    iniciarTransicao(async () => {
      const res = await salvarRegrasDeSeguranca(cfg);
      if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
      else setAviso({ tipo: 'ok', texto: 'Regras de segurança salvas com sucesso.' });
    });
  }

  function dispararTesteAlerta() {
    setAviso(null);
    iniciarTransicao(async () => {
      const resSave = await salvarRegrasDeSeguranca(cfg);
      if (!resSave.ok) {
        setAviso({ tipo: 'erro', texto: resSave.erro });
        return;
      }
      const res = await testarAlertaDeSeguranca();
      if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
      else setAviso({ tipo: 'ok', texto: 'Alerta de teste enviado para o WhatsApp configurado.' });
    });
  }

  function adicionarIgnorado() {
    setAviso(null);
    iniciarTransicao(async () => {
      const res = await adicionarNumeroIgnorado({ name: novoNome, phone: novoTelefone, note: novaNota });
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        return;
      }
      setIgnorados(res.lista);
      setNovoNome('');
      setNovoTelefone('');
      setNovaNota('');
      setAviso({ tipo: 'ok', texto: 'Contato adicionado à lista de ignorados (IA e campanhas não respondem).' });
    });
  }

  function removerIgnorado(id?: string, contactId?: string) {
    setAviso(null);
    iniciarTransicao(async () => {
      const res = await removerNumeroIgnorado({ id: id ?? null, contactId: contactId ?? null });
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        return;
      }
      setIgnorados(res.lista);
      setAviso({ tipo: 'ok', texto: 'Número removido da lista de ignorados.' });
    });
  }

  async function importarArquivoFila(file: File | null) {
    if (!file) return;
    setAviso(null);
    try {
      const isXlsx = file.name.toLowerCase().endsWith('.xlsx');
      const resultado = isXlsx
        ? await importarDestinatariosDeXlsx(new Uint8Array(await file.arrayBuffer()))
        : importarDestinatariosDeTexto(await file.text());
      setImportacaoFila(resultado);
      setAviso({
        tipo: resultado.validos.length > 0 ? 'ok' : 'erro',
        texto:
          resultado.validos.length > 0
            ? `${resultado.validos.length} contatos válidos carregados de ${file.name}.`
            : 'Nenhum telefone válido encontrado no arquivo.',
      });
    } catch (erro) {
      setAviso({
        tipo: 'erro',
        texto: erro instanceof Error ? erro.message : 'Não foi possível ler este arquivo.',
      });
    }
  }

  function contatosResolvidosDaFila(): Array<{ name: string; phone: string }> {
    if (importacaoFila && importacaoFila.validos.length > 0 && !textoContatosFila.trim()) {
      return importacaoFila.validos.map((c) => ({ name: c.nome, phone: c.telefone }));
    }
    if (textoContatosFila.trim()) {
      const parsed = importarDestinatariosDeTexto(textoContatosFila);
      return parsed.validos.map((c) => ({ name: c.nome, phone: c.telefone }));
    }
    return [];
  }

  function aoIniciarFila() {
    setAviso(null);
    const lista = contatosResolvidosDaFila();
    if (lista.length === 0) {
      setAviso({ tipo: 'erro', texto: 'Suba uma planilha ou cole pelo menos um telefone válido.' });
      return;
    }
    iniciarTransicao(async () => {
      const res = await iniciarFilaSegura({
        mode: modoFila,
        instanceId: modoFila === 'single' ? chipFilaId || null : null,
        template: modeloFila,
        recipients: lista,
      });
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        return;
      }
      setFila(res.fila);
      setAviso({
        tipo: 'ok',
        texto: `Fila segura iniciada: ${res.elegiveis ?? 0} elegível(is) e ${res.suprimidos ?? 0} suprimido(s) automaticamente.`,
      });
    });
  }

  function acaoFila(fn: () => Promise<Awaited<ReturnType<typeof pausarFilaSegura>>>, mensagemOk: string) {
    setAviso(null);
    iniciarTransicao(async () => {
      const res = await fn();
      if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
      else {
        setFila(res.fila);
        setAviso({ tipo: 'ok', texto: mensagemOk });
      }
    });
  }

  const totalPendenteFila = fila.counts.pending + fila.counts.sending + fila.counts.awaiting_human_confirmation;

  return (
    <div className="f5-pagina">
      <div className="page-header">
        <div>
          <h1>Segurança &amp; Proteção</h1>
          <p>Proteção anti-bloqueio, horário de atendimento, alertas no WhatsApp, fila segura e contatos ignorados.</p>
        </div>
      </div>

      {dados.erroLeitura && (
        <div className="f5-aviso-topo f5-aviso-topo--alerta" role="alert">
          <span>{dados.erroLeitura}</span>
        </div>
      )}

      {aviso && (
        <div
          className={`f5-aviso-topo ${aviso.tipo === 'ok' ? 'f5-aviso-topo--ok' : 'f5-aviso-topo--alerta'}`}
          role={aviso.tipo === 'erro' ? 'alert' : 'status'}
        >
          <span>{aviso.texto}</span>
          <button type="button" className="btn btn-secondary" onClick={() => setAviso(null)}>
            Fechar
          </button>
        </div>
      )}

      <div className="f5-abas" role="tablist" aria-label="Seções de Segurança">
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'antiban'}
          className={`f5-aba ${aba === 'antiban' ? 'ativa' : ''}`}
          onClick={() => setAba('antiban')}
        >
          <Icone nome="seguranca" className="icon-15" />
          <span>Anti-ban &amp; Cadência</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'horario'}
          className={`f5-aba ${aba === 'horario' ? 'ativa' : ''}`}
          onClick={() => setAba('horario')}
        >
          <Icone nome="calendario" className="icon-15" />
          <span>Horário &amp; Alertas</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'fila'}
          className={`f5-aba ${aba === 'fila' ? 'ativa' : ''}`}
          onClick={() => setAba('fila')}
        >
          <Icone nome="raio" className="icon-15" />
          <span>Fila Segura ({totalPendenteFila})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'ignorados'}
          className={`f5-aba ${aba === 'ignorados' ? 'ativa' : ''}`}
          onClick={() => setAba('ignorados')}
        >
          <Icone nome="bloqueado" className="icon-15" />
          <span>Contatos Ignorados ({ignorados.manual.length + ignorados.contacts.length})</span>
        </button>
      </div>

      {aba === 'antiban' && (
        <div className="f5-pagina">
          {!podeEditar && (
            <div className="f5-aviso-topo f5-aviso-topo--alerta">
              <span>Você pode consultar as regras da empresa. Só o dono da conta altera limites anti-ban e horários.</span>
            </div>
          )}

          <div className="f5-card">
            <div className="f5-card-topo">
              <div>
                <h2 className="f5-card-titulo">Perfil de proteção anti-bloqueio</h2>
                <p className="f5-card-sub">
                  Escolha um ritmo pronto ou personalize o comportamento da IA e dos envios ativos na fila segura.
                </p>
              </div>
            </div>
            <div className="f5-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={!podeEditar}
                  className={`f5-preset ${cfg.antibanPreset === p.id ? 'ativo' : ''}`}
                  onClick={() => selecionarPreset(p.id)}
                >
                  <span className="f5-preset-titulo">{p.titulo}</span>
                  <span className="f5-preset-desc">{p.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="f5-grade-2">
            <div className="f5-card">
              <div>
                <h2 className="f5-card-titulo">Humanização da IA</h2>
                <p className="f5-card-sub">Ajustes que valem em conjunto com a aba Motor de IA.</p>
              </div>

              <div className="f5-grade-2">
                <div className="campo">
                  <label htmlFor="sec-min-typing">Digitando mínimo (ms)</label>
                  <input
                    id="sec-min-typing"
                    type="number"
                    min={500}
                    max={10000}
                    disabled={!podeEditar}
                    value={cfg.minTypingMs}
                    onChange={(e) => atualizarCampo('minTypingMs', Number(e.target.value) || 500)}
                  />
                </div>
                <div className="campo">
                  <label htmlFor="sec-max-typing">Digitando máximo (ms)</label>
                  <input
                    id="sec-max-typing"
                    type="number"
                    min={1000}
                    max={15000}
                    disabled={!podeEditar}
                    value={cfg.maxTypingMs}
                    onChange={(e) => atualizarCampo('maxTypingMs', Number(e.target.value) || 1000)}
                  />
                </div>
              </div>

              <div className="f5-grade-2">
                <div className="campo">
                  <label htmlFor="sec-debounce">Juntar mensagens do cliente (seg)</label>
                  <input
                    id="sec-debounce"
                    type="number"
                    min={1}
                    max={20}
                    disabled={!podeEditar}
                    value={cfg.debounceSeconds}
                    onChange={(e) => atualizarCampo('debounceSeconds', Number(e.target.value) || 1)}
                  />
                </div>
                <div className="campo">
                  <label htmlFor="sec-rate">Máx. respostas IA / min por contato</label>
                  <input
                    id="sec-rate"
                    type="number"
                    min={1}
                    max={60}
                    disabled={!podeEditar}
                    value={cfg.maxRepliesPerMinutePerContact}
                    onChange={(e) => atualizarCampo('maxRepliesPerMinutePerContact', Number(e.target.value) || 1)}
                  />
                </div>
              </div>

              <div className="interruptor">
                <input
                  id="sec-sim-typing"
                  type="checkbox"
                  disabled={!podeEditar}
                  checked={cfg.simulateTyping}
                  onChange={(e) => atualizarCampo('simulateTyping', e.target.checked)}
                />
                <div className="interruptor-texto">
                  <label htmlFor="sec-sim-typing">Simular &ldquo;digitando…&rdquo; antes de enviar</label>
                  <p>Calcula um tempo proporcional ao texto entre o mínimo e o máximo acima.</p>
                </div>
              </div>

              <div className="interruptor">
                <input
                  id="sec-split"
                  type="checkbox"
                  disabled={!podeEditar}
                  checked={cfg.splitLongMessages}
                  onChange={(e) => atualizarCampo('splitLongMessages', e.target.checked)}
                />
                <div className="interruptor-texto">
                  <label htmlFor="sec-split">Dividir respostas compridas em balões</label>
                  <p>Evita paredes de texto únicas e imita conversa humana natural.</p>
                </div>
              </div>

              <div className="interruptor">
                <input
                  id="sec-human-pause"
                  type="checkbox"
                  disabled={!podeEditar}
                  checked={cfg.pauseOnHumanReply}
                  onChange={(e) => atualizarCampo('pauseOnHumanReply', e.target.checked)}
                />
                <div className="interruptor-texto">
                  <label htmlFor="sec-human-pause">Pausar IA quando uma pessoa responder</label>
                  <p>Vale para respostas pelo painel ou direto do celular do chip.</p>
                </div>
              </div>

              <div className="campo">
                <label htmlFor="sec-pause-min">Tempo da pausa humana (minutos)</label>
                <input
                  id="sec-pause-min"
                  type="number"
                  min={5}
                  max={1440}
                  disabled={!podeEditar}
                  value={cfg.humanPauseMinutes}
                  onChange={(e) => atualizarCampo('humanPauseMinutes', Number(e.target.value) || 5)}
                />
              </div>
            </div>

            <div className="f5-card">
              <div>
                <h2 className="f5-card-titulo">Cadência da Fila Segura</h2>
                <p className="f5-card-sub">
                  Intervalos aleatórios e teto diário por chip para abordagem ativa sem disparo em rajada.
                </p>
              </div>

              <div className="f5-grade-2">
                <div className="campo">
                  <label htmlFor="sec-proactive-min">Intervalo mínimo (seg)</label>
                  <input
                    id="sec-proactive-min"
                    type="number"
                    min={20}
                    max={600}
                    disabled={!podeEditar}
                    value={cfg.proactiveMinDelaySec}
                    onChange={(e) => atualizarCampo('proactiveMinDelaySec', Number(e.target.value) || 20)}
                  />
                </div>
                <div className="campo">
                  <label htmlFor="sec-proactive-max">Intervalo máximo (seg)</label>
                  <input
                    id="sec-proactive-max"
                    type="number"
                    min={30}
                    max={900}
                    disabled={!podeEditar}
                    value={cfg.proactiveMaxDelaySec}
                    onChange={(e) => atualizarCampo('proactiveMaxDelaySec', Number(e.target.value) || 30)}
                  />
                </div>
              </div>

              <div className="campo">
                <label htmlFor="sec-daily-limit">Teto diário de abordagens na fila por chip</label>
                <input
                  id="sec-daily-limit"
                  type="number"
                  min={1}
                  max={150}
                  disabled={!podeEditar}
                  value={cfg.dailyProactiveLimit}
                  onChange={(e) => atualizarCampo('dailyProactiveLimit', Number(e.target.value) || 1)}
                />
              </div>

              {podeEditar && (
                <div className="f5-acoes-rodape">
                  <button type="button" className="btn btn-primary" disabled={pendente} onClick={salvarSeguranca}>
                    {pendente ? 'Salvando…' : 'Salvar regras de segurança'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {aba === 'horario' && (
        <div className="f5-grade-2">
          <div className="f5-card">
            <div>
              <h2 className="f5-card-titulo">Horário de funcionamento da IA</h2>
              <p className="f5-card-sub">
                Fora da janela permitida, a conversa vai para &ldquo;Esperando você&rdquo; e pode enviar um aviso automático.
              </p>
            </div>

            <div className="campo">
              <label htmlFor="sec-sched-mode">Modo de horário</label>
              <select
                id="sec-sched-mode"
                disabled={!podeEditar}
                value={cfg.scheduleMode}
                onChange={(e) => atualizarCampo('scheduleMode', e.target.value as ModoHorario, false)}
              >
                <option value="always">24 horas (atender sempre)</option>
                <option value="business_hours_only">Somente no horário comercial configurado</option>
                <option value="outside_hours_only">Somente fora do horário comercial (plantão)</option>
              </select>
            </div>

            <div className="f5-grade-2">
              <div className="campo">
                <label htmlFor="sec-sched-start">Início do expediente</label>
                <input
                  id="sec-sched-start"
                  type="time"
                  disabled={!podeEditar || cfg.scheduleMode === 'always'}
                  value={cfg.scheduleStart}
                  onChange={(e) => atualizarCampo('scheduleStart', e.target.value, false)}
                />
              </div>
              <div className="campo">
                <label htmlFor="sec-sched-end">Fim do expediente</label>
                <input
                  id="sec-sched-end"
                  type="time"
                  disabled={!podeEditar || cfg.scheduleMode === 'always'}
                  value={cfg.scheduleEnd}
                  onChange={(e) => atualizarCampo('scheduleEnd', e.target.value, false)}
                />
              </div>
            </div>

            <div className="campo">
              <label>Dias ativos na janela</label>
              <div className="f5-dias">
                {DIAS_SEMANA.map((d) => (
                  <button
                    key={d.num}
                    type="button"
                    disabled={!podeEditar || cfg.scheduleMode === 'always'}
                    className={`f5-dia ${cfg.scheduleWorkDays.includes(d.num) ? 'ativo' : ''}`}
                    onClick={() => alternarDia(d.num)}
                  >
                    {d.rotulo}
                  </button>
                ))}
              </div>
            </div>

            <div className="campo">
              <label htmlFor="sec-tz">Fuso horário</label>
              <select
                id="sec-tz"
                disabled={!podeEditar}
                value={cfg.scheduleTimezone}
                onChange={(e) => atualizarCampo('scheduleTimezone', e.target.value, false)}
              >
                {FUSOS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.rotulo}
                  </option>
                ))}
              </select>
            </div>

            <div className="campo">
              <label htmlFor="sec-off-msg">Resposta automática fora do horário (opcional)</label>
              <textarea
                id="sec-off-msg"
                rows={3}
                disabled={!podeEditar || cfg.scheduleMode === 'always'}
                placeholder="Ex.: Olá! Nosso atendimento funciona de segunda a sábado, das 08h às 18h. Assim que abrirmos, respondemos por aqui!"
                value={cfg.offHoursReplyMessage}
                onChange={(e) => atualizarCampo('offHoursReplyMessage', e.target.value, false)}
              />
              <small>Envia no máximo uma vez a cada 6 horas por conversa para evitar loop.</small>
            </div>
          </div>

          <div className="f5-card">
            <div>
              <h2 className="f5-card-titulo">Alertas administrativos no WhatsApp</h2>
              <p className="f5-card-sub">
                Receba avisos imediatos quando a IA pedir ajuda, um chip desconectar ou um disparo de campanha ficar incerto.
              </p>
            </div>

            <div className="interruptor">
              <input
                id="sec-alert-on"
                type="checkbox"
                disabled={!podeEditar}
                checked={cfg.adminAlertEnabled}
                onChange={(e) => atualizarCampo('adminAlertEnabled', e.target.checked, false)}
              />
              <div className="interruptor-texto">
                <label htmlFor="sec-alert-on">Ativar alertas no meu WhatsApp</label>
                <p>Usa qualquer chip conectado da empresa (Evolution ou Motor local) sem poluir sua Inbox.</p>
              </div>
            </div>

            <div className="campo">
              <label htmlFor="sec-alert-wa">WhatsApp do responsável (DDD + número)</label>
              <input
                id="sec-alert-wa"
                type="text"
                disabled={!podeEditar}
                placeholder="5586999990000"
                value={cfg.adminAlertWhatsapp}
                onChange={(e) => atualizarCampo('adminAlertWhatsapp', e.target.value, false)}
              />
            </div>

            <div className="campo">
              <label>Eventos que disparam aviso</label>
              <div className="f5-pagina">
                {EVENTOS_ALERTA_SEGURANCA_INFO.map((ev) => (
                  <div key={ev.valor} className="interruptor">
                    <input
                      id={`sec-ev-${ev.valor}`}
                      type="checkbox"
                      disabled={!podeEditar}
                      checked={cfg.adminAlertEvents.includes(ev.valor)}
                      onChange={() => alternarEvento(ev.valor)}
                    />
                    <div className="interruptor-texto">
                      <label htmlFor={`sec-ev-${ev.valor}`}>{ev.rotulo}</label>
                      <p>{ev.descricao}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="interruptor">
              <input
                id="sec-alert-msgs"
                type="checkbox"
                disabled={!podeEditar}
                checked={cfg.adminAlertIncludeMessages}
                onChange={(e) => atualizarCampo('adminAlertIncludeMessages', e.target.checked, false)}
              />
              <div className="interruptor-texto">
                <label htmlFor="sec-alert-msgs">Incluir últimas mensagens do cliente no dossiê</label>
                <p>Ajuda a resumir o contexto antes de você abrir a conversa.</p>
              </div>
            </div>

            {podeEditar && (
              <div className="f5-acoes-rodape">
                <button type="button" className="btn btn-secondary" disabled={pendente} onClick={dispararTesteAlerta}>
                  Enviar alerta de teste
                </button>
                <button type="button" className="btn btn-primary" disabled={pendente} onClick={salvarSeguranca}>
                  {pendente ? 'Salvando…' : 'Salvar horário e alertas'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {aba === 'fila' && (
        <div className="f5-pagina">
          {fila.state.pause_reason && (
            <div className="f5-aviso-topo f5-aviso-topo--alerta" role="alert">
              <span>{MOTIVO_PAUSA_FILA[fila.state.pause_reason] ?? 'Fila pausada.'}</span>
            </div>
          )}

          <div className="f5-metricas">
            <div className="f5-metrica">
              <span className="f5-metrica-val">{ROTULO_STATUS_FILA[fila.state.status] ?? fila.state.status}</span>
              <span className="f5-metrica-rot">Situação atual</span>
            </div>
            <div className="f5-metrica">
              <span className="f5-metrica-val">{fila.counts.pending}</span>
              <span className="f5-metrica-rot">Na fila</span>
            </div>
            <div className="f5-metrica">
              <span className="f5-metrica-val">{fila.counts.sent}</span>
              <span className="f5-metrica-rot">Enviadas</span>
            </div>
            <div className="f5-metrica">
              <span className="f5-metrica-val">{fila.counts.suppressed}</span>
              <span className="f5-metrica-rot">Suprimidas</span>
            </div>
            <div className="f5-metrica">
              <span className="f5-metrica-val">{fila.counts.failed}</span>
              <span className="f5-metrica-rot">Falhas</span>
            </div>
            <div className="f5-metrica">
              <span className="f5-metrica-val">{fila.counts.awaiting_human_confirmation}</span>
              <span className="f5-metrica-rot">Sem confirmação</span>
            </div>
          </div>

          <div className="f5-card">
            <div className="f5-card-topo">
              <div>
                <h2 className="f5-card-titulo">Envios de hoje por chip (teto diário: {fila.daily_limit})</h2>
                <p className="f5-card-sub">
                  O modo rodízio só alterna entre chips aptos para campanhas; no modo chip fixo nunca há troca escondida.
                </p>
              </div>
              <div className="f5-bloco-acoes">
                {fila.state.status === 'running' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={pendente}
                    onClick={() => acaoFila(pausarFilaSegura, 'Fila segura pausada.')}
                  >
                    Pausar fila
                  </button>
                )}
                {fila.state.status === 'paused' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={pendente}
                    onClick={() => acaoFila(retomarFilaSegura, 'Fila segura retomada.')}
                  >
                    Retomar fila
                  </button>
                )}
                {(fila.counts.pending > 0 || fila.counts.suppressed > 0 || fila.state.status !== 'idle') && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={pendente}
                    onClick={() => acaoFila(limparFilaSegura, 'Fila limpa.')}
                  >
                    Limpar pendentes
                  </button>
                )}
              </div>
            </div>

            {fila.chips.length === 0 ? (
              <p className="f5-card-sub">
                Nenhum chip está marcado para &ldquo;Campanhas&rdquo; ou &ldquo;Atendimento e campanhas&rdquo;. Ajuste em Instâncias.
              </p>
            ) : (
              <div className="f5-chips-grade">
                {fila.chips.map((c) => {
                  const usadosHoje = fila.daily_sent_by_chip[c.id] ?? 0;
                  return (
                    <span key={c.id} className={`f5-chip-pilula ${c.status === 'connected' ? 'selecionado' : ''}`}>
                      <span>{c.display_name}</span>
                      <span>
                        ({c.status === 'connected' ? 'online' : 'offline'} · {usadosHoje}/{fila.daily_limit})
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="f5-grade-2">
            <div className="f5-card">
              <div>
                <h2 className="f5-card-titulo">Montar novo lote na Fila Segura</h2>
                <p className="f5-card-sub">Suba CSV/TXT/Excel (.xlsx) ou cole os números um por linha (ex.: Maria;86999990000).</p>
              </div>

              <div className="f5-grade-2">
                <div className="campo">
                  <label htmlFor="fila-modo">Seleção de chip</label>
                  <select
                    id="fila-modo"
                    value={modoFila}
                    onChange={(e) => setModoFila(e.target.value as 'auto_rotate' | 'single')}
                  >
                    <option value="auto_rotate">Rodízio automático entre chips online</option>
                    <option value="single">Chip fixo (nunca troca de chip)</option>
                  </select>
                </div>

                {modoFila === 'single' && (
                  <div className="campo">
                    <label htmlFor="fila-chip">Chip escolhido</label>
                    <select id="fila-chip" value={chipFilaId} onChange={(e) => setChipFilaId(e.target.value)}>
                      <option value="">Escolha…</option>
                      {chipsConectadosCampanha.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.display_name} ({c.engine === 'baileys' ? 'Motor local' : 'Evolution'})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="campo">
                <label htmlFor="fila-arquivo">Importar planilha (.csv, .txt ou .xlsx)</label>
                <input
                  id="fila-arquivo"
                  type="file"
                  accept=".csv,.txt,.xlsx"
                  onChange={(e) => void importarArquivoFila(e.target.files?.[0] ?? null)}
                />
              </div>

              <div className="campo">
                <label htmlFor="fila-colar">Ou colar lista (Nome;Telefone)</label>
                <textarea
                  id="fila-colar"
                  rows={4}
                  placeholder={'Maria Silva;86999112233\nJoão Souza;86988445566'}
                  value={textoContatosFila}
                  onChange={(e) => setTextoContatosFila(e.target.value)}
                />
              </div>
            </div>

            <div className="f5-card">
              <div>
                <h2 className="f5-card-titulo">Mensagem da abordagem</h2>
                <p className="f5-card-sub">Use variáveis para personalizar cada contato na fila.</p>
              </div>

              <div className="f5-variaveis">
                {['{{nome}}', '{{primeiro_nome}}', '{{telefone}}'].map((v) => (
                  <button key={v} type="button" className="f5-var-btn" onClick={() => setModeloFila((t) => `${t} ${v}`.trim())}>
                    + {v}
                  </button>
                ))}
              </div>

              <div className="campo">
                <label htmlFor="fila-tpl">Texto modelo</label>
                <textarea
                  id="fila-tpl"
                  rows={5}
                  value={modeloFila}
                  onChange={(e) => setModeloFila(e.target.value)}
                />
              </div>

              <div className="f5-acoes-rodape">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pendente || chipsConectadosCampanha.length === 0}
                  onClick={aoIniciarFila}
                >
                  {pendente ? 'Iniciando…' : 'Iniciar Fila Segura'}
                </button>
              </div>
            </div>
          </div>

          <div className="f5-card">
            <h2 className="f5-card-titulo">Itens da Fila Segura</h2>
            {fila.items.length === 0 ? (
              <p className="f5-card-sub">Nenhum envio registrado na fila ainda.</p>
            ) : (
              <div className="f5-tabela-wrap">
                <table className="f5-tabela">
                  <thead>
                    <tr>
                      <th>Contato</th>
                      <th>Telefone</th>
                      <th>Situação</th>
                      <th>Mensagem / Detalhe</th>
                      <th>Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fila.items.map((item) => {
                      const st = ROTULO_ITEM_FILA[item.status] ?? { texto: item.status, classe: 'estado' };
                      return (
                        <tr key={item.id}>
                          <td>{item.recipient_name || 'Sem nome'}</td>
                          <td>{formatarTelefoneLegivel(item.recipient_phone)}</td>
                          <td>
                            <span className={st.classe}>{st.texto}</span>
                          </td>
                          <td>
                            {item.suppression_reason
                              ? MOTIVO_SUPRESSAO[item.suppression_reason] ?? item.suppression_reason
                              : item.error_detail || item.rendered_body}
                          </td>
                          <td>
                            {item.status === 'awaiting_human_confirmation' && (
                              <div className="f5-bloco-acoes">
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  disabled={pendente}
                                  onClick={() =>
                                    acaoFila(() => resolverIncertoDaFila(item.id, true), 'Confirmado que a mensagem saiu.')
                                  }
                                >
                                  Foi enviada
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  disabled={pendente}
                                  onClick={() =>
                                    acaoFila(() => resolverIncertoDaFila(item.id, false), 'Marcado que não foi enviada.')
                                  }
                                >
                                  Não saiu
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {aba === 'ignorados' && (
        <div className="f5-grade-2">
          <div className="f5-card">
            <div>
              <h2 className="f5-card-titulo">Adicionar número ignorado</h2>
              <p className="f5-card-sub">
                A IA nunca responde, campanhas nunca disparam e itens pendentes na fila são suprimidos automaticamente.
              </p>
            </div>

            <div className="campo">
              <label htmlFor="ign-nome">Nome / Identificação</label>
              <input
                id="ign-nome"
                type="text"
                placeholder="Ex.: Sócio / Fornecedor / Concorrente"
                value={novoNome}
                onChange={(e) => setNovoNome(e.target.value)}
              />
            </div>

            <div className="campo">
              <label htmlFor="ign-tel">WhatsApp (com ou sem o 9º dígito)</label>
              <input
                id="ign-tel"
                type="text"
                placeholder="(86) 99999-0000"
                value={novoTelefone}
                onChange={(e) => setNovoTelefone(e.target.value)}
              />
            </div>

            <div className="campo">
              <label htmlFor="ign-nota">Observação (opcional)</label>
              <input
                id="ign-nota"
                type="text"
                placeholder="Motivo para ignorar"
                value={novaNota}
                onChange={(e) => setNovaNota(e.target.value)}
              />
            </div>

            <div className="f5-acoes-rodape">
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendente || !novoTelefone.trim()}
                onClick={adicionarIgnorado}
              >
                {pendente ? 'Adicionando…' : 'Adicionar à lista'}
              </button>
            </div>
          </div>

          <div className="f5-card">
            <div>
              <h2 className="f5-card-titulo">Números e contatos protegidos</h2>
              <p className="f5-card-sub">
                Sincronizado com o botão &ldquo;Ignorar na IA&rdquo; e bloqueios da Inbox.
              </p>
            </div>

            {ignorados.manual.length === 0 && ignorados.contacts.length === 0 ? (
              <p className="f5-card-sub">Nenhum número ignorado cadastrado ainda.</p>
            ) : (
              <div className="f5-tabela-wrap">
                <table className="f5-tabela">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>WhatsApp</th>
                      <th>Origem</th>
                      <th>Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ignorados.manual.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.name}</strong>
                          {item.note ? <div className="f5-card-sub">{item.note}</div> : null}
                        </td>
                        <td>{formatarTelefoneLegivel(item.phone_digits)}</td>
                        <td>Lista Segurança</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={pendente}
                            onClick={() => removerIgnorado(item.id, undefined)}
                          >
                            Remover
                          </button>
                        </td>
                      </tr>
                    ))}
                    {ignorados.contacts.map((c) => (
                      <tr key={c.contact_id}>
                        <td>{c.display_name || 'Contato sem nome'}</td>
                        <td>{c.phone_e164 ? formatarTelefoneLegivel(c.phone_e164) : '—'}</td>
                        <td>{c.is_blocked ? 'Bloqueado no CRM' : 'Ignorado na Inbox'}</td>
                        <td>
                          {c.ai_ignored && !c.is_blocked && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={pendente}
                              onClick={() => removerIgnorado(undefined, c.contact_id)}
                            >
                              Remover
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
