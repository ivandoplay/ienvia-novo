'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import {
  MARCA_PADRAO,
  ROTULO_DA_COBRANCA,
  descreverPrazoDaCobranca,
  formatarDataBr,
  formatarReais,
  type ContaSaasResumo,
  type EventoDeAuditoriaSuporte,
  type SituacaoDeCobranca,
} from '@ienvia/shared/contas';
import { Dialogo } from '@/components/ui/dialogo';
import type { ModoSuporteAtivo } from '@/lib/sessao';
import {
  atualizarClienteSaas,
  criarClienteSaas,
  encerrarModoSuporte,
  entrarEmModoSuporte,
  excluirClienteSaas,
  marcarClienteComoPago,
  reativarClienteSaas,
  restaurarClienteSaas,
  salvarCobrancaDoCliente,
  suspenderClienteSaas,
  trocarSenhaDoCliente,
  zerarClienteSaas,
} from './acoes';

interface Props {
  contasIniciais: ContaSaasResumo[];
  auditoriaInicial: EventoDeAuditoriaSuporte[];
  modoSuporte: ModoSuporteAtivo | null;
}

const ROTULOS_ACAO: Record<string, string> = {
  platform_workspace_deleted: 'Excluiu cliente',
  platform_workspace_restored: 'Restaurou cliente',
  support_session_started: 'Iniciou Modo Suporte',
  support_session_ended: 'Encerrou Modo Suporte',
  platform_workspace_created: 'Criou cliente SaaS',
  platform_workspace_updated: 'Editou cliente SaaS',
  conversation_claimed: 'Assumiu conversa (suporte)',
  conversation_resolved: 'Resolveu conversa (suporte)',
  conversation_reopened: 'Reabriu conversa (suporte)',
  conversation_released: 'Devolveu para IA (suporte)',
  workspace_branding_updated: 'Alterou marca (suporte)',
  workspace_data_exported: 'Exportou dados (suporte)',
  platform_workspace_billing_updated: 'Alterou a cobrança',
  platform_workspace_paid: 'Marcou mês como pago',
  platform_workspace_suspended: 'Suspendeu o cliente',
  platform_workspace_reactivated: 'Reativou o cliente',
  platform_workspace_reset: 'Zerou os dados do cliente',
  platform_workspace_password_reset: 'Trocou a senha do responsável',
};

/** Classe da etiqueta de cobrança por situação. */
const CLASSE_DA_COBRANCA: Record<SituacaoDeCobranca, string> = {
  em_dia: 'conta-pill conta-pill--ativa',
  vencendo: 'conta-pill conta-pill--atencao',
  tolerancia: 'conta-pill conta-pill--atencao',
  vencida: 'conta-pill conta-pill--desativada',
  sem_cobranca: 'conta-pill',
};

const seNaCobranca = (conta: ContaSaasResumo) => conta.billing.situation !== 'sem_cobranca';

