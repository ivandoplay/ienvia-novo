'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type DragEvent, type FormEvent } from 'react';
import { Icone } from '@/components/ui/icone';
import type {
  CartaoDoKanban,
  ChipDaInbox,
  ContatoDoDiretorio,
  ConversaAberta,
  EtiquetaDoCrm,
} from '@/lib/dados/inbox';
import {
  ETAPAS_DO_KANBAN,
  SITUACOES_DE_NEGOCIO,
  deInputDateTimeLocal,
  enderecoDaInbox,
  formatarReais,
  normalizarValorMonetario,
} from '@/lib/inbox/regras';
import {
  adicionarNotaConversa,
  alternarEtiquetaContato,
  atualizarFlagsContato,
  atualizarNegocioConversa,
  iniciarConversaManual,
} from './acoes';
import {
  ModalConfirmarExclusao,
  ModalEditarContato,
  rascunhoDoDiretorio,
  type RascunhoContato,
} from './crm-modais';

/* -------------------------------------------------------------------------- */
/* Coluna 3 (e modal mobile): Ficha CRM do contato, Negócio, Etiquetas, Notas */
/* -------------------------------------------------------------------------- */

export function CartaoCrmDoContato({
  conversa,
  etapa,
  estadoDoChip,
  etiquetasDoWorkspace,
  aoAtualizar,
  aoApagarContato,
  aoAbrirEtiquetas,
}: {
  conversa: ConversaAberta;
  etapa: string;
  estadoDoChip: string;
  etiquetasDoWorkspace: EtiquetaDoCrm[];
  aoAtualizar: () => void;
  aoApagarContato: () => void;
  aoAbrirEtiquetas: () => void;
}) {
  const [copiado, setCopiado] = useState<'sim' | 'falhou' | null>(null);
  const [valorInput, setValorInput] = useState(() =>
    conversa.valorNegocio > 0 ? String(conversa.valorNegocio).replace('.', ',') : '',
  );
  const [motivoPerda, setMotivoPerda] = useState(conversa.motivoPerda);
  const [retornoInput, setRetornoInput] = useState(conversa.retornoInput);
  const [notaTexto, setNotaTexto] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erroCrm, setErroCrm] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);

  const idsEtiquetas = new Set(conversa.contato.etiquetas.map((t) => t.id));

  async function copiarTelefone() {
    try {
      await navigator.clipboard.writeText(conversa.contato.telefone);
      setCopiado('sim');
    } catch {
      setCopiado('falhou');
    }
  }

  async function salvarNegocio(patch: Parameters<typeof atualizarNegocioConversa>[0]) {
    setOcupado('negocio');
    setErroCrm(null);
    const res = await atualizarNegocioConversa(patch);
    setOcupado(null);
    if (!res.ok) return setErroCrm(res.erro);
    aoAtualizar();
  }

  async function alternarFlag(campo: 'ia' | 'bloqueado') {
    if (!conversa.contato.id) return;
    setOcupado(campo);
    setErroCrm(null);
    const res = await atualizarFlagsContato({
      contatoId: conversa.contato.id,
      ...(campo === 'ia' ? { iaIgnorada: !conversa.contato.iaIgnorada } : { bloqueado: !conversa.contato.bloqueado }),
    });
    setOcupado(null);
    if (!res.ok) return setErroCrm(res.erro);
    aoAtualizar();
  }

  async function alternarTag(etiquetaId: string) {
    if (!conversa.contato.id) return;
    setOcupado(`tag:${etiquetaId}`);
    setErroCrm(null);
    const res = await alternarEtiquetaContato({
      contatoId: conversa.contato.id,
      etiquetaId,
      marcar: !idsEtiquetas.has(etiquetaId),
    });
    setOcupado(null);
    if (!res.ok) return setErroCrm(res.erro);
    aoAtualizar();
  }

  async function enviarNota(e: FormEvent) {
    e.preventDefault();
    if (!notaTexto.trim() || ocupado) return;
    setOcupado('nota');
    setErroCrm(null);
    const res = await adicionarNotaConversa({ conversaId: conversa.id, texto: notaTexto });
    setOcupado(null);
    if (!res.ok) return setErroCrm(res.erro);
    setNotaTexto('');
    aoAtualizar();
  }

  const rascunhoContato: RascunhoContato = {
    id: conversa.contato.id,
    nome: conversa.contato.temNome ? conversa.contato.nome : '',
    telefone: conversa.contato.telefoneCru || conversa.contato.telefone,
    email: conversa.contato.email,
    empresa: conversa.contato.empresa,
    documento: conversa.contato.documento,
    cidade: conversa.contato.cidade,
    origem: conversa.contato.origem,
    observacoes: conversa.contato.observacoes,
  };

  return (
    <div className="contato-cartao">
      <div className="contato-topo">
        <span className="inbox-avatar inbox-avatar--grande" aria-hidden="true">
          {conversa.contato.iniciais}
        </span>
        <div>
          <p className="contato-nome">{conversa.contato.nome}</p>
          {conversa.contato.empresa ? <p className="contato-empresa">{conversa.contato.empresa}</p> : null}
          {conversa.contato.temNome ? null : <p className="contato-sem-nome">Este contato ainda não tem nome.</p>}
        </div>
      </div>

      {!conversa.contato.apagado && conversa.contato.id ? (
        <div className="contato-acoes-rapidas">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditando(true)}>
            <Icone nome="lapis" className="icon-15" />
            Editar ficha
          </button>
          <button
            type="button"
            className={`btn btn-secondary btn-sm${conversa.contato.iaIgnorada ? ' crm-btn-aviso' : ''}`}
            onClick={() => void alternarFlag('ia')}
            disabled={ocupado !== null}
            title="Impede a IA de responder automaticamente a este contato"
          >
            <Icone nome="pausa" className="icon-15" />
            {conversa.contato.iaIgnorada ? 'IA ignorada' : 'Ignorar IA'}
          </button>
          <button
            type="button"
            className={`btn btn-secondary btn-sm${conversa.contato.bloqueado ? ' crm-btn-perigo' : ''}`}
            onClick={() => void alternarFlag('bloqueado')}
            disabled={ocupado !== null}
          >
            <Icone nome="bloqueado" className="icon-15" />
            {conversa.contato.bloqueado ? 'Bloqueado' : 'Bloquear'}
          </button>
        </div>
      ) : null}

      {erroCrm ? <p className="aviso aviso--erro">{erroCrm}</p> : null}

      {/* Negócio / Kanban */}
      <div className="contato-secao">
        <div className="contato-secao-topo">
          <span>Negócio & Funil</span>
          {conversa.valorNegocio > 0 ? <strong>{formatarReais(conversa.valorNegocio)}</strong> : null}
        </div>
        <div className="crm-campo">
          <label htmlFor={`crm-etapa-${conversa.id}`}>Etapa do funil</label>
          <select
            id={`crm-etapa-${conversa.id}`}
            className="campo"
            value={conversa.etapaCrm}
            disabled={ocupado !== null}
            onChange={(e) => void salvarNegocio({ conversaId: conversa.id, etapaCrm: e.target.value })}
          >
            {ETAPAS_DO_KANBAN.map((item) => (
              <option key={item.valor} value={item.valor}>
                {item.rotulo}
              </option>
            ))}
          </select>
        </div>

        <div className="crm-form-linha">
          <div className="crm-campo">
            <label htmlFor={`crm-valor-${conversa.id}`}>Valor (R$)</label>
            <input
              id={`crm-valor-${conversa.id}`}
              className="campo"
              inputMode="decimal"
              value={valorInput}
              placeholder="0,00"
              onChange={(e) => setValorInput(e.target.value)}
              onBlur={() => {
                const novo = normalizarValorMonetario(valorInput);
                if (novo !== conversa.valorNegocio) {
                  void salvarNegocio({ conversaId: conversa.id, valorNegocio: novo });
                }
              }}
            />
          </div>
          <div className="crm-campo">
            <label htmlFor={`crm-status-${conversa.id}`}>Situação</label>
            <select
              id={`crm-status-${conversa.id}`}
              className="campo"
              value={conversa.situacaoNegocio}
              disabled={ocupado !== null}
              onChange={(e) =>
                void salvarNegocio({
                  conversaId: conversa.id,
                  situacaoNegocio: e.target.value as 'open' | 'won' | 'lost',
                })
              }
            >
              {SITUACOES_DE_NEGOCIO.map((s) => (
                <option key={s.valor} value={s.valor}>
                  {s.rotulo}
                </option>
              ))}
            </select>
          </div>
        </div>

        {conversa.situacaoNegocio === 'lost' ? (
          <div className="crm-campo">
            <label htmlFor={`crm-perda-${conversa.id}`}>Motivo da perda</label>
            <input
              id={`crm-perda-${conversa.id}`}
              className="campo"
              value={motivoPerda}
              placeholder="Ex: Preço, fechou com concorrente..."
              maxLength={160}
              onChange={(e) => setMotivoPerda(e.target.value)}
              onBlur={() => {
                if (motivoPerda.trim() !== conversa.motivoPerda) {
                  void salvarNegocio({ conversaId: conversa.id, motivoPerda: motivoPerda.trim() });
                }
              }}
            />
          </div>
        ) : null}

        <div className="crm-campo">
          <label htmlFor={`crm-retorno-${conversa.id}`}>Lembrar retorno (Follow-up)</label>
          <input
            id={`crm-retorno-${conversa.id}`}
            type="datetime-local"
            className="campo"
            value={retornoInput}
            onChange={(e) => setRetornoInput(e.target.value)}
            onBlur={() => {
              const iso = retornoInput ? deInputDateTimeLocal(retornoInput) : null;
              if (retornoInput && !iso) return;
              if (iso !== conversa.retornoEm) {
                void salvarNegocio({ conversaId: conversa.id, retornoEm: iso });
              }
            }}
          />
        </div>
      </div>

      {/* Etiquetas */}
      <div className="contato-secao">
        <div className="contato-secao-topo">
          <span>Etiquetas</span>
          <button type="button" className="contato-copiar" onClick={aoAbrirEtiquetas}>
            Gerenciar
          </button>
        </div>
        {etiquetasDoWorkspace.length === 0 ? (
          <p className="contato-detalhe">Nenhuma etiqueta criada ainda.</p>
        ) : (
          <div className="crm-tags-grade">
            {etiquetasDoWorkspace.map((tag) => {
              const ativa = idsEtiquetas.has(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`crm-tag-toggle${ativa ? ' crm-tag-toggle--ativa' : ''}`}
                  style={ativa ? { borderColor: tag.cor, color: tag.cor } : undefined}
                  disabled={ocupado !== null}
                  onClick={() => void alternarTag(tag.id)}
                >
                  <span className="crm-tag-dot" style={{ background: tag.cor }} />
                  {tag.nome}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Dados cadastrais */}
      <dl className="contato-dados">
        <div>
          <dt>Telefone</dt>
          <dd>
            {conversa.contato.telefone ? (
              <>
                <span>{conversa.contato.telefone}</span>
                <button type="button" className="contato-copiar" onClick={() => void copiarTelefone()}>
                  Copiar
                </button>
                <span role="status" className="contato-copiado">
                  {copiado === 'sim' ? 'Copiado' : copiado === 'falhou' ? 'Não deu para copiar' : ''}
                </span>
              </>
            ) : (
              'Não informado'
            )}
          </dd>
        </div>
        {conversa.contato.email ? (
          <div>
            <dt>E-mail</dt>
            <dd>{conversa.contato.email}</dd>
          </div>
        ) : null}
        {conversa.contato.cidade ? (
          <div>
            <dt>Cidade</dt>
            <dd>{conversa.contato.cidade}</dd>
          </div>
        ) : null}
        {conversa.contato.origem ? (
          <div>
            <dt>Origem</dt>
            <dd>{conversa.contato.origem}</dd>
          </div>
        ) : null}
        {conversa.contato.observacoes ? (
          <div>
            <dt>Observações</dt>
            <dd>{conversa.contato.observacoes}</dd>
          </div>
        ) : null}
        <div>
          <dt>Chip</dt>
          <dd>
            {conversa.chip.apelido} <span className="contato-detalhe">({estadoDoChip.toLowerCase()})</span>
          </dd>
        </div>
        <div>
          <dt>Situação da conversa</dt>
          <dd>{etapa}</dd>
        </div>
        <div>
          <dt>Conversa aberta em</dt>
          <dd>{conversa.desde}</dd>
        </div>
        <div>
          <dt>Contato desde</dt>
          <dd>{conversa.contato.desde}</dd>
        </div>
      </dl>

      {/* Notas internas */}
      <div className="contato-secao">
        <div className="contato-secao-topo">
          <span>Notas internas</span>
          <span className="contato-detalhe">Só a equipe vê</span>
        </div>
        <form className="crm-nota-form" onSubmit={(e) => void enviarNota(e)}>
          <textarea
            className="campo"
            rows={2}
            value={notaTexto}
            onChange={(e) => setNotaTexto(e.target.value)}
            placeholder="Escreva uma anotação interna..."
            maxLength={4000}
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={ocupado !== null || !notaTexto.trim()}>
            {ocupado === 'nota' ? 'Salvando…' : 'Salvar nota'}
          </button>
        </form>
        {conversa.notas.length > 0 ? (
          <ul className="crm-notas-lista">
            {conversa.notas.map((nota) => (
              <li key={nota.id} className="crm-nota-item">
                <div className="crm-nota-cabecalho">
                  <strong>{nota.autor}</strong>
                  <span>{nota.quando}</span>
                </div>
                <p>{nota.texto}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {!conversa.contato.apagado && conversa.contato.id ? (
        <div className="contato-rodape">
          <button
            type="button"
            className="btn btn-secondary btn-sm crm-btn-perigo"
            onClick={() => setConfirmandoExclusao(true)}
          >
            <Icone nome="lixeira" className="icon-15" />
            Apagar contato e conversa
          </button>
        </div>
      ) : null}

      <ModalEditarContato
        key={`${conversa.contato.id}:${editando ? '1' : '0'}`}
        aberto={editando}
        aoFechar={() => setEditando(false)}
        inicial={rascunhoContato}
        aoSalvar={aoAtualizar}
      />

      <ModalConfirmarExclusao
        aberto={confirmandoExclusao}
        aoFechar={() => setConfirmandoExclusao(false)}
        contatoId={conversa.contato.id}
        nomeContato={conversa.contato.nome}
        aoApagar={aoApagarContato}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Aba 2: Agenda de Contatos                                                  */
/* -------------------------------------------------------------------------- */

export function AgendaDeContatos({
  contatos,
  total,
  etiquetas,
  chips,
  buscaAtual,
  etiquetaAtual,
  aoAtualizar,
}: {
  contatos: ContatoDoDiretorio[];
  total: number;
  etiquetas: EtiquetaDoCrm[];
  chips: ChipDaInbox[];
  buscaAtual: string | null;
  etiquetaAtual: string | null;
  aoAtualizar: () => void;
}) {
  const router = useRouter();
  const [busca, setBusca] = useState(buscaAtual ?? '');
  const [editando, setEditando] = useState<RascunhoContato | null>(null);
  const [excluindo, setExcluindo] = useState<ContatoDoDiretorio | null>(null);
  const [ocupadoId, setOcupadoId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const chipPadrao = chips.find((c) => !c.removido && c.estado === 'connected')?.id ?? chips.find((c) => !c.removido)?.id ?? null;

  function filtrar(e: FormEvent) {
    e.preventDefault();
    router.push(enderecoDaInbox({ aba: 'contatos', busca: busca.trim() || null, etiquetaId: etiquetaAtual }));
  }

  async function abrirWhatsApp(contato: ContatoDoDiretorio) {
    if (contato.conversaId) {
      router.push(`/inbox?c=${contato.conversaId}`);
      return;
    }
    if (!chipPadrao || !contato.telefoneCru) {
      setErro('Para iniciar uma conversa, tenha um chip ativo e um telefone válido no contato.');
      return;
    }
    setOcupadoId(contato.id);
    setErro(null);
    const res = await iniciarConversaManual({ chipId: chipPadrao, telefone: contato.telefoneCru, nome: contato.temNome ? contato.nome : null });
    setOcupadoId(null);
    if (!res.ok) return setErro(res.erro);
    router.push(`/inbox?c=${res.conversaId}`);
  }

  async function alternarIgnorarIa(contato: ContatoDoDiretorio) {
    setOcupadoId(contato.id);
    setErro(null);
    const res = await atualizarFlagsContato({ contatoId: contato.id, iaIgnorada: !contato.iaIgnorada });
    setOcupadoId(null);
    if (!res.ok) return setErro(res.erro);
    aoAtualizar();
  }

  return (
    <section className="crm-painel" aria-label="Agenda de contatos">
      <div className="crm-barra">
        <form className="crm-barra-busca" onSubmit={filtrar}>
          <input
            className="campo"
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar contato por nome, WhatsApp, empresa ou cidade..."
          />
          <select
            className="campo"
            aria-label="Filtrar contatos por etiqueta"
            value={etiquetaAtual ?? ''}
            onChange={(e) =>
              router.push(enderecoDaInbox({ aba: 'contatos', busca: busca.trim() || null, etiquetaId: e.target.value || null }))
            }
          >
            <option value="">Todas as etiquetas</option>
            {etiquetas.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-secondary btn-sm">
            Filtrar
          </button>
        </form>
        <div className="crm-barra-acoes">
          <span className="crm-contagem">{total} contatos</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditando(rascunhoDoDiretorio(null))}>
            <Icone nome="adicionar" className="icon-15" />
            Novo contato
          </button>
        </div>
      </div>

      {erro ? <p className="aviso aviso--erro">{erro}</p> : null}

      {contatos.length === 0 ? (
        <div className="inbox-vazio">
          <Icone nome="contatos" />
          <strong>Nenhum contato encontrado</strong>
          <p>Cadastre um contato manualmente ou aguarde novas mensagens no WhatsApp.</p>
        </div>
      ) : (
        <div className="crm-contatos-grade">
          {contatos.map((c) => (
            <article key={c.id} className="crm-contato-card">
              <div className="crm-contato-card-topo">
                <span className="inbox-avatar" aria-hidden="true">
                  {c.iniciais}
                </span>
                <div className="crm-contato-card-info">
                  <strong>{c.nome}</strong>
                  <span>{[c.telefone, c.empresa, c.cidade].filter(Boolean).join(' · ') || 'Sem detalhes extras'}</span>
                </div>
                {c.valorNegocio > 0 ? <span className="crm-valor-pill">{formatarReais(c.valorNegocio)}</span> : null}
              </div>

              {(c.etiquetas.length > 0 || c.iaIgnorada || c.bloqueado || c.canal === 'manual') ? (
                <div className="crm-contato-card-tags">
                  {c.canal === 'manual' ? <span className="inbox-etiqueta">Manual</span> : null}
                  {c.iaIgnorada ? <span className="inbox-etiqueta inbox-etiqueta--atencao">IA ignorada</span> : null}
                  {c.bloqueado ? <span className="inbox-etiqueta inbox-etiqueta--atencao">Bloqueado</span> : null}
                  {c.etiquetas.map((t) => (
                    <span key={t.id} className="crm-tag-pill" style={{ borderColor: t.cor, color: t.cor }}>
                      <span className="crm-tag-dot" style={{ background: t.cor }} />
                      {t.nome}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="crm-contato-card-acoes">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={ocupadoId === c.id || (!c.conversaId && (!chipPadrao || !c.telefoneCru))}
                  onClick={() => void abrirWhatsApp(c)}
                >
                  {c.conversaId ? 'Abrir conversa' : 'Iniciar WhatsApp'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditando(rascunhoDoDiretorio(c))}>
                  Editar
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={ocupadoId === c.id}
                  onClick={() => void alternarIgnorarIa(c)}
                >
                  {c.iaIgnorada ? 'Ativar IA' : 'Ignorar IA'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm crm-btn-perigo" onClick={() => setExcluindo(c)}>
                  Apagar
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {editando ? (
        <ModalEditarContato
          key={editando.id ?? 'novo'}
          aberto
          aoFechar={() => setEditando(null)}
          inicial={editando}
          aoSalvar={aoAtualizar}
        />
      ) : null}

      {excluindo ? (
        <ModalConfirmarExclusao
          aberto
          aoFechar={() => setExcluindo(null)}
          contatoId={excluindo.id}
          nomeContato={excluindo.nome}
          aoApagar={aoAtualizar}
        />
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Aba 3: Quadro Kanban                                                       */
/* -------------------------------------------------------------------------- */

export function QuadroKanban({
  cartoes,
  etiquetas,
  chips,
  chipAtual,
  etiquetaAtual,
  aoAtualizar,
}: {
  cartoes: CartaoDoKanban[];
  etiquetas: EtiquetaDoCrm[];
  chips: ChipDaInbox[];
  chipAtual: string | null;
  etiquetaAtual: string | null;
  aoAtualizar: () => void;
}) {
  const router = useRouter();
  const [movidos, setMovidos] = useState<Record<string, string>>({});
  const [arrastandoId, setArrastandoId] = useState<string | null>(null);
  const [colunaAlvo, setColunaAlvo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const etapaDoCartao = (card: CartaoDoKanban) => movidos[card.conversaId] ?? card.etapaCrm;

  async function moverCartao(conversaId: string, novaEtapa: string) {
    setMovidos((atual) => ({ ...atual, [conversaId]: novaEtapa }));
    setErro(null);
    const res = await atualizarNegocioConversa({ conversaId, etapaCrm: novaEtapa });
    if (!res.ok) {
      setMovidos((atual) => {
        const copia = { ...atual };
        delete copia[conversaId];
        return copia;
      });
      setErro(res.erro);
      return;
    }
    aoAtualizar();
  }

  function aoSoltar(e: DragEvent<HTMLDivElement>, etapaDestino: string) {
    e.preventDefault();
    const conversaId = e.dataTransfer.getData('text/plain') || arrastandoId;
    setArrastandoId(null);
    setColunaAlvo(null);
    if (!conversaId) return;
    const card = cartoes.find((c) => c.conversaId === conversaId);
    if (!card || etapaDoCartao(card) === etapaDestino) return;
    void moverCartao(conversaId, etapaDestino);
  }

  const totalFunil = cartoes.reduce((acc, c) => (c.situacaoNegocio !== 'lost' ? acc + c.valorNegocio : acc), 0);
  const totalGanho = cartoes.reduce((acc, c) => (c.situacaoNegocio === 'won' ? acc + c.valorNegocio : acc), 0);

  return (
    <section className="crm-painel" aria-label="Quadro Kanban de vendas e atendimentos">
      <div className="crm-barra">
        <div className="crm-kanban-resumo">
          <span className="crm-resumo-pill">
            Negócios ativos: <strong>{formatarReais(totalFunil)}</strong>
          </span>
          <span className="crm-resumo-pill crm-resumo-pill--ganho">
            Ganhos: <strong>{formatarReais(totalGanho)}</strong>
          </span>
          <span className="crm-contagem">{cartoes.length} oportunidades</span>
        </div>

        <div className="crm-barra-busca">
          {chips.length > 1 ? (
            <select
              className="campo"
              aria-label="Filtrar Kanban por chip"
              value={chipAtual ?? ''}
              onChange={(e) =>
                router.push(enderecoDaInbox({ aba: 'kanban', chipId: e.target.value || null, etiquetaId: etiquetaAtual }))
              }
            >
              <option value="">Todos os chips</option>
              {chips
                .filter((c) => !c.removido)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.apelido}
                  </option>
                ))}
            </select>
          ) : null}
          <select
            className="campo"
            aria-label="Filtrar Kanban por etiqueta"
            value={etiquetaAtual ?? ''}
            onChange={(e) =>
              router.push(enderecoDaInbox({ aba: 'kanban', chipId: chipAtual, etiquetaId: e.target.value || null }))
            }
          >
            <option value="">Todas as etiquetas</option>
            {etiquetas.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome}
              </option>
            ))}
          </select>
        </div>
      </div>

      {erro ? <p className="aviso aviso--erro">{erro}</p> : null}

      <div className="kanban-grade">
        {ETAPAS_DO_KANBAN.map((col) => {
          const itens = cartoes.filter((c) => etapaDoCartao(c) === col.valor);
          const somaColuna = itens.reduce((acc, c) => acc + c.valorNegocio, 0);
          return (
            <div
              key={col.valor}
              data-crm-stage={col.valor}
              className={`kanban-coluna${colunaAlvo === col.valor ? ' kanban-coluna--alvo' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setColunaAlvo(col.valor);
              }}
              onDragLeave={() => {
                if (colunaAlvo === col.valor) setColunaAlvo(null);
              }}
              onDrop={(e) => aoSoltar(e, col.valor)}
            >
              <header className="kanban-coluna-topo">
                <div className="kanban-coluna-titulo">
                  <strong>{col.rotulo}</strong>
                  <span className="kanban-coluna-qtd">{itens.length}</span>
                </div>
                {somaColuna > 0 ? <span className="kanban-coluna-valor">{formatarReais(somaColuna)}</span> : null}
              </header>

              <div className="kanban-coluna-cartoes">
                {itens.length === 0 ? <p className="kanban-vazio">Arraste um card para cá</p> : null}
                {itens.map((card) => (
                  <article
                    key={card.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', card.conversaId);
                      setArrastandoId(card.conversaId);
                    }}
                    onDragEnd={() => {
                      setArrastandoId(null);
                      setColunaAlvo(null);
                    }}
                    className={`kanban-card${arrastandoId === card.conversaId ? ' kanban-card--arrastando' : ''}`}
                  >
                    <div className="kanban-card-topo">
                      <Link href={`/inbox?c=${card.conversaId}`} className="kanban-card-nome">
                        {card.fixada ? <Icone nome="alfinete" className="icon-15" /> : null}
                        {card.nome}
                      </Link>
                      {card.naoLidas > 0 ? <span className="inbox-nao-lidas">{card.naoLidas}</span> : null}
                    </div>
                    {card.empresa ? <p className="kanban-card-sub">{card.empresa}</p> : null}
                    {card.previa ? <p className="kanban-card-previa">{card.previa}</p> : null}

                    <div className="kanban-card-badges">
                      {card.valorNegocio > 0 ? (
                        <span className={`crm-valor-pill crm-valor-pill--${card.situacaoNegocio}`}>
                          {formatarReais(card.valorNegocio)}
                        </span>
                      ) : null}
                      {card.retornoLabel ? <span className="inbox-etiqueta">Retorno {card.retornoLabel}</span> : null}
                      {card.etiquetas.slice(0, 2).map((t) => (
                        <span key={t.id} className="crm-tag-pill" style={{ borderColor: t.cor, color: t.cor }}>
                          <span className="crm-tag-dot" style={{ background: t.cor }} />
                          {t.nome}
                        </span>
                      ))}
                    </div>

                    <div className="kanban-card-rodape">
                      <select
                        className="campo kanban-mover-select"
                        aria-label={`Mover ${card.nome} para etapa`}
                        value={etapaDoCartao(card)}
                        onChange={(e) => void moverCartao(card.conversaId, e.target.value)}
                      >
                        {ETAPAS_DO_KANBAN.map((op) => (
                          <option key={op.valor} value={op.valor}>
                            {op.rotulo}
                          </option>
                        ))}
                      </select>
                      <Link href={`/inbox?c=${card.conversaId}`} className="btn btn-secondary btn-sm">
                        Abrir
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
