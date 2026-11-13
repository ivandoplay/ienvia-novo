'use client';

import { useState, useTransition } from 'react';
import {
  CADENCIA_PADRAO,
  extrairPlaceholders,
  type BlocoDeCampanha,
  type BlocoDeMidia,
  type BlocoDeTexto,
  type CadenciaDeCampanha,
  type ModoDoTexto,
  type OrdemDeSelecao,
} from '@ienvia/shared/campanhas';
import {
  importarDestinatariosDeTexto,
  importarDestinatariosDeXlsx,
  type DestinatarioImportado,
} from '@ienvia/shared/campanhas-importacao';
import { formatarTelefoneLegivel } from '@ienvia/shared/seguranca';
import { Icone } from '@/components/ui/icone';
import type {
  ArquivoDeMidia,
  DadosDasCampanhas,
  DetalheDaCampanha,
  PastaDeMidia,
  ResumoDeCampanha,
} from '@/lib/dados/campanhas';
import {
  cancelarCampanha,
  carregarDetalheCampanha,
  confirmarCampanha,
  criarPastaDeMidia,
  excluirArquivoMidiaCampanha,
  excluirPastaDeMidia,
  excluirRascunhoCampanha,
  gerarPreviaCampanha,
  pausarCampanha,
  prepararUploadMidiaCampanha,
  registrarArquivoMidiaCampanha,
  resolverEnvioIncertoCampanha,
  retomarCampanha,
  salvarRascunhoCampanha,
  type AmostraDePrevia,
} from './acoes';

type AbaCampanha = 'lista' | 'criar' | 'midias' | 'detalhe';

interface Props {
  dados: DadosDasCampanhas;
}

const ROTULO_STATUS: Record<string, { texto: string; classe: string }> = {
  draft: { texto: 'Rascunho', classe: 'estado' },
  awaiting_confirmation: { texto: 'Aguardando confirmação', classe: 'estado estado--atencao' },
  scheduled: { texto: 'Agendada', classe: 'estado estado--ia' },
  running: { texto: 'Disparando', classe: 'estado estado--ok' },
  paused: { texto: 'Pausada', classe: 'estado estado--atencao' },
  completed: { texto: 'Concluída', classe: 'estado estado--ok' },
  cancelled: { texto: 'Cancelada', classe: 'estado' },
  failed: { texto: 'Falha', classe: 'estado estado--atencao' },
};

const ROTULO_DESTINATARIO: Record<string, { texto: string; classe: string }> = {
  pending: { texto: 'Pendente', classe: 'estado' },
  queued: { texto: 'Na fila', classe: 'estado' },
  sending: { texto: 'Enviando…', classe: 'estado estado--ia' },
  awaiting_human_confirmation: { texto: 'Sem confirmação', classe: 'estado estado--atencao' },
  sent: { texto: 'Enviada', classe: 'estado estado--ok' },
  delivered: { texto: 'Entregue', classe: 'estado estado--ok' },
  read: { texto: 'Lida', classe: 'estado estado--ok' },
  replied: { texto: 'Respondida', classe: 'estado estado--ok' },
  failed: { texto: 'Não enviada', classe: 'estado' },
  suppressed: { texto: 'Suprimida', classe: 'estado' },
  cancelled: { texto: 'Cancelada', classe: 'estado' },
};

const MOTIVO_SUPRESSAO: Record<string, string> = {
  ignored: 'Ignorado',
  opted_out: 'Opt-out',
  blocked: 'Bloqueado',
  own_chip: 'Chip próprio',
  invalid_phone: 'Telefone inválido',
};

const DIAS_SEMANA = [
  { num: 0, rotulo: 'Dom' },
  { num: 1, rotulo: 'Seg' },
  { num: 2, rotulo: 'Ter' },
  { num: 3, rotulo: 'Qua' },
  { num: 4, rotulo: 'Qui' },
  { num: 5, rotulo: 'Sex' },
  { num: 6, rotulo: 'Sáb' },
];