function formatarDataHora(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function PainelDeContas({ contasIniciais, auditoriaInicial, modoSuporte }: Props) {
  const router = useRouter();
  const [contas, setContas] = useState<ContaSaasResumo[]>(contasIniciais);
  const [auditoria, setAuditoria] = useState<EventoDeAuditoriaSuporte[]>(auditoriaInicial);

  const [busca, setBusca] = useState('');
  const [filtroStatus, setFiltroStatus] = useState<'todos' | 'active' | 'closed'>('todos');
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  // --- Novo cliente ---
  const [mostraNovo, setMostraNovo] = useState(false);
  const [novoNome, setNovoNome] = useState('');
  const [novoLogin, setNovoLogin] = useState('');
  const [novoResp, setNovoResp] = useState('');
  const [novaSenha, setNovaSenha] = useState('');
  const [novoChips, setNovoChips] = useState(2);
  const [novoPlano, setNovoPlano] = useState('Padrão');
  const [novaMarca, setNovaMarca] = useState<string>(MARCA_PADRAO.nomeDaMarca);
  const [novoSubtitulo, setNovoSubtitulo] = useState<string>(MARCA_PADRAO.subtituloDaMarca);
  const [novasNotas, setNovasNotas] = useState('');
  const [criando, setCriando] = useState(false);

  // --- Edição ---
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [editNome, setEditNome] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'closed'>('active');
  const [editChips, setEditChips] = useState(1);
  const [editPlano, setEditPlano] = useState('');
  const [editNotas, setEditNotas] = useState('');
  const [salvandoEdit, setSalvandoEdit] = useState(false);

  // --- Exclusão de cliente ---
  const [excluindo, setExcluindo] = useState<ContaSaasResumo | null>(null);
  const [motivoExclusao, setMotivoExclusao] = useState('');
  const [apagando, setApagando] = useState(false);
  const [restaurandoId, setRestaurandoId] = useState<string | null>(null);

  // --- Modo Suporte ---
  const [suporteId, setSuporteId] = useState<string | null>(null);
  const [motivoSuporte, setMotivoSuporte] = useState('');
  const [abrindoSuporte, setAbrindoSuporte] = useState(false);
  const [encerrandoSuporte, setEncerrandoSuporte] = useState(false);

  // Ações rápidas de um cliente: cobrança, pagamento, suspensão, senha e zerar.
  const [cobrancaAberta, setCobrancaAberta] = useState<string | null>(null);
  const [cobDia, setCobDia] = useState('');
  const [cobValor, setCobValor] = useState('');
  const [cobCarencia, setCobCarencia] = useState('3');
  const [cobPagoAte, setCobPagoAte] = useState('');
  const [cobWhatsapp, setCobWhatsapp] = useState('');
  const [cobAviso, setCobAviso] = useState('');
  const [salvandoCobranca, setSalvandoCobranca] = useState(false);

  const [suspensoes, setSuspensoes] = useState<{ conta: ContaSaasResumo; motivo: string; aviso: string } | null>(null);
  const [suspendendo, setSuspendendo] = useState(false);

  const [zerando, setZerando] = useState<{ conta: ContaSaasResumo; confirmacao: string } | null>(null);
  const [zerandoAgora, setZerandoAgora] = useState(false);

  const [senhaNova, setSenhaNova] = useState<{ conta: string; senha: string } | null>(null);
  const [trocandoSenha, setTrocandoSenha] = useState<string | null>(null);
  const [ocupadoId, setOcupadoId] = useState<string | null>(null);
  // Qual ação está rodando neste cliente ("cobranca", "pago", "suspender", "reativar", "senha", "zerar").
  const [acaoEmCurso, setAcaoEmCurso] = useState<string | null>(null);

  const metricas = useMemo(() => {
    const ativas = contas.filter((c) => c.status === 'active').length;
    const desativadas = contas.filter((c) => c.status === 'closed').length;
    const chipsConectados = contas.reduce((s, c) => s + c.instancesConnected, 0);
    const chipsLimite = contas.reduce((s, c) => s + c.maxInstances, 0);
    return { total: contas.length, ativas, desativadas, chipsConectados, chipsLimite };
  }, [contas]);

  const contasFiltradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return contas.filter((c) => {
      if (filtroStatus !== 'todos' && c.status !== filtroStatus) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.planLabel.toLowerCase().includes(q) ||
        (c.owner?.login ?? '').toLowerCase().includes(q) ||
        (c.owner?.displayName ?? '').toLowerCase().includes(q)
      );
    });
  }, [contas, busca, filtroStatus]);

  async function confirmarExclusao(evento: FormEvent) {
    evento.preventDefault();
    if (!excluindo || apagando) return;
    setApagando(true);
    const res = await excluirClienteSaas({ workspaceId: excluindo.id, motivo: motivoExclusao });
    setApagando(false);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setAviso({ tipo: 'ok', texto: res.mensagem });
    setExcluindo(null);
    setMotivoExclusao('');
  }

  async function desfazerExclusao(conta: ContaSaasResumo) {
    if (restaurandoId) return;
    setRestaurandoId(conta.id);
    const res = await restaurarClienteSaas(conta.id);
    setRestaurandoId(null);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setAviso({ tipo: 'ok', texto: res.mensagem });
  }

  function abrirEdicao(conta: ContaSaasResumo) {
    if (editandoId === conta.id) {
      setEditandoId(null);
      return;
    }
    setSuporteId(null);
    setEditandoId(conta.id);
    setEditNome(conta.name);
    setEditStatus(conta.status === 'closed' ? 'closed' : 'active');
    setEditChips(conta.maxInstances);
    setEditPlano(conta.planLabel);
    setEditNotas(conta.adminNotes);
  }

  function abrirCobranca(conta: ContaSaasResumo) {
    if (cobrancaAberta === conta.id) {
      setCobrancaAberta(null);
      return;
    }
    setEditandoId(null);
    setSuporteId(null);
    setCobrancaAberta(conta.id);
    setCobDia(conta.billing.dueDay ? String(conta.billing.dueDay) : '');
    setCobValor(
      conta.billing.monthlyAmountCents === null ? '' : (conta.billing.monthlyAmountCents / 100).toFixed(2).replace('.', ','),
    );
    setCobCarencia(String(conta.billing.graceDays));
    setCobPagoAte(conta.billing.paidUntil ?? '');
    setCobWhatsapp(conta.billing.ownerWhatsapp ? formatarWhatsapp(conta.billing.ownerWhatsapp) : '');
    setCobAviso(
      conta.billing.suspendNotice ||
        'Oi! Seu acesso ao painel está suspenso por falta de pagamento. Assim que regularizar, a gente libera na hora.',
    );
  }

  async function aoSalvarCobranca(evento: FormEvent, conta: ContaSaasResumo) {
    evento.preventDefault();
    setAcaoEmCurso('cobranca');
    setSalvandoCobranca(true);
    setAviso(null);
    const res = await salvarCobrancaDoCliente({
      workspaceId: conta.id,
      dueDay: cobDia,
      monthlyAmountCents: valorEmCentavos(cobValor),
      graceDays: cobCarencia,
      paidUntil: cobPagoAte,
      suspendNotice: cobAviso,
      ownerWhatsapp: cobWhatsapp,
    });
    setAcaoEmCurso(null);
    setSalvandoCobranca(false);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setCobrancaAberta(null);
    setAviso({ tipo: 'ok', texto: res.mensagem });
  }

  async function aoMarcarPago(conta: ContaSaasResumo) {
    setAcaoEmCurso('pago');
    setOcupadoId(conta.id);
    setAviso(null);
    const res = await marcarClienteComoPago(conta.id);
    setOcupadoId(null);
    setAcaoEmCurso(null);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setAviso({ tipo: 'ok', texto: res.mensagem });
  }

  async function aoReativar(conta: ContaSaasResumo) {
    setAcaoEmCurso('reativar');
    setOcupadoId(conta.id);
    setAviso(null);
    const res = await reativarClienteSaas(conta.id);
    setOcupadoId(null);
    setAcaoEmCurso(null);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setAviso({ tipo: 'ok', texto: res.mensagem });
    router.refresh();
  }

  async function aoSuspender(evento: FormEvent) {
    evento.preventDefault();
    if (!suspensoes) return;
    setAcaoEmCurso('suspender');
    setSuspendendo(true);
    setAviso(null);
    const res = await suspenderClienteSaas({
      workspaceId: suspensoes.conta.id,
      motivo: suspensoes.motivo,
      aviso: suspensoes.aviso,
    });
    setSuspendendo(false);
    setAcaoEmCurso(null);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setSuspensoes(null);
    setAviso({ tipo: 'ok', texto: res.mensagem });
    router.refresh();
  }

  async function aoTrocarSenha(conta: ContaSaasResumo) {
    setAcaoEmCurso('senha');
    setTrocandoSenha(conta.id);
    setAviso(null);
    const res = await trocarSenhaDoCliente(conta.id);
    setTrocandoSenha(null);
    setAcaoEmCurso(null);
    if (!res.ok || !res.senha) {
      setAviso({ tipo: 'erro', texto: res.ok ? 'A senha não foi gerada.' : res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setSenhaNova({ conta: conta.name, senha: res.senha });
  }

  async function aoZerar(evento: FormEvent) {
    evento.preventDefault();
    if (!zerando) return;
    setAcaoEmCurso('zerar');
    setZerandoAgora(true);
    setAviso(null);
    const res = await zerarClienteSaas({ workspaceId: zerando.conta.id, confirmacao: zerando.confirmacao });
    setZerandoAgora(false);
    setAcaoEmCurso(null);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setZerando(null);
    setAviso({ tipo: 'ok', texto: res.mensagem });
    router.refresh();
  }

  function abrirSuportePrompt(contaId: string) {
    if (suporteId === contaId) {
      setSuporteId(null);
      return;
    }
    setEditandoId(null);
    setSuporteId(contaId);
    setMotivoSuporte('');
  }

  async function aoCriarCliente(evento: FormEvent) {
    evento.preventDefault();
    setCriando(true);
    setAviso(null);
    const res = await criarClienteSaas({
      workspaceNome: novoNome,
      loginOuEmail: novoLogin,
      nomeUsuario: novoResp,
      senha: novaSenha,
      limiteDeChips: novoChips,
      plano: novoPlano,
      notasAdmin: novasNotas,
      nomeDaMarca: novaMarca,
      subtituloDaMarca: novoSubtitulo,
    });
    setCriando(false);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setMostraNovo(false);
    setNovoNome('');
    setNovoLogin('');
    setNovoResp('');
    setNovaSenha('');
    setNovoChips(2);
    setNovoPlano('Padrão');
    setNovasNotas('');
    setAviso({ tipo: 'ok', texto: res.mensagem });
  }

  async function aoSalvarEdicao(evento: FormEvent, workspaceId: string) {
    evento.preventDefault();
    setSalvandoEdit(true);
    setAviso(null);
    const res = await atualizarClienteSaas({
      workspaceId,
      workspaceNome: editNome,
      status: editStatus,
      limiteDeChips: editChips,
      plano: editPlano,
      notasAdmin: editNotas,
    });
    setSalvandoEdit(false);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setEditandoId(null);
    setAviso({ tipo: 'ok', texto: res.mensagem });
    router.refresh();
  }

  async function aoEntrarEmSuporte(evento: FormEvent, workspaceId: string) {
    evento.preventDefault();
    setAbrindoSuporte(true);
    setAviso(null);
    const res = await entrarEmModoSuporte({ workspaceId, motivo: motivoSuporte });
    setAbrindoSuporte(false);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    router.push('/visao-geral');
    router.refresh();
  }

  async function aoEncerrarSuporte() {
    setEncerrandoSuporte(true);
    setAviso(null);
    const res = await encerrarModoSuporte();
    setEncerrandoSuporte(false);
    if (!res.ok) {
      setAviso({ tipo: 'erro', texto: res.erro });
      return;
    }
    setContas(res.contas);
    setAuditoria(res.auditoria);
    setAviso({ tipo: 'ok', texto: res.mensagem });
    router.refresh();
  }

  return (
    <div>
      {modoSuporte ? (
        <div className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Modo Suporte ativo em {modoSuporte.workspaceNome}</h2>
            <div className="conta-acoes">
              <Link href="/visao-geral" className="btn btn-secondary btn-sm">
                Abrir painel do cliente
              </Link>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={encerrandoSuporte}
                onClick={aoEncerrarSuporte}
              >
                {encerrandoSuporte ? 'Encerrando...' : 'Sair do suporte'}
              </button>
            </div>
          </div>
          <p className="panel-desc">
            Enquanto estiver em Modo Suporte, todas as abas (Inbox, Instâncias, IA, Configurações) mostram a conta de{' '}
            <strong>{modoSuporte.workspaceNome}</strong> e cada ação fica registrada na auditoria.
          </p>
        </div>
      ) : null}

      <div className="contas-kpis">
        <div className="contas-kpi">
          <div className="contas-kpi-val">{metricas.total}</div>
          <div className="contas-kpi-lbl">Contas cadastradas</div>
        </div>
        <div className="contas-kpi">
          <div className="contas-kpi-val">{metricas.ativas}</div>
          <div className="contas-kpi-lbl">Contas ativas</div>
        </div>
        <div className="contas-kpi">
          <div className="contas-kpi-val">{metricas.desativadas}</div>
          <div className="contas-kpi-lbl">Desativadas</div>
        </div>
        <div className="contas-kpi">
          <div className="contas-kpi-val">
            {metricas.chipsConectados}/{metricas.chipsLimite}
          </div>
          <div className="contas-kpi-lbl">Chips conectados / contratados</div>
        </div>
      </div>

      {aviso || acaoEmCurso ? (
        <div
          className="aviso-painel"
          data-tipo={aviso?.tipo ?? 'ok'}
          role={aviso?.tipo === 'erro' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <span>
            {acaoEmCurso ? textoDaAcaoEmCurso(acaoEmCurso) : aviso?.texto}
          </span>
          {aviso ? (
            <button type="button" className="aviso-painel-fechar" aria-label="Fechar aviso" onClick={() => setAviso(null)}>
              Fechar
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Empresas cadastradas</h2>
        </div>
        <div className="contas-toolbar">
          <div className="contas-filtros">
            <label htmlFor="contas-busca" className="so-leitor-de-tela">
              Buscar cliente SaaS
            </label>
            <input
              id="contas-busca"
              type="search"
              className="f7-input"
              style={{ width: 'min(290px, 100%)' }}
              placeholder="Buscar empresa, plano ou login..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <button
              type="button"
              className={filtroStatus === 'todos' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={() => setFiltroStatus('todos')}
            >
              Todas ({contas.length})
            </button>
            <button
              type="button"
              className={filtroStatus === 'active' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={() => setFiltroStatus('active')}
            >
              Ativas ({metricas.ativas})
            </button>
            <button
              type="button"
              className={filtroStatus === 'closed' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={() => setFiltroStatus('closed')}
            >
              Desativadas ({metricas.desativadas})
            </button>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            aria-expanded={mostraNovo}
            onClick={() => setMostraNovo((v) => !v)}
          >
            {mostraNovo ? 'Fechar cadastro' : '+ Novo cliente'}
          </button>
        </div>

        {mostraNovo ? (
          <form onSubmit={aoCriarCliente} className="conta-editor" style={{ marginBottom: 16 }}>
            <h2 className="panel-title" style={{ marginBottom: 10 }}>
              Criar nova conta de cliente
            </h2>
            <div className="f7-form-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="novo-ws-nome">
                  Nome da empresa
                </label>
                <input
                  id="novo-ws-nome"
                  className="f7-input"
                  value={novoNome}
                  onChange={(e) => setNovoNome(e.target.value)}
                  placeholder="Ex.: Clínica Sorriso"
                  minLength={2}
                  maxLength={120}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="novo-ws-login">
                  Login ou e-mail do dono
                </label>
                <input
                  id="novo-ws-login"
                  className="f7-input"
                  value={novoLogin}
                  onChange={(e) => setNovoLogin(e.target.value)}
                  placeholder="Ex.: clinica-sorriso ou dono@empresa.com"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="novo-ws-resp">
                  Nome do responsável
                </label>
                <input
                  id="novo-ws-resp"
                  className="f7-input"
                  value={novoResp}
                  onChange={(e) => setNovoResp(e.target.value)}
                  placeholder="Ex.: Dr. Pedro"
                  maxLength={80}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="novo-ws-senha">
                  Senha inicial
                </label>
                <input
                  id="novo-ws-senha"
                  type="password"
                  className="f7-input"
                  value={novaSenha}
                  onChange={(e) => setNovaSenha(e.target.value)}
                  minLength={8}
                  maxLength={128}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="novo-ws-chips">
                  Limite de chips
                </label>
                <input
                  id="novo-ws-chips"
                  type="number"
                  className="f7-input"
                  min={0}
                  max={50}
                  value={novoChips}
                  onChange={(e) => setNovoChips(Number(e.target.value) || 0)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="novo-ws-plano">
                  Plano / pacote
                </label>
                <input
                  id="novo-ws-plano"
                  className="f7-input"
                  value={novoPlano}
                  onChange={(e) => setNovoPlano(e.target.value)}
                  maxLength={60}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="novo-ws-marca">
                  Marca inicial no topo
                </label>
                <input
                  id="novo-ws-marca"
                  className="f7-input"
                  value={novaMarca}
                  onChange={(e) => setNovaMarca(e.target.value)}
                  minLength={2}
                  maxLength={40}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="novo-ws-sub">
                  Subtítulo inicial
                </label>
                <input
                  id="novo-ws-sub"
                  className="f7-input"
                  value={novoSubtitulo}
                  onChange={(e) => setNovoSubtitulo(e.target.value)}
                  maxLength={60}
                />
              </div>
              <div className="form-group f7-span-2">
                <label className="form-label" htmlFor="novo-ws-notas">
                  Anotações internas do administrador
                </label>
                <textarea
                  id="novo-ws-notas"
                  className="f7-textarea"
                  value={novasNotas}
                  onChange={(e) => setNovasNotas(e.target.value)}
                  maxLength={4000}
                  placeholder="Combinados comerciais, vencimento ou observações internas..."
                />
              </div>
            </div>
            <div className="f7-actions">
              <button type="submit" className="btn btn-primary" disabled={criando}>
                {criando ? 'Criando conta...' : 'Criar cliente SaaS'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setMostraNovo(false)}>
                Cancelar
              </button>
            </div>
          </form>
        ) : null}

        {contasFiltradas.length === 0 ? (
          <p className="panel-desc">Nenhuma conta encontrada com esse filtro.</p>
        ) : (
          <div className="contas-lista">
            {contasFiltradas.map((conta) => {
              const desativada = conta.status === 'closed';
              const emSuporteAqui = modoSuporte?.workspaceId === conta.id;
              return (
                <article
                  key={conta.id}
                  className={desativada ? 'conta-card conta-card--desativada' : 'conta-card'}
                >
                  <div className="conta-topo">
                    <div className="conta-identidade">
                      <div className="conta-titulo-linha">
                        <h3 className="conta-nome">{conta.name}</h3>
                        <span className={desativada ? 'conta-pill conta-pill--desativada' : 'conta-pill conta-pill--ativa'}>
                          {desativada ? 'Desativada' : 'Ativa'}
                        </span>
                        <span className="conta-pill">{conta.planLabel}</span>
                        <span className="conta-pill">
                          {conta.instancesConnected}/{conta.instancesTotal} chips · limite {conta.maxInstances}
                        </span>
                        {seNaCobranca(conta) ? (
                          <span className={CLASSE_DA_COBRANCA[conta.billing.situation]}>
                            {ROTULO_DA_COBRANCA[conta.billing.situation]}
                            {conta.billing.paidUntil ? ` · pago até ${formatarDataBr(conta.billing.paidUntil)}` : ''}
                          </span>
                        ) : null}
                      </div>
                      <div className="conta-uso">
                        <span>
                          <strong>{conta.usage.messagesMonth.toLocaleString('pt-BR')}</strong> mensagens no mês
                        </span>
                        <span>
                          <strong>{conta.usage.aiRepliesMonth.toLocaleString('pt-BR')}</strong> respostas da IA
                        </span>
                        <span>{conta.usage.lastMessageAt ? `Última mensagem: ${formatarDataHora(conta.usage.lastMessageAt)}` : 'Sem movimento ainda'}</span>
                        <span>{conta.usage.lastSignInAt ? `Último acesso: ${formatarDataHora(conta.usage.lastSignInAt)}` : 'Nunca entrou no painel'}</span>
                        {conta.usage.pendingNotices > 0 ? (
                          <span className="conta-uso-alerta">{conta.usage.pendingNotices} aviso(s) de suspensão na fila</span>
                        ) : null}
                      </div>
                      <div className="conta-cobranca-linha">
                        {seNaCobranca(conta) ? (
                          <>
                            <span>
                              {formatarReais(conta.billing.monthlyAmountCents)} por mês
                              {conta.billing.dueDay ? ` · vence dia ${conta.billing.dueDay}` : ''}
                            </span>
                            <span className="conta-cobranca-prazo">{descreverPrazoDaCobranca(conta.billing.daysToDue)}</span>
                            <span>Carência de {conta.billing.graceDays} dia(s)</span>
                          </>
                        ) : (
                          <span>Sem cobrança combinada. Use o botão Cobrança para definir vencimento e valor.</span>
                        )}
                      </div>
                      <div className="conta-sub">
                        Dono:{' '}
                        {conta.owner
                          ? `${conta.owner.displayName ? `${conta.owner.displayName} (` : ''}${conta.owner.login}${conta.owner.displayName ? ')' : ''}`
                          : 'Sem proprietário ativo'}
                        {' · '}
                        {conta.contactsCount} contatos · {conta.conversationsCount} conversas
                        {conta.lastSupportAt ? ` · Último suporte: ${formatarDataHora(conta.lastSupportAt)}` : ''}
                      </div>
                      {conta.adminNotes ? <div className="conta-notas">{conta.adminNotes}</div> : null}
                    </div>

                    <div className="conta-acoes">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-expanded={cobrancaAberta === conta.id}
                        onClick={() => abrirCobranca(conta)}
                      >
                        Cobrança
                      </button>
                      {seNaCobranca(conta) && conta.billing.situation !== 'em_dia' ? (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={ocupadoId === conta.id}
                          onClick={() => void aoMarcarPago(conta)}
                        >
                          {ocupadoId === conta.id ? 'Salvando…' : 'Marcar mês como pago'}
                        </button>
                      ) : null}
                      {!desativada ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm conta-btn-suspender"
                          onClick={() =>
                            setSuspensoes({
                              conta,
                              motivo: 'Mensalidade em atraso',
                              aviso:
                                conta.billing.suspendNotice ||
                                'Oi! Seu acesso ao painel está suspenso por falta de pagamento. Assim que regularizar, a gente libera na hora.',
                            })
                          }
                        >
                          Suspender
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={ocupadoId === conta.id}
                          onClick={() => void aoReativar(conta)}
                        >
                          {ocupadoId === conta.id ? 'Reativando…' : 'Reativar acesso'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={trocandoSenha === conta.id}
                        onClick={() => void aoTrocarSenha(conta)}
                      >
                        {trocandoSenha === conta.id ? 'Gerando…' : 'Senha nova'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-expanded={editandoId === conta.id}
                        onClick={() => abrirEdicao(conta)}
                      >
                        Editar conta
                      </button>
                      {emSuporteAqui ? (
                        <Link href="/visao-geral" className="btn btn-primary btn-sm">
                          Ver painel em suporte
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          aria-expanded={suporteId === conta.id}
                          onClick={() => abrirSuportePrompt(conta.id)}
                        >
                          Entrar em suporte
                        </button>
                      )}
                      {desativada ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={restaurandoId === conta.id}
                          onClick={() => void desfazerExclusao(conta)}
                        >
                          {restaurandoId === conta.id ? 'Restaurando…' : 'Desfazer exclusão'}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setZerando({ conta, confirmacao: '' })}
                          >
                            Zerar dados
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm conta-btn-excluir"
                            onClick={() => {
                              setExcluindo(conta);
                              setMotivoExclusao('');
                            }}
                          >
                            Excluir cliente
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {editandoId === conta.id ? (
                    <form onSubmit={(e) => aoSalvarEdicao(e, conta.id)} className="conta-editor">
                      <div className="f7-form-grid">
                        <div className="form-group">
                          <label className="form-label" htmlFor={`edit-nome-${conta.id}`}>
                            Nome da empresa
                          </label>
                          <input
                            id={`edit-nome-${conta.id}`}
                            className="f7-input"
                            value={editNome}
                            onChange={(e) => setEditNome(e.target.value)}
                            minLength={2}
                            maxLength={120}
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label" htmlFor={`edit-status-${conta.id}`}>
                            Situação da conta
                          </label>
                          <select
                            id={`edit-status-${conta.id}`}
                            className="f7-select"
                            value={editStatus}
                            onChange={(e) => setEditStatus(e.target.value === 'closed' ? 'closed' : 'active')}
                          >
                            <option value="active">Ativa (acesso liberado)</option>
                            <option value="closed">Desativada (acesso bloqueado)</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label className="form-label" htmlFor={`edit-chips-${conta.id}`}>
                            Limite de chips
                          </label>
                          <input
                            id={`edit-chips-${conta.id}`}
                            type="number"
                            className="f7-input"
                            min={0}
                            max={50}
                            value={editChips}
                            onChange={(e) => setEditChips(Number(e.target.value) || 0)}
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label" htmlFor={`edit-plano-${conta.id}`}>
                            Plano / pacote
                          </label>
                          <input
                            id={`edit-plano-${conta.id}`}
                            className="f7-input"
                            value={editPlano}
                            onChange={(e) => setEditPlano(e.target.value)}
                            maxLength={60}
                          />
                        </div>
                        <div className="form-group f7-span-2">
                          <label className="form-label" htmlFor={`edit-notas-${conta.id}`}>
                            Anotações do administrador
                          </label>
                          <textarea
                            id={`edit-notas-${conta.id}`}
                            className="f7-textarea"
                            value={editNotas}
                            onChange={(e) => setEditNotas(e.target.value)}
                            maxLength={4000}
                          />
                        </div>
                      </div>
                      <div className="f7-actions">
                        <button type="submit" className="btn btn-primary btn-sm" disabled={salvandoEdit}>
                          {salvandoEdit ? 'Salvando...' : 'Salvar conta'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setEditandoId(null)}
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  ) : null}

                  {cobrancaAberta === conta.id ? (
                    <form onSubmit={(e) => aoSalvarCobranca(e, conta)} className="conta-editor">
                      <div className="f7-form-grid">
                        <div className="form-group">
                          <label className="form-label" htmlFor={`cob-dia-${conta.id}`}>
                            Dia do vencimento
                          </label>
                          <input
                            id={`cob-dia-${conta.id}`}
                            className="f7-input"
                            inputMode="numeric"
                            value={cobDia}
                            onChange={(e) => setCobDia(e.target.value)}
                            placeholder="Ex.: 10"
                            maxLength={2}
                          />
                          <p className="form-help">Deixe vazio para não cobrar este cliente.</p>
                        </div>
                        <div className="form-group">
                          <label className="form-label" htmlFor={`cob-valor-${conta.id}`}>
                            Valor por mês (R$)
                          </label>
                          <input
                            id={`cob-valor-${conta.id}`}
                            className="f7-input"
                            inputMode="decimal"
                            value={cobValor}
                            onChange={(e) => setCobValor(e.target.value)}
                            placeholder="Ex.: 149,00"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label" htmlFor={`cob-carencia-${conta.id}`}>
                            Carência depois do vencimento (dias)
                          </label>
                          <input
                            id={`cob-carencia-${conta.id}`}
                            type="number"
                            className="f7-input"
                            min={0}
                            max={60}
                            value={cobCarencia}
                            onChange={(e) => setCobCarencia(e.target.value)}
                          />
                          <p className="form-help">Passou da carência, o painel marca como vencida para você suspender.</p>
                        </div>
                        <div className="form-group">
                          <label className="form-label" htmlFor={`cob-pago-${conta.id}`}>
                            Pago até (data)
                          </label>
                          <input
                            id={`cob-pago-${conta.id}`}
                            type="date"
                            className="f7-input"
                            value={cobPagoAte}
                            onChange={(e) => setCobPagoAte(e.target.value)}
                          />
                        </div>
                        <div className="form-group f7-span-2">
                          <label className="form-label" htmlFor={`cob-whats-${conta.id}`}>
                            WhatsApp do responsável (recebe o aviso)
                          </label>
                          <input
                            id={`cob-whats-${conta.id}`}
                            className="f7-input"
                            inputMode="tel"
                            value={cobWhatsapp}
                            onChange={(e) => setCobWhatsapp(e.target.value)}
                            placeholder="+55 (85) 99999-9999"
                          />
                          <p className="form-help">
                            O aviso de suspensão é enviado para este número. Em branco, sai para o próprio chip do
                            cliente.
                          </p>
                        </div>
                        <div className="form-group f7-span-2">
                          <label className="form-label" htmlFor={`cob-aviso-${conta.id}`}>
                            Aviso enviado ao cliente quando você suspender
                          </label>
                          <textarea
                            id={`cob-aviso-${conta.id}`}
                            className="f7-textarea"
                            value={cobAviso}
                            onChange={(e) => setCobAviso(e.target.value)}
                            maxLength={600}
                            rows={3}
                          />
                          <p className="form-help">
                            Sai no WhatsApp pelo primeiro chip que reconectar. Deixe em branco para suspender sem avisar.
                          </p>
                        </div>
                      </div>
                      <div className="f7-actions">
                        <button type="submit" className="btn btn-primary btn-sm" disabled={salvandoCobranca}>
                          {salvandoCobranca ? 'Salvando...' : 'Salvar cobrança'}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCobrancaAberta(null)}>
                          Cancelar
                        </button>
                      </div>
                    </form>
                  ) : null}

                  {suporteId === conta.id ? (
                    <form onSubmit={(e) => aoEntrarEmSuporte(e, conta.id)} className="conta-editor">
                      <div className="form-group">
                        <label className="form-label" htmlFor={`sup-motivo-${conta.id}`}>
                          Motivo do suporte (vai para o registro de auditoria)
                        </label>
                        <input
                          id={`sup-motivo-${conta.id}`}
                          className="f7-input"
                          value={motivoSuporte}
                          onChange={(e) => setMotivoSuporte(e.target.value)}
                          placeholder="Ex.: Conferir treinamento e chave do provedor"
                          maxLength={300}
                        />
                      </div>
                      <div className="f7-actions">
                        <button type="submit" className="btn btn-primary btn-sm" disabled={abrindoSuporte}>
                          {abrindoSuporte ? 'Abrindo modo suporte...' : 'Confirmar entrada em suporte'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setSuporteId(null)}
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Registro de auditoria de contas e suporte</h2>
        </div>
        <p className="panel-desc">
          Histórico imutável de criação/edição de clientes SaaS e sessões de Modo Suporte.
        </p>

        {auditoria.length === 0 ? (
          <p className="panel-desc">Nenhum evento registrado ainda.</p>
        ) : (
          <div className="auditoria-lista">
            {auditoria.map((ev) => {
              const motivo = typeof ev.details?.reason === 'string' && ev.details.reason ? ` · Motivo: ${ev.details.reason}` : '';
              return (
                <div key={ev.id} className="auditoria-item">
                  <div>
                    <div className="auditoria-item-titulo">
                      {ROTULOS_ACAO[ev.action] ?? ev.action} — {ev.workspaceName}
                    </div>
                    <div className="auditoria-item-meta">
                      Por {ev.actorEmail || 'master'}
                      {motivo}
                    </div>
                  </div>
                  <div className="auditoria-item-meta">{formatarDataHora(ev.createdAt)}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {suspensoes ? (
        <Dialogo
          titulo={`Suspender ${suspensoes.conta.name}?`}
          aoFechar={() => {
            if (!suspendendo) setSuspensoes(null);
          }}
        >
          <form onSubmit={(e) => void aoSuspender(e)} style={{ display: 'grid', gap: 12 }}>
            <p className="panel-desc">
              O acesso para na hora: campanhas rodando param e os chips ficam desligados. Nada é apagado — e a
              reativação devolve o acesso. O aviso abaixo fica na fila e sai no WhatsApp pelo primeiro chip que
              reconectar.
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="susp-motivo">
                Motivo da suspensão (fica no histórico)
              </label>
              <input
                id="susp-motivo"
                className="f7-input"
                value={suspensoes.motivo}
                onChange={(e) => setSuspensoes({ ...suspensoes, motivo: e.target.value })}
                minLength={3}
                maxLength={300}
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="susp-aviso">
                Aviso no WhatsApp do cliente
              </label>
              <textarea
                id="susp-aviso"
                className="f7-textarea"
                rows={3}
                value={suspensoes.aviso}
                onChange={(e) => setSuspensoes({ ...suspensoes, aviso: e.target.value })}
                maxLength={600}
              />
              <p className="form-help">Em branco: suspende sem avisar ninguém.</p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="submit" className="btn btn-primary" disabled={suspendendo || suspensoes.motivo.trim().length < 3}>
                {suspendendo ? 'Suspendendo…' : 'Suspender agora'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={suspendendo} onClick={() => setSuspensoes(null)}>
                Cancelar
              </button>
            </div>
          </form>
        </Dialogo>
      ) : null}

      {zerando ? (
        <Dialogo
          titulo={`Zerar os dados de ${zerando.conta.name}?`}
          aoFechar={() => {
            if (!zerandoAgora) setZerando(null);
          }}
        >
          <form onSubmit={(e) => void aoZerar(e)} style={{ display: 'grid', gap: 12 }}>
            <p className="panel-desc">
              <strong>Não dá para desfazer.</strong> Apaga {zerando.conta.usage.messagesMonth > 0 ? 'todas as mensagens, ' : ''}
              contatos, conversas e campanhas deste cliente. O login e os chips (desligados) continuam — a conta fica
              como nova.
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="zerar-confirmacao">
                Digite <strong>{zerando.conta.name}</strong> para confirmar
              </label>
              <input
                id="zerar-confirmacao"
                className="f7-input"
                value={zerando.confirmacao}
                onChange={(e) => setZerando({ ...zerando, confirmacao: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={zerandoAgora || zerando.confirmacao.trim().toLowerCase() !== zerando.conta.name.trim().toLowerCase()}
              >
                {zerandoAgora ? 'Apagando…' : 'Zerar os dados'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={zerandoAgora} onClick={() => setZerando(null)}>
                Cancelar
              </button>
            </div>
          </form>
        </Dialogo>
      ) : null}

      {senhaNova ? (
        <Dialogo titulo={`Senha nova de ${senhaNova.conta}`} aoFechar={() => setSenhaNova(null)}>
          <div style={{ display: 'grid', gap: 12 }}>
            <p className="panel-desc">
              Copie agora e envie para o responsável. Ao fechar esta janela a senha não aparece de novo (o acesso
              anterior deixou de valer).
            </p>
            <p className="senha-nova">
              <code>{senhaNova.senha}</code>
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(senhaNova.senha);
                  setAviso({ tipo: 'ok', texto: 'Senha copiada. Envie para o responsável pelo cliente.' });
                }}
              >
                Copiar senha
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setSenhaNova(null)}>
                Já enviei, fechar
              </button>
            </div>
          </div>
        </Dialogo>
      ) : null}

      {excluindo ? (
      <Dialogo
        titulo={`Excluir ${excluindo.name}?`}
        aoFechar={() => {
          if (!apagando) {
            setExcluindo(null);
            setMotivoExclusao('');
          }
        }}
      >
        <form onSubmit={(e) => void confirmarExclusao(e)} style={{ display: 'grid', gap: 12 }}>
          <p className="panel-desc">
            O cliente perde o acesso na hora: campanhas rodando param e os chips ficam desligados. Os dados
            (contatos, conversas, áudios) <strong>não</strong> são apagados agora — dá para desfazer por 30 dias.
          </p>
          <div className="form-group">
            <label className="form-label" htmlFor="motivo-exclusao">
              Motivo da exclusão (fica no histórico)
            </label>
            <input
              id="motivo-exclusao"
              className="f7-input"
              value={motivoExclusao}
              onChange={(e) => setMotivoExclusao(e.target.value)}
              placeholder="Ex.: teste encerrado, cliente pediu para sair, duplicado…"
              minLength={3}
              maxLength={500}
              required
            />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={apagando || motivoExclusao.trim().length < 3}>
              {apagando ? 'Excluindo…' : 'Excluir cliente'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={apagando}
              onClick={() => {
                setExcluindo(null);
                setMotivoExclusao('');
              }}
            >
              Cancelar
            </button>
          </div>
        </form>
      </Dialogo>
      ) : null}
    </div>
  );
}


/** O que dizer enquanto uma ação do cliente está rodando (o botão também muda de texto). */
function textoDaAcaoEmCurso(acao: string): string {
  switch (acao) {
    case 'cobranca':
      return 'Salvando a cobrança…';
    case 'pago':
      return 'Registrando o pagamento…';
    case 'suspender':
      return 'Suspendendo o cliente e desligando os chips…';
    case 'reativar':
      return 'Devolvendo o acesso…';
    case 'senha':
      return 'Gerando a senha nova…';
    case 'zerar':
      return 'Apagando os dados do cliente…';
    default:
      return 'Trabalhando…';
  }
}

/** 5585988880001 → "+55 (85) 98888-0001" (só exibição; o banco guarda os dígitos). */
function formatarWhatsapp(digitos: string): string {
  const d = digitos.replace(/\D/g, '');
  if (d.length < 12) return d ? `+${d}` : '';
  const ddd = d.slice(2, 4);
  const corpo = d.slice(4);
  const meio = corpo.length > 8 ? corpo.slice(0, corpo.length - 4) : corpo.slice(0, 4);
  const fim = corpo.slice(-4);
  return `+${d.slice(0, 2)} (${ddd}) ${meio}-${fim}`;
}

/** "149,00" ou "149.00" → 14900 centavos. Vazio continua vazio (sem valor combinado). */
function valorEmCentavos(texto: string): string {
  const limpo = texto.trim().replace(/[^\d,.-]/g, '');
  if (!limpo) return '';
  const normalizado = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
  const numero = Number(normalizado);
  if (!Number.isFinite(numero) || numero < 0) return '';
  return String(Math.round(numero * 100));
}
