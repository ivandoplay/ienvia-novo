'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { MARCA_PADRAO, type ContaSaasResumo, type EventoDeAuditoriaSuporte } from '@ienvia/shared/contas';
import type { ModoSuporteAtivo } from '@/lib/sessao';
import {
  atualizarClienteSaas,
  criarClienteSaas,
  encerrarModoSuporte,
  entrarEmModoSuporte,
} from './acoes';

interface Props {
  contasIniciais: ContaSaasResumo[];
  auditoriaInicial: EventoDeAuditoriaSuporte[];
  modoSuporte: ModoSuporteAtivo | null;
}

const ROTULOS_ACAO: Record<string, string> = {
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
};

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

  // --- Modo Suporte ---
  const [suporteId, setSuporteId] = useState<string | null>(null);
  const [motivoSuporte, setMotivoSuporte] = useState('');
  const [abrindoSuporte, setAbrindoSuporte] = useState(false);
  const [encerrandoSuporte, setEncerrandoSuporte] = useState(false);

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

      {aviso ? (
        <div className={aviso.tipo === 'ok' ? 'f7-alert f7-alert--ok' : 'f7-alert f7-alert--erro'} role="status">
          {aviso.texto}
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
    </div>
  );
}