function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function criarIdBloco(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function blocoTextoInicial(): BlocoDeTexto {
  return {
    id: criarIdBloco(),
    type: 'text',
    mode: 'spintax',
    texts: ['{Oi|Olá|Tudo bem?} {{primeiro_nome}}! Temos uma novidade especial para você hoje.'],
    selection: 'sequential',
  };
}

export function PainelDeCampanhas({ dados }: Props) {
  const [aba, setAba] = useState<AbaCampanha>('lista');
  const [campanhas, setCampanhas] = useState<ResumoDeCampanha[]>(dados.campanhas);
  const [pastas, setPastas] = useState<PastaDeMidia[]>(dados.pastas);
  const [arquivos, setArquivos] = useState<ArquivoDeMidia[]>(dados.arquivos);
  const [detalhe, setDetalhe] = useState<DetalheDaCampanha | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [pendente, iniciarTransicao] = useTransition();

  // Estado do criador de campanhas
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [nomeCampanha, setNomeCampanha] = useState('');
  const [distribuicao, setDistribuicao] = useState<'fixed' | 'round_robin'>('fixed');
  const [chipsSelecionados, setChipsSelecionados] = useState<string[]>(() => {
    const primeiroConectado = dados.chips.find((c) => c.status === 'connected')?.id ?? dados.chips[0]?.id;
    return primeiroConectado ? [primeiroConectado] : [];
  });
  const [agendarPara, setAgendarPara] = useState('');
  const [blocos, setBlocos] = useState<BlocoDeCampanha[]>([blocoTextoInicial()]);
  const [cadencia, setCadencia] = useState<CadenciaDeCampanha>(CADENCIA_PADRAO);
  const [textoContatos, setTextoContatos] = useState('');
  const [contatosImportados, setContatosImportados] = useState<DestinatarioImportado[]>([]);
  const [colunasDetectadas, setColunasDetectadas] = useState<string[]>([]);
  const [resumoImportacao, setResumoImportacao] = useState<{ invalidos: number; duplicados: number } | null>(null);
  const [previa, setPrevia] = useState<{
    eligible: number;
    suppressed: number;
    amostras: AmostraDePrevia[];
  } | null>(null);

  // Biblioteca de mídia
  const [novaPastaNome, setNovaPastaNome] = useState('');
  const [novaPastaTipo, setNovaPastaTipo] = useState<'image' | 'audio'>('image');
  const [pastaAtivaId, setPastaAtivaId] = useState<string>(dados.pastas[0]?.id ?? '');
  const [enviandoMidia, setEnviandoMidia] = useState(false);

  const pastasImagem = pastas.filter((p) => p.kind === 'image');
  const pastasAudio = pastas.filter((p) => p.kind === 'audio');
  const pastaAtiva = pastas.find((p) => p.id === pastaAtivaId) ?? null;
  const arquivosDaPastaAtiva = arquivos.filter((a) => a.folder_id === pastaAtivaId);

  function limparFormularioCampanha() {
    setCampaignId(null);
    setNomeCampanha('');
    setDistribuicao('fixed');
    const primeiro = dados.chips.find((c) => c.status === 'connected')?.id ?? dados.chips[0]?.id;
    setChipsSelecionados(primeiro ? [primeiro] : []);
    setAgendarPara('');
    setBlocos([blocoTextoInicial()]);
    setCadencia(CADENCIA_PADRAO);
    setTextoContatos('');
    setContatosImportados([]);
    setColunasDetectadas([]);
    setResumoImportacao(null);
    setPrevia(null);
  }

  function alternarChipSelecionado(id: string) {
    if (distribuicao === 'fixed') {
      setChipsSelecionados([id]);
      return;
    }
    setChipsSelecionados((atual) => (atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]));
  }

  async function importarArquivoContatos(file: File | null) {
    if (!file) return;
    setAviso(null);
    try {
      const isXlsx = file.name.toLowerCase().endsWith('.xlsx');
      const res = isXlsx
        ? await importarDestinatariosDeXlsx(new Uint8Array(await file.arrayBuffer()))
        : importarDestinatariosDeTexto(await file.text());
      setContatosImportados(res.validos);
      setColunasDetectadas(res.colunasExtras);
      setResumoImportacao({
        invalidos: res.rejeitados.filter((r) => r.motivo === 'telefone_invalido').length,
        duplicados: res.rejeitados.filter((r) => r.motivo === 'duplicado').length,
      });
      setPrevia(null);
      setAviso({
        tipo: res.validos.length > 0 ? 'ok' : 'erro',
        texto:
          res.validos.length > 0
            ? `${res.validos.length} destinatário(s) válido(s) carregado(s) de ${file.name}.`
            : 'Nenhum número válido encontrado no arquivo.',
      });
    } catch (erro) {
      setAviso({
        tipo: 'erro',
        texto: erro instanceof Error ? erro.message : 'Não foi possível abrir o arquivo.',
      });
    }
  }

  function contatosParaEnvio(): Array<{ name: string; phone: string; fields: Record<string, string> }> {
    if (textoContatos.trim()) {
      const parsed = importarDestinatariosDeTexto(textoContatos);
      return parsed.validos.map((c) => ({ name: c.nome, phone: c.telefone, fields: c.campos }));
    }
    return contatosImportados.map((c) => ({ name: c.nome, phone: c.telefone, fields: c.campos }));
  }

  const variaveisDisponiveis = Array.from(
    new Set(['nome', 'primeiro_nome', 'telefone', ...colunasDetectadas]),
  );

  function atualizarBloco(index: number, novo: BlocoDeCampanha) {
    setBlocos((atual) => atual.map((b, i) => (i === index ? novo : b)));
    setPrevia(null);
  }

  function moverBloco(index: number, delta: -1 | 1) {
    const alvo = index + delta;
    if (alvo < 0 || alvo >= blocos.length) return;
    setBlocos((atual) => {
      const copia = [...atual];
      const temp = copia[index]!;
      copia[index] = copia[alvo]!;
      copia[alvo] = temp;
      return copia;
    });
    setPrevia(null);
  }

  function removerBloco(index: number) {
    if (blocos.length <= 1) return;
    setBlocos((atual) => atual.filter((_, i) => i !== index));
    setPrevia(null);
  }

  function adicionarBloco(tipo: 'text' | 'image' | 'audio') {
    if (blocos.length >= 15) return;
    if (tipo === 'text') setBlocos((atual) => [...atual, blocoTextoInicial()]);
    else if (tipo === 'image') {
      const novo: BlocoDeMidia = {
        id: criarIdBloco(),
        type: 'image',
        folder_id: pastasImagem[0]?.id ?? '',
        selection: 'sequential',
      };
      setBlocos((atual) => [...atual, novo]);
    } else {
      const novo: BlocoDeMidia = {
        id: criarIdBloco(),
        type: 'audio',
        folder_id: pastasAudio[0]?.id ?? '',
        selection: 'sequential',
        is_voice: true,
      };
      setBlocos((atual) => [...atual, novo]);
    }
    setPrevia(null);
  }

  function alternarDiaCadencia(dia: number) {
    setCadencia((c) => {
      const existe = c.workDays.includes(dia);
      const next = existe ? c.workDays.filter((d) => d !== dia) : [...c.workDays, dia].sort((a, b) => a - b);
      return { ...c, workDays: next };
    });
  }

  function aoGerarPrevia() {
    setAviso(null);
    const recipients = contatosParaEnvio();
    if (recipients.length === 0) {
      setAviso({ tipo: 'erro', texto: 'Importe uma planilha ou cole pelo menos um destinatário válido.' });
      return;
    }

    // Conferência amigável de variáveis usadas sem coluna correspondente
    const todasVars = new Set<string>();
    for (const b of blocos) {
      if (b.type === 'text') {
        for (const t of b.texts) for (const v of extrairPlaceholders(t)) todasVars.add(v);
      }
    }
    const temCampos = recipients[0]?.fields ?? {};
    for (const v of todasVars) {
      if (!['nome', 'primeiro_nome', 'telefone'].includes(v) && !(v in temCampos)) {
        setAviso({
          tipo: 'erro',
          texto: `A variável {{${v}}} está no texto, mas não existe na lista importada.`,
        });
        return;
      }
    }

    iniciarTransicao(async () => {
      const agendamentoIso = agendarPara ? new Date(agendarPara).toISOString() : null;
      const saved = await salvarRascunhoCampanha({
        campaignId,
        name: nomeCampanha,
        distribution: distribuicao,
        instanceIds: chipsSelecionados,
        blocks: blocos,
        cadence: cadencia,
        recipients,
        scheduledFor: agendamentoIso,
      });
      if (!saved.ok) {
        setAviso({ tipo: 'erro', texto: saved.erro });
        return;
      }
      const idSalvo = saved.detalhe.campaign.id;
      setCampaignId(idSalvo);
      setCampanhas(saved.lista);

      const prev = await gerarPreviaCampanha(idSalvo);
      if (!prev.ok) {
        setAviso({ tipo: 'erro', texto: prev.erro });
        return;
      }
      setPrevia({ eligible: prev.eligible, suppressed: prev.suppressed, amostras: prev.amostras });
      setCampanhas(prev.lista);
      setAviso({
        tipo: 'ok',
        texto: `Prévia gerada: ${prev.eligible} elegível(is), ${prev.suppressed} suprimido(s). Confira as amostras antes de confirmar.`,
      });
    });
  }

  function aoConfirmarCampanha() {
    if (!campaignId) return;
    setAviso(null);
    iniciarTransicao(async () => {
      const agendamentoIso = agendarPara ? new Date(agendarPara).toISOString() : null;
      const res = await confirmarCampanha(campaignId, agendamentoIso);
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        return;
      }
      setCampanhas(res.lista);
      setDetalhe(res.detalhe);
      limparFormularioCampanha();
      setAba('detalhe');
      setAviso({
        tipo: 'ok',
        texto:
          res.detalhe.campaign.status === 'scheduled'
            ? 'Campanha confirmada e agendada com sucesso.'
            : 'Campanha confirmada e iniciada em ritmo seguro.',
      });
    });
  }

  function abrirDetalhe(id: string) {
    setAviso(null);
    iniciarTransicao(async () => {
      const res = await carregarDetalheCampanha(id);
      if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
      else {
        setDetalhe(res.detalhe);
        setAba('detalhe');
      }
    });
  }

  function acaoCampanha(
    fn: () => Promise<{ ok: true; detalhe: DetalheDaCampanha; lista: ResumoDeCampanha[] } | { ok: false; erro: string }>,
    msgOk: string,
  ) {
    setAviso(null);
    iniciarTransicao(async () => {
      const res = await fn();
      if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
      else {
        setCampanhas(res.lista);
        if (detalhe?.campaign.id === res.detalhe.campaign.id) setDetalhe(res.detalhe);
        setAviso({ tipo: 'ok', texto: msgOk });
      }
    });
  }

  function aoCriarPasta() {
    setAviso(null);
    iniciarTransicao(async () => {
      const res = await criarPastaDeMidia({ name: novaPastaNome, kind: novaPastaTipo });
      if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
      else {
        setPastas((p) => [res.pasta, ...p]);
        setPastaAtivaId(res.pasta.id);
        setNovaPastaNome('');
        setAviso({ tipo: 'ok', texto: `Pasta "${res.pasta.name}" criada.` });
      }
    });
  }

  async function aoSubirArquivos(files: FileList | null) {
    if (!files || !pastaAtiva) return;
    setAviso(null);
    setEnviandoMidia(true);
    try {
      let enviados = 0;
      for (const file of Array.from(files)) {
        const prep = await prepararUploadMidiaCampanha({ folderId: pastaAtiva.id, fileName: file.name });
        if (!prep.ok) {
          setAviso({ tipo: 'erro', texto: prep.erro });
          continue;
        }
        const put = await fetch(prep.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!put.ok) {
          setAviso({ tipo: 'erro', texto: `Falha ao enviar ${file.name} para o armazenamento.` });
          continue;
        }
        const reg = await registrarArquivoMidiaCampanha({
          folderId: pastaAtiva.id,
          fileId: prep.fileId,
          objectKey: prep.objectKey,
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          byteSize: file.size,
        });
        if (!reg.ok) {
          setAviso({ tipo: 'erro', texto: reg.erro });
          continue;
        }
        setArquivos((atual) => [...atual, reg.arquivo]);
        enviados += 1;
      }
      if (enviados > 0) setAviso({ tipo: 'ok', texto: `${enviados} arquivo(s) adicionado(s) em "${pastaAtiva.name}".` });
    } finally {
      setEnviandoMidia(false);
    }
  }

  return (
    <div className="f5-pagina">
      <div className="page-header">
        <div>
          <h1>Campanhas</h1>
          <p>Disparos em lote com blocos de texto, imagens e áudio (voz ou arquivo), prévia e confirmação obrigatória.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            limparFormularioCampanha();
            setAba('criar');
          }}
        >
          <Icone nome="adicionar" className="icon-15" />
          <span>Nova campanha</span>
        </button>
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

      <div className="f5-abas" role="tablist" aria-label="Seções de Campanhas">
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'lista'}
          className={`f5-aba ${aba === 'lista' ? 'ativa' : ''}`}
          onClick={() => setAba('lista')}
        >
          <Icone nome="campanhas" className="icon-15" />
          <span>Campanhas ({campanhas.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'criar'}
          className={`f5-aba ${aba === 'criar' ? 'ativa' : ''}`}
          onClick={() => setAba('criar')}
        >
          <Icone nome="adicionar" className="icon-15" />
          <span>{campaignId ? 'Editar rascunho' : 'Montar campanha'}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'midias'}
          className={`f5-aba ${aba === 'midias' ? 'ativa' : ''}`}
          onClick={() => setAba('midias')}
        >
          <Icone nome="pasta" className="icon-15" />
          <span>Pastas de mídia ({pastas.length})</span>
        </button>
        {detalhe && (
          <button
            type="button"
            role="tab"
            aria-selected={aba === 'detalhe'}
            className={`f5-aba ${aba === 'detalhe' ? 'ativa' : ''}`}
            onClick={() => setAba('detalhe')}
          >
            <Icone nome="lista" className="icon-15" />
            <span>Detalhes: {detalhe.campaign.name}</span>
          </button>
        )}
      </div>

      {aba === 'lista' && (
        <div className="f5-pagina">
          {campanhas.length === 0 ? (
            <div className="f5-card">
              <h2 className="f5-card-titulo">Nenhuma campanha criada ainda</h2>
              <p className="f5-card-sub">
                Crie sua primeira campanha escolhendo os chips, importando a lista (.xlsx, .csv ou .txt), montando os blocos e conferindo a prévia antes de iniciar.
              </p>
              <div className="f5-acoes-rodape">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    limparFormularioCampanha();
                    setAba('criar');
                  }}
                >
                  Criar primeira campanha
                </button>
              </div>
            </div>
          ) : (
            campanhas.map((c) => {
              const st = ROTULO_STATUS[c.status] ?? { texto: c.status, classe: 'estado' };
              return (
                <div key={c.id} className="f5-card">
                  <div className="f5-card-topo">
                    <div>
                      <div className="f5-bloco-acoes">
                        <h2 className="f5-card-titulo">{c.name}</h2>
                        <span className={st.classe}>{st.texto}</span>
                      </div>
                      {c.pause_detail && <p className="f5-card-sub">{c.pause_detail}</p>}
                    </div>
                    <div className="f5-bloco-acoes">
                      <button type="button" className="btn btn-secondary" disabled={pendente} onClick={() => abrirDetalhe(c.id)}>
                        Acompanhar
                      </button>
                      {(c.status === 'running' || c.status === 'scheduled') && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={pendente}
                          onClick={() => acaoCampanha(() => pausarCampanha(c.id), 'Campanha pausada.')}
                        >
                          Pausar
                        </button>
                      )}
                      {c.status === 'paused' && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={pendente}
                          onClick={() => acaoCampanha(() => retomarCampanha(c.id), 'Campanha retomada.')}
                        >
                          Retomar
                        </button>
                      )}
                      {['draft', 'awaiting_confirmation', 'scheduled', 'running', 'paused'].includes(c.status) && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={pendente}
                          onClick={() => acaoCampanha(() => cancelarCampanha(c.id), 'Campanha cancelada.')}
                        >
                          Cancelar
                        </button>
                      )}
                      {['draft', 'awaiting_confirmation', 'cancelled'].includes(c.status) && c.stats.sent === 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={pendente}
                          onClick={() => {
                            setAviso(null);
                            iniciarTransicao(async () => {
                              const res = await excluirRascunhoCampanha(c.id);
                              if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
                              else {
                                setCampanhas(res.lista);
                                setAviso({ tipo: 'ok', texto: 'Campanha excluída.' });
                              }
                            });
                          }}
                        >
                          Excluir
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="f5-metricas">
                    <div className="f5-metrica">
                      <span className="f5-metrica-val">{c.stats.eligible}</span>
                      <span className="f5-metrica-rot">Elegíveis</span>
                    </div>
                    <div className="f5-metrica">
                      <span className="f5-metrica-val">{c.stats.sent}</span>
                      <span className="f5-metrica-rot">Enviadas</span>
                    </div>
                    <div className="f5-metrica">
                      <span className="f5-metrica-val">{c.stats.delivered}</span>
                      <span className="f5-metrica-rot">Entregues</span>
                    </div>
                    <div className="f5-metrica">
                      <span className="f5-metrica-val">{c.stats.read}</span>
                      <span className="f5-metrica-rot">Lidas</span>
                    </div>
                    <div className="f5-metrica">
                      <span className="f5-metrica-val">{c.stats.replied}</span>
                      <span className="f5-metrica-rot">Respondidas</span>
                    </div>
                    <div className="f5-metrica">
                      <span className="f5-metrica-val">{c.stats.suppressed}</span>
                      <span className="f5-metrica-rot">Suprimidas</span>
                    </div>
                    <div className="f5-metrica">
                      <span className="f5-metrica-val">{c.stats.failed + c.stats.uncertain}</span>
                      <span className="f5-metrica-rot">Falha / Incerto</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {aba === 'criar' && (
        <div className="f5-pagina">
          <div className="f5-grade-2">
            <div className="f5-card">
              <div>
                <h2 className="f5-card-titulo">1. Identidade e chips de envio</h2>
                <p className="f5-card-sub">Só aparecem chips habilitados para campanhas em Instâncias.</p>
              </div>

              <div className="campo">
                <label htmlFor="camp-nome">Nome da campanha</label>
                <input
                  id="camp-nome"
                  type="text"
                  placeholder="Ex.: Promoção Fim de Semana"
                  value={nomeCampanha}
                  onChange={(e) => {
                    setNomeCampanha(e.target.value);
                    setPrevia(null);
                  }}
                />
              </div>

              <div className="f5-grade-2">
                <div className="campo">
                  <label htmlFor="camp-dist">Distribuição entre chips</label>
                  <select
                    id="camp-dist"
                    value={distribuicao}
                    onChange={(e) => {
                      const next = e.target.value as 'fixed' | 'round_robin';
                      setDistribuicao(next);
                      if (next === 'fixed' && chipsSelecionados.length > 1) {
                        setChipsSelecionados([chipsSelecionados[0]!]);
                      }
                      setPrevia(null);
                    }}
                  >
                    <option value="fixed">Chip fixo (sem troca automática)</option>
                    <option value="round_robin">Rodízio equilibrado entre chips</option>
                  </select>
                </div>

                <div className="campo">
                  <label htmlFor="camp-agendar">Agendar início (opcional)</label>
                  <input
                    id="camp-agendar"
                    type="datetime-local"
                    value={agendarPara}
                    onChange={(e) => setAgendarPara(e.target.value)}
                  />
                </div>
              </div>

              <div className="campo">
                <label>Chips disponíveis para campanhas</label>
                {dados.chips.length === 0 ? (
                  <p className="f5-card-sub">
                    Nenhum chip configurado para &ldquo;Campanhas&rdquo; ou &ldquo;Atendimento e campanhas&rdquo;. Ajuste em Instâncias.
                  </p>
                ) : (
                  <div className="f5-chips-grade">
                    {dados.chips.map((c) => {
                      const marcado = chipsSelecionados.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={`f5-chip-pilula ${marcado ? 'selecionado' : ''}`}
                          onClick={() => alternarChipSelecionado(c.id)}
                        >
                          <Icone nome={marcado ? 'confere' : 'instancias'} className="icon-15" />
                          <span>
                            {c.display_name} ({c.status === 'connected' ? 'online' : 'offline'})
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="f5-card">
              <div>
                <h2 className="f5-card-titulo">2. Destinatários (.xlsx, .csv, .txt ou colado)</h2>
                <p className="f5-card-sub">
                  Contatos ignorados, opt-out, chip próprio e telefones duplicados (com/sem 9º dígito) são filtrados automaticamente.
                </p>
              </div>

              <div className="campo">
                <label htmlFor="camp-arquivo">Enviar planilha (.xlsx, .csv ou .txt)</label>
                <input
                  id="camp-arquivo"
                  type="file"
                  accept=".xlsx,.csv,.txt"
                  onChange={(e) => void importarArquivoContatos(e.target.files?.[0] ?? null)}
                />
              </div>

              {resumoImportacao && (
                <p className="f5-card-sub">
                  Carregados: <strong>{contatosImportados.length}</strong> · Inválidos: {resumoImportacao.invalidos} · Duplicados:{' '}
                  {resumoImportacao.duplicados}
                </p>
              )}

              <div className="campo">
                <label htmlFor="camp-colar">Ou cole uma lista (Nome;Telefone;Cidade...)</label>
                <textarea
                  id="camp-colar"
                  rows={4}
                  placeholder={'Maria Silva;86999112233\nJoão Souza;86988445566'}
                  value={textoContatos}
                  onChange={(e) => {
                    setTextoContatos(e.target.value);
                    setPrevia(null);
                  }}
                />
              </div>
            </div>
          </div>

          <div className="f5-card">
            <div className="f5-card-topo">
              <div>
                <h2 className="f5-card-titulo">3. Sequência de mensagens em blocos</h2>
                <p className="f5-card-sub">
                  Cada destinatário recebe os blocos na ordem abaixo (ex.: texto + imagem + áudio como mensagem de voz).
                </p>
              </div>
              <div className="f5-bloco-acoes">
                <button type="button" className="btn btn-secondary" onClick={() => adicionarBloco('text')}>
                  + Bloco de texto
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => adicionarBloco('image')}>
                  + Bloco de imagem
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => adicionarBloco('audio')}>
                  + Bloco de áudio
                </button>
              </div>
            </div>

            {blocos.map((bloco, index) => (
              <div key={index} className="f5-bloco">
                <div className="f5-bloco-cab">
                  <strong>
                    Bloco {index + 1} · {bloco.type === 'text' ? 'Texto' : bloco.type === 'image' ? 'Imagem' : 'Áudio'}
                  </strong>
                  <div className="f5-bloco-acoes">
                    <button type="button" className="btn btn-secondary" disabled={index === 0} onClick={() => moverBloco(index, -1)}>
                      Subir
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={index === blocos.length - 1}
                      onClick={() => moverBloco(index, 1)}
                    >
                      Descer
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={blocos.length <= 1}
                      onClick={() => removerBloco(index)}
                    >
                      Remover
                    </button>
                  </div>
                </div>

                {bloco.type === 'text' && (
                  <div className="f5-pagina">
                    <div className="f5-grade-2">
                      <div className="campo">
                        <label htmlFor={`bloco-modo-${index}`}>Modo de texto</label>
                        <select
                          id={`bloco-modo-${index}`}
                          value={bloco.mode}
                          onChange={(e) =>
                            atualizarBloco(index, {
                              ...bloco,
                              mode: e.target.value as ModoDoTexto,
                            })
                          }
                        >
                          <option value="fixed">Texto fixo</option>
                          <option value="rotation">Alternância entre mensagens (rodízio)</option>
                          <option value="spintax">Spintax (ex.: &#123;Oi|Olá|Tudo bem?&#125;)</option>
                          <option value="ai" disabled={!dados.iaDisponivel}>
                            Variação automática com IA {!dados.iaDisponivel ? '(configure chave em Motor de IA)' : ''}
                          </option>
                        </select>
                      </div>
                      {bloco.mode === 'rotation' && (
                        <div className="campo">
                          <label htmlFor={`bloco-sel-${index}`}>Ordem das opções</label>
                          <select
                            id={`bloco-sel-${index}`}
                            value={bloco.selection}
                            onChange={(e) =>
                              atualizarBloco(index, { ...bloco, selection: e.target.value as OrdemDeSelecao })
                            }
                          >
                            <option value="sequential">Sequencial (rodízio)</option>
                            <option value="random">Aleatória</option>
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="f5-variaveis">
                      {variaveisDisponiveis.map((v) => (
                        <button
                          key={v}
                          type="button"
                          className="f5-var-btn"
                          onClick={() => {
                            const atualTextos = [...bloco.texts];
                            atualTextos[0] = `${atualTextos[0] ?? ''} {{${v}}}`.trim();
                            atualizarBloco(index, { ...bloco, texts: atualTextos });
                          }}
                        >
                          + {`{{${v}}}`}
                        </button>
                      ))}
                    </div>

                    {bloco.texts.map((t, vIdx) => (
                      <div key={vIdx} className="campo">
                        <div className="f5-card-topo">
                          <label htmlFor={`bloco-txt-${index}-${vIdx}`}>
                            {bloco.mode === 'rotation' ? `Opção ${vIdx + 1}` : 'Mensagem'}
                          </label>
                          {bloco.mode === 'rotation' && bloco.texts.length > 1 && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() =>
                                atualizarBloco(index, {
                                  ...bloco,
                                  texts: bloco.texts.filter((_, i) => i !== vIdx),
                                })
                              }
                            >
                              Remover opção
                            </button>
                          )}
                        </div>
                        <textarea
                          id={`bloco-txt-${index}-${vIdx}`}
                          rows={3}
                          value={t}
                          onChange={(e) => {
                            const copia = [...bloco.texts];
                            copia[vIdx] = e.target.value;
                            atualizarBloco(index, { ...bloco, texts: copia });
                          }}
                        />
                      </div>
                    ))}

                    {bloco.mode === 'rotation' && bloco.texts.length < 10 && (
                      <div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => atualizarBloco(index, { ...bloco, texts: [...bloco.texts, ''] })}
                        >
                          + Adicionar variação de texto
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {bloco.type === 'image' && (
                  <div className="f5-grade-2">
                    <div className="campo">
                      <label htmlFor={`bloco-img-pasta-${index}`}>Pasta de imagens</label>
                      <select
                        id={`bloco-img-pasta-${index}`}
                        value={bloco.folder_id}
                        onChange={(e) => atualizarBloco(index, { ...bloco, folder_id: e.target.value })}
                      >
                        <option value="">Escolha uma pasta…</option>
                        {pastasImagem.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({arquivos.filter((a) => a.folder_id === p.id).length} arquivo(s))
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="campo">
                      <label htmlFor={`bloco-img-modo-${index}`}>Escolha do arquivo</label>
                      <select
                        id={`bloco-img-modo-${index}`}
                        value={bloco.selection}
                        onChange={(e) => atualizarBloco(index, { ...bloco, selection: e.target.value as OrdemDeSelecao })}
                      >
                        <option value="sequential">Rodízio sequencial na pasta</option>
                        <option value="random">Aleatória da pasta</option>
                      </select>
                    </div>
                  </div>
                )}

                {bloco.type === 'audio' && (
                  <div className="f5-pagina">
                    <div className="f5-grade-2">
                      <div className="campo">
                        <label htmlFor={`bloco-aud-pasta-${index}`}>Pasta de áudios</label>
                        <select
                          id={`bloco-aud-pasta-${index}`}
                          value={bloco.folder_id}
                          onChange={(e) => atualizarBloco(index, { ...bloco, folder_id: e.target.value })}
                        >
                          <option value="">Escolha uma pasta…</option>
                          {pastasAudio.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({arquivos.filter((a) => a.folder_id === p.id).length} arquivo(s))
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="campo">
                        <label htmlFor={`bloco-aud-modo-${index}`}>Escolha do áudio</label>
                        <select
                          id={`bloco-aud-modo-${index}`}
                          value={bloco.selection}
                          onChange={(e) => atualizarBloco(index, { ...bloco, selection: e.target.value as OrdemDeSelecao })}
                        >
                          <option value="sequential">Rodízio sequencial na pasta</option>
                          <option value="random">Aleatória da pasta</option>
                        </select>
                      </div>
                    </div>

                    <div className="interruptor">
                      <input
                        id={`bloco-aud-voz-${index}`}
                        type="checkbox"
                        checked={bloco.is_voice !== false}
                        onChange={(e) => atualizarBloco(index, { ...bloco, is_voice: e.target.checked })}
                      />
                      <div className="interruptor-texto">
                        <label htmlFor={`bloco-aud-voz-${index}`}>Enviar como mensagem de voz (PTT)</label>
                        <p>Marcado: aparece como áudio gravado na hora. Desmarcado: envia como arquivo de áudio normal.</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="f5-card">
            <div>
              <h2 className="f5-card-titulo">4. Cadência anti-bloqueio e janela de horário</h2>
              <p className="f5-card-sub">
                Intervalos aleatórios entre contatos, pausas entre lotes grandes e teto diário por chip.
              </p>
            </div>

            <div className="f5-grade-3">
              <div className="campo">
                <label htmlFor="cad-int-min">Intervalo mínimo (seg)</label>
                <input
                  id="cad-int-min"
                  type="number"
                  min={15}
                  max={600}
                  value={cadencia.intervalMinSec}
                  onChange={(e) => setCadencia({ ...cadencia, intervalMinSec: Number(e.target.value) || 15 })}
                />
              </div>
              <div className="campo">
                <label htmlFor="cad-int-max">Intervalo máximo (seg)</label>
                <input
                  id="cad-int-max"
                  type="number"
                  min={15}
                  max={900}
                  value={cadencia.intervalMaxSec}
                  onChange={(e) => setCadencia({ ...cadencia, intervalMaxSec: Number(e.target.value) || 15 })}
                />
              </div>
              <div className="campo">
                <label htmlFor="cad-step">Pausa entre blocos (seg)</label>
                <input
                  id="cad-step"
                  type="number"
                  min={2}
                  max={30}
                  value={cadencia.stepIntervalSec}
                  onChange={(e) => setCadencia({ ...cadencia, stepIntervalSec: Number(e.target.value) || 2 })}
                />
              </div>
            </div>

            <div className="f5-grade-3">
              <div className="campo">
                <label htmlFor="cad-lote-min">Pessoas por lote (mín.)</label>
                <input
                  id="cad-lote-min"
                  type="number"
                  min={1}
                  max={100}
                  value={cadencia.batchMin}
                  onChange={(e) => setCadencia({ ...cadencia, batchMin: Number(e.target.value) || 1 })}
                />
              </div>
              <div className="campo">
                <label htmlFor="cad-lote-max">Pessoas por lote (máx.)</label>
                <input
                  id="cad-lote-max"
                  type="number"
                  min={1}
                  max={100}
                  value={cadencia.batchMax}
                  onChange={(e) => setCadencia({ ...cadencia, batchMax: Number(e.target.value) || 1 })}
                />
              </div>
              <div className="campo">
                <label htmlFor="cad-daily">Teto diário por chip</label>
                <input
                  id="cad-daily"
                  type="number"
                  min={1}
                  max={2000}
                  value={cadencia.dailyLimitPerChip}
                  onChange={(e) => setCadencia({ ...cadencia, dailyLimitPerChip: Number(e.target.value) || 1 })}
                />
              </div>
            </div>

            <div className="f5-grade-2">
              <div className="campo">
                <label htmlFor="cad-pausa-min">Descanso entre lotes mínimo (seg)</label>
                <input
                  id="cad-pausa-min"
                  type="number"
                  min={30}
                  max={3600}
                  value={cadencia.batchPauseMinSec}
                  onChange={(e) => setCadencia({ ...cadencia, batchPauseMinSec: Number(e.target.value) || 30 })}
                />
              </div>
              <div className="campo">
                <label htmlFor="cad-pausa-max">Descanso entre lotes máximo (seg)</label>
                <input
                  id="cad-pausa-max"
                  type="number"
                  min={30}
                  max={7200}
                  value={cadencia.batchPauseMaxSec}
                  onChange={(e) => setCadencia({ ...cadencia, batchPauseMaxSec: Number(e.target.value) || 30 })}
                />
              </div>
            </div>

            <div className="interruptor">
              <input
                id="cad-horario"
                type="checkbox"
                checked={cadencia.restrictHours}
                onChange={(e) => setCadencia({ ...cadencia, restrictHours: e.target.checked })}
              />
              <div className="interruptor-texto">
                <label htmlFor="cad-horario">Disparar somente dentro da janela de horário</label>
                <p>Fora desse intervalo a campanha espera automaticamente até o próximo horário permitido.</p>
              </div>
            </div>

            {cadencia.restrictHours && (
              <div className="f5-grade-3">
                <div className="campo">
                  <label htmlFor="cad-ini">Início</label>
                  <input
                    id="cad-ini"
                    type="time"
                    value={cadencia.windowStart}
                    onChange={(e) => setCadencia({ ...cadencia, windowStart: e.target.value })}
                  />
                </div>
                <div className="campo">
                  <label htmlFor="cad-fim">Fim</label>
                  <input
                    id="cad-fim"
                    type="time"
                    value={cadencia.windowEnd}
                    onChange={(e) => setCadencia({ ...cadencia, windowEnd: e.target.value })}
                  />
                </div>
                <div className="campo">
                  <label>Dias da semana</label>
                  <div className="f5-dias">
                    {DIAS_SEMANA.map((d) => (
                      <button
                        key={d.num}
                        type="button"
                        className={`f5-dia ${cadencia.workDays.includes(d.num) ? 'ativo' : ''}`}
                        onClick={() => alternarDiaCadencia(d.num)}
                      >
                        {d.rotulo}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="f5-acoes-rodape">
              <button type="button" className="btn btn-primary" disabled={pendente} onClick={aoGerarPrevia}>
                {pendente ? 'Conferindo elegíveis…' : 'Salvar rascunho e gerar prévia'}
              </button>
            </div>
          </div>

          {previa && (
            <div className="f5-card">
              <div className="f5-card-topo">
                <div>
                  <h2 className="f5-card-titulo">Prévia obrigatória antes do disparo</h2>
                  <p className="f5-card-sub">
                    <strong>{previa.eligible}</strong> contato(s) pronto(s) para receber ·{' '}
                    <strong>{previa.suppressed}</strong> suprimido(s) por proteção.
                  </p>
                </div>
                <button type="button" className="btn btn-primary" disabled={pendente} onClick={aoConfirmarCampanha}>
                  {pendente ? 'Confirmando…' : agendarPara ? 'Confirmar e agendar campanha' : 'Confirmar e iniciar disparo'}
                </button>
              </div>

              <div className="f5-grade-2">
                {previa.amostras.map((am) => (
                  <div key={am.recipientId} className="f5-bloco">
                    <strong>
                      {am.name} · {formatarTelefoneLegivel(am.phone)}
                    </strong>
                    {am.steps.map((s, sIdx) => (
                      <div key={sIdx} className="f5-previa-bolha">
                        {s.preview}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {aba === 'midias' && (
        <div className="f5-grade-2">
          <div className="f5-card">
            <div>
              <h2 className="f5-card-titulo">Pastas de imagens e áudios</h2>
              <p className="f5-card-sub">Organize arquivos em pastas para usar em rodízio ou sorteio nos blocos de campanha.</p>
            </div>

            <div className="f5-grade-2">
              <div className="campo">
                <label htmlFor="pasta-nome">Nome da pasta</label>
                <input
                  id="pasta-nome"
                  type="text"
                  placeholder="Ex.: Áudios de Boas-Vindas"
                  value={novaPastaNome}
                  onChange={(e) => setNovaPastaNome(e.target.value)}
                />
              </div>
              <div className="campo">
                <label htmlFor="pasta-tipo">Tipo da pasta</label>
                <select
                  id="pasta-tipo"
                  value={novaPastaTipo}
                  onChange={(e) => setNovaPastaTipo(e.target.value as 'image' | 'audio')}
                >
                  <option value="image">Imagens (JPG, PNG, WebP)</option>
                  <option value="audio">Áudios (OGG, MP3, M4A, WAV)</option>
                </select>
              </div>
            </div>

            <div className="f5-acoes-rodape">
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendente || !novaPastaNome.trim()}
                onClick={aoCriarPasta}
              >
                Criar pasta
              </button>
            </div>

            {pastas.length === 0 ? (
              <p className="f5-card-sub">Nenhuma pasta criada ainda.</p>
            ) : (
              <div className="f5-pagina">
                {pastas.map((p) => {
                  const qtd = arquivos.filter((a) => a.folder_id === p.id).length;
                  return (
                    <div key={p.id} className="f5-midia-item">
                      <button
                        type="button"
                        className={`f5-chip-pilula ${pastaAtivaId === p.id ? 'selecionado' : ''}`}
                        onClick={() => setPastaAtivaId(p.id)}
                      >
                        <Icone nome={p.kind === 'audio' ? 'audios' : 'imagem'} className="icon-15" />
                        <span>
                          {p.name} ({qtd})
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={pendente}
                        onClick={() => {
                          setAviso(null);
                          iniciarTransicao(async () => {
                            const res = await excluirPastaDeMidia(p.id);
                            if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
                            else {
                              setPastas((atual) => atual.filter((x) => x.id !== p.id));
                              setArquivos((atual) => atual.filter((x) => x.folder_id !== p.id));
                              if (pastaAtivaId === p.id) setPastaAtivaId('');
                              setAviso({ tipo: 'ok', texto: 'Pasta excluída.' });
                            }
                          });
                        }}
                      >
                        Excluir
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="f5-card">
            {!pastaAtiva ? (
              <p className="f5-card-sub">Selecione ou crie uma pasta ao lado para subir arquivos.</p>
            ) : (
              <>
                <div>
                  <h2 className="f5-card-titulo">
                    {pastaAtiva.name} ({pastaAtiva.kind === 'audio' ? 'Áudios' : 'Imagens'})
                  </h2>
                  <p className="f5-card-sub">Os arquivos vão direto para o armazenamento seguro da sua empresa (máx. 25 MB cada).</p>
                </div>

                <div className="campo">
                  <label htmlFor="midia-upload">
                    {enviandoMidia ? 'Enviando arquivos…' : 'Adicionar arquivos na pasta'}
                  </label>
                  <input
                    id="midia-upload"
                    type="file"
                    multiple
                    disabled={enviandoMidia}
                    accept={pastaAtiva.kind === 'audio' ? 'audio/*' : 'image/*'}
                    onChange={(e) => void aoSubirArquivos(e.target.files)}
                  />
                </div>

                {arquivosDaPastaAtiva.length === 0 ? (
                  <p className="f5-card-sub">Pasta vazia. Adicione pelo menos um arquivo para usá-la em campanhas.</p>
                ) : (
                  <div className="f5-midia-grade">
                    {arquivosDaPastaAtiva.map((a) => (
                      <div key={a.id} className="f5-midia-item">
                        <div>
                          <strong>{a.file_name}</strong>
                          <div className="f5-card-sub">{formatarTamanho(a.byte_size)}</div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={pendente}
                          onClick={() => {
                            setAviso(null);
                            iniciarTransicao(async () => {
                              const res = await excluirArquivoMidiaCampanha(a.id);
                              if (!res.ok) setAviso({ tipo: 'erro', texto: res.erro });
                              else setArquivos((atual) => atual.filter((x) => x.id !== a.id));
                            });
                          }}
                        >
                          Remover
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {aba === 'detalhe' && detalhe && (
        <div className="f5-pagina">
          {detalhe.campaign.pause_detail && (
            <div className="f5-aviso-topo f5-aviso-topo--alerta" role="alert">
              <span>{detalhe.campaign.pause_detail}</span>
            </div>
          )}

          <div className="f5-card">
            <div className="f5-card-topo">
              <div>
                <h2 className="f5-card-titulo">{detalhe.campaign.name}</h2>
                <p className="f5-card-sub">
                  Status: <strong>{ROTULO_STATUS[detalhe.campaign.status]?.texto ?? detalhe.campaign.status}</strong>
                </p>
              </div>
              <div className="f5-bloco-acoes">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={pendente}
                  onClick={() => abrirDetalhe(detalhe.campaign.id)}
                >
                  Atualizar
                </button>
                {detalhe.campaign.status === 'running' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={pendente}
                    onClick={() => acaoCampanha(() => pausarCampanha(detalhe.campaign.id), 'Campanha pausada.')}
                  >
                    Pausar
                  </button>
                )}
                {detalhe.campaign.status === 'paused' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={pendente}
                    onClick={() => acaoCampanha(() => retomarCampanha(detalhe.campaign.id), 'Campanha retomada.')}
                  >
                    Retomar
                  </button>
                )}
              </div>
            </div>

            <div className="f5-metricas">
              <div className="f5-metrica">
                <span className="f5-metrica-val">{detalhe.stats.eligible}</span>
                <span className="f5-metrica-rot">Elegíveis</span>
              </div>
              <div className="f5-metrica">
                <span className="f5-metrica-val">{detalhe.stats.queued}</span>
                <span className="f5-metrica-rot">Na fila</span>
              </div>
              <div className="f5-metrica">
                <span className="f5-metrica-val">{detalhe.stats.sent}</span>
                <span className="f5-metrica-rot">Enviadas</span>
              </div>
              <div className="f5-metrica">
                <span className="f5-metrica-val">{detalhe.stats.delivered}</span>
                <span className="f5-metrica-rot">Entregues</span>
              </div>
              <div className="f5-metrica">
                <span className="f5-metrica-val">{detalhe.stats.read}</span>
                <span className="f5-metrica-rot">Lidas</span>
              </div>
              <div className="f5-metrica">
                <span className="f5-metrica-val">{detalhe.stats.replied}</span>
                <span className="f5-metrica-rot">Respondidas</span>
              </div>
              <div className="f5-metrica">
                <span className="f5-metrica-val">{detalhe.stats.suppressed}</span>
                <span className="f5-metrica-rot">Suprimidas</span>
              </div>
              <div className="f5-metrica">
                <span className="f5-metrica-val">{detalhe.stats.uncertain}</span>
                <span className="f5-metrica-rot">Sem confirmação</span>
              </div>
            </div>
          </div>

          {detalhe.attention_deliveries.filter((d) => d.status === 'awaiting_human_confirmation').length > 0 && (
            <div className="f5-card">
              <h2 className="f5-card-titulo">Envios aguardando confirmação humana</h2>
              <p className="f5-card-sub">
                A campanha pausou automaticamente para não duplicar mensagens. Confira no celular do chip e marque abaixo:
              </p>
              {detalhe.attention_deliveries
                .filter((d) => d.status === 'awaiting_human_confirmation')
                .map((d) => (
                  <div key={d.id} className="f5-midia-item">
                    <div>
                      <strong>Bloco {d.step_index + 1} ({d.block_type})</strong>
                      <div className="f5-card-sub">{d.rendered_body || d.error_detail || 'Mídia enviada'}</div>
                    </div>
                    <div className="f5-bloco-acoes">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={pendente}
                        onClick={() =>
                          acaoCampanha(
                            () => resolverEnvioIncertoCampanha(detalhe.campaign.id, d.id, true),
                            'Confirmado que a mensagem saiu.',
                          )
                        }
                      >
                        Foi enviada
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={pendente}
                        onClick={() =>
                          acaoCampanha(
                            () => resolverEnvioIncertoCampanha(detalhe.campaign.id, d.id, false),
                            'Marcado que não foi enviada.',
                          )
                        }
                      >
                        Não saiu
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )}

          <div className="f5-card">
            <h2 className="f5-card-titulo">Destinatários ({detalhe.recipients.length})</h2>
            <div className="f5-tabela-wrap">
              <table className="f5-tabela">
                <thead>
                  <tr>
                    <th>Contato</th>
                    <th>WhatsApp</th>
                    <th>Chip</th>
                    <th>Status</th>
                    <th>Observação</th>
                  </tr>
                </thead>
                <tbody>
                  {detalhe.recipients.map((r) => {
                    const st = ROTULO_DESTINATARIO[r.status] ?? { texto: r.status, classe: 'estado' };
                    return (
                      <tr key={r.id}>
                        <td>{r.display_name || 'Sem nome'}</td>
                        <td>{r.phone_e164 ? formatarTelefoneLegivel(r.phone_e164) : '—'}</td>
                        <td>{r.instance_name || '—'}</td>
                        <td>
                          <span className={st.classe}>{st.texto}</span>
                        </td>
                        <td>
                          {r.suppression_reason
                            ? MOTIVO_SUPRESSAO[r.suppression_reason] ?? r.suppression_reason
                            : r.last_error || (r.replied_at ? 'Cliente respondeu' : r.read_at ? 'Mensagem lida' : r.delivered_at ? 'Entregue no WhatsApp' : '—')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
