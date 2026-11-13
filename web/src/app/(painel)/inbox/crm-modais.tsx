'use client';

import { useState, type FormEvent } from 'react';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import type { ChipDaInbox, ContatoDoDiretorio, EtiquetaDoCrm, RespostaRapida } from '@/lib/dados/inbox';
import { CORES_DE_ETIQUETA, atalhoDeHorario, deInputDateTimeLocal, limparAtalhoRapido } from '@/lib/inbox/regras';
import {
  agendarMensagem,
  apagarContatoEConversa,
  excluirEtiquetaCrm,
  excluirRespostaRapida,
  iniciarConversaManual,
  salvarContato,
  salvarEtiquetaCrm,
  salvarRespostaRapida,
} from './acoes';

export function ModalNovaConversa({
  aberto,
  aoFechar,
  chips,
  aoAbrirConversa,
}: {
  aberto: boolean;
  aoFechar: () => void;
  chips: ChipDaInbox[];
  aoAbrirConversa: (conversaId: string) => void;
}) {
  const chipsDisponiveis = chips.filter((c) => !c.removido);
  const chipPadrao = chipsDisponiveis.find((c) => c.estado === 'connected')?.id ?? chipsDisponiveis[0]?.id ?? '';
  const [chipId, setChipId] = useState(chipPadrao);
  const [telefone, setTelefone] = useState('');
  const [nome, setNome] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (!aberto) return null;

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    const res = await iniciarConversaManual({ chipId: chipId || chipPadrao, telefone, nome });
    setOcupado(false);
    if (!res.ok) {
      setErro(res.erro);
      return;
    }
    setTelefone('');
    setNome('');
    aoFechar();
    aoAbrirConversa(res.conversaId);
  }

  return (
    <Dialogo aoFechar={aoFechar} titulo="Iniciar conversa manual no WhatsApp">
      <form className="crm-form" onSubmit={(e) => void enviar(e)}>
        <div className="crm-campo">
          <label htmlFor="nova-conv-chip">Chip de saída</label>
          <select
            id="nova-conv-chip"
            className="campo"
            value={chipId || chipPadrao}
            onChange={(e) => setChipId(e.target.value)}
            required
          >
            {chipsDisponiveis.length === 0 ? <option value="">Nenhum chip ativo</option> : null}
            {chipsDisponiveis.map((c) => (
              <option key={c.id} value={c.id}>
                {c.apelido} {c.estado === 'connected' ? '(conectado)' : '(desconectado)'}
              </option>
            ))}
          </select>
        </div>

        <div className="crm-campo">
          <label htmlFor="nova-conv-tel">WhatsApp com DDD</label>
          <input
            id="nova-conv-tel"
            className="campo"
            type="tel"
            value={telefone}
            onChange={(e) => setTelefone(e.target.value)}
            placeholder="Ex: (86) 99999-0000"
            required
          />
        </div>

        <div className="crm-campo">
          <label htmlFor="nova-conv-nome">Nome do contato (opcional)</label>
          <input
            id="nova-conv-nome"
            className="campo"
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Ex: Maria Souza"
            maxLength={120}
          />
        </div>

        {erro ? <p className="aviso aviso--erro">{erro}</p> : null}

        <div className="dialogo-acoes">
          <button type="button" className="btn btn-secondary btn-sm" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={ocupado || chipsDisponiveis.length === 0}>
            {ocupado ? 'Abrindo…' : 'Abrir conversa'}
          </button>
        </div>
      </form>
    </Dialogo>
  );
}

export interface RascunhoContato {
  id?: string | null;
  nome: string;
  telefone: string;
  email: string;
  empresa: string;
  documento: string;
  cidade: string;
  origem: string;
  observacoes: string;
}

export function rascunhoDoDiretorio(c: ContatoDoDiretorio | null): RascunhoContato {
  if (!c) {
    return { nome: '', telefone: '', email: '', empresa: '', documento: '', cidade: '', origem: '', observacoes: '' };
  }
  return {
    id: c.id,
    nome: c.temNome ? c.nome : '',
    telefone: c.telefoneCru || c.telefone,
    email: c.email,
    empresa: c.empresa,
    documento: c.documento,
    cidade: c.cidade,
    origem: c.origem,
    observacoes: c.observacoes,
  };
}

export function ModalEditarContato({
  aberto,
  aoFechar,
  inicial,
  aoSalvar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  inicial: RascunhoContato;
  aoSalvar: () => void;
}) {
  const [nome, setNome] = useState(inicial.nome);
  const [telefone, setTelefone] = useState(inicial.telefone);
  const [email, setEmail] = useState(inicial.email);
  const [empresa, setEmpresa] = useState(inicial.empresa);
  const [documento, setDocumento] = useState(inicial.documento);
  const [cidade, setCidade] = useState(inicial.cidade);
  const [origem, setOrigem] = useState(inicial.origem);
  const [observacoes, setObservacoes] = useState(inicial.observacoes);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (!aberto) return null;

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    const res = await salvarContato({
      contatoId: inicial.id ?? null,
      nome,
      telefone,
      email,
      empresa,
      documento,
      cidade,
      origem,
      observacoes,
    });
    setOcupado(false);
    if (!res.ok) {
      setErro(res.erro);
      return;
    }
    aoFechar();
    aoSalvar();
  }

  return (
    <Dialogo aoFechar={aoFechar} titulo={inicial.id ? 'Editar ficha do contato' : 'Novo contato na agenda'} largo>
      <form className="crm-form crm-form--duas-colunas" onSubmit={(e) => void enviar(e)}>
        <div className="crm-campo">
          <label htmlFor="ed-nome">Nome completo *</label>
          <input id="ed-nome" className="campo" value={nome} onChange={(e) => setNome(e.target.value)} required maxLength={120} />
        </div>
        <div className="crm-campo">
          <label htmlFor="ed-tel">WhatsApp / Telefone</label>
          <input
            id="ed-tel"
            className="campo"
            value={telefone}
            onChange={(e) => setTelefone(e.target.value)}
            placeholder="(86) 99999-0000"
            maxLength={40}
          />
        </div>
        <div className="crm-campo">
          <label htmlFor="ed-empresa">Empresa / Negócio</label>
          <input id="ed-empresa" className="campo" value={empresa} onChange={(e) => setEmpresa(e.target.value)} maxLength={120} />
        </div>
        <div className="crm-campo">
          <label htmlFor="ed-email">E-mail</label>
          <input id="ed-email" className="campo" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} />
        </div>
        <div className="crm-campo">
          <label htmlFor="ed-doc">CPF / CNPJ</label>
          <input id="ed-doc" className="campo" value={documento} onChange={(e) => setDocumento(e.target.value)} maxLength={40} />
        </div>
        <div className="crm-campo">
          <label htmlFor="ed-cidade">Cidade / UF</label>
          <input id="ed-cidade" className="campo" value={cidade} onChange={(e) => setCidade(e.target.value)} maxLength={100} />
        </div>
        <div className="crm-campo crm-campo--inteiro">
          <label htmlFor="ed-origem">Origem do contato</label>
          <input
            id="ed-origem"
            className="campo"
            value={origem}
            onChange={(e) => setOrigem(e.target.value)}
            placeholder="Ex: Instagram, Indicação, Google, Balcão"
            maxLength={80}
          />
        </div>
        <div className="crm-campo crm-campo--inteiro">
          <label htmlFor="ed-obs">Observações fixas do contato</label>
          <textarea
            id="ed-obs"
            className="campo"
            rows={3}
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            maxLength={2000}
          />
        </div>

        {erro ? <p className="aviso aviso--erro crm-campo--inteiro">{erro}</p> : null}

        <div className="dialogo-acoes crm-campo--inteiro">
          <button type="button" className="btn btn-secondary btn-sm" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={ocupado}>
            {ocupado ? 'Salvando…' : 'Salvar contato'}
          </button>
        </div>
      </form>
    </Dialogo>
  );
}

export function ModalCatalogosCrm({
  aberto,
  aoFechar,
  etiquetas,
  respostasRapidas,
  aoAtualizar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  etiquetas: EtiquetaDoCrm[];
  respostasRapidas: RespostaRapida[];
  aoAtualizar: () => void;
}) {
  const [abaModal, setAbaModal] = useState<'etiquetas' | 'respostas'>('etiquetas');
  const [nomeTag, setNomeTag] = useState('');
  const [corTag, setCorTag] = useState<string>(CORES_DE_ETIQUETA[0]);
  const [atalho, setAtalho] = useState('');
  const [tituloResp, setTituloResp] = useState('');
  const [textoResp, setTextoResp] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (!aberto) return null;

  async function criarTag(e: FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    const res = await salvarEtiquetaCrm({ nome: nomeTag, cor: corTag });
    setOcupado(false);
    if (!res.ok) return setErro(res.erro);
    setNomeTag('');
    aoAtualizar();
  }

  async function removerTag(id: string) {
    setOcupado(true);
    setErro(null);
    const res = await excluirEtiquetaCrm({ etiquetaId: id });
    setOcupado(false);
    if (!res.ok) return setErro(res.erro);
    aoAtualizar();
  }

  async function criarResposta(e: FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    const res = await salvarRespostaRapida({ atalho: limparAtalhoRapido(atalho), titulo: tituloResp, texto: textoResp });
    setOcupado(false);
    if (!res.ok) return setErro(res.erro);
    setAtalho('');
    setTituloResp('');
    setTextoResp('');
    aoAtualizar();
  }

  async function removerResposta(id: string) {
    setOcupado(true);
    setErro(null);
    const res = await excluirRespostaRapida({ respostaId: id });
    setOcupado(false);
    if (!res.ok) return setErro(res.erro);
    aoAtualizar();
  }

  return (
    <Dialogo aoFechar={aoFechar} titulo="Etiquetas e Respostas rápidas (/)" largo>
      <div className="crm-modal-abas" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={abaModal === 'etiquetas'}
          className={`inbox-filtro${abaModal === 'etiquetas' ? ' inbox-filtro--ativo' : ''}`}
          onClick={() => {
            setAbaModal('etiquetas');
            setErro(null);
          }}
        >
          <Icone nome="etiqueta" className="icon-15" />
          Etiquetas ({etiquetas.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={abaModal === 'respostas'}
          className={`inbox-filtro${abaModal === 'respostas' ? ' inbox-filtro--ativo' : ''}`}
          onClick={() => {
            setAbaModal('respostas');
            setErro(null);
          }}
        >
          <Icone nome="raio" className="icon-15" />
          Respostas rápidas / ({respostasRapidas.length})
        </button>
      </div>

      {erro ? <p className="aviso aviso--erro">{erro}</p> : null}

      {abaModal === 'etiquetas' ? (
        <div className="crm-catalogo-box">
          <form className="crm-catalogo-form" onSubmit={(e) => void criarTag(e)}>
            <input
              className="campo"
              value={nomeTag}
              onChange={(e) => setNomeTag(e.target.value)}
              placeholder="Nome da nova etiqueta (ex: VIP, Orçamento)"
              maxLength={40}
              required
            />
            <div className="crm-cores" role="group" aria-label="Cor da etiqueta">
              {CORES_DE_ETIQUETA.map((cor) => (
                <button
                  key={cor}
                  type="button"
                  className={`crm-cor-btn${corTag === cor ? ' crm-cor-btn--ativa' : ''}`}
                  style={{ background: cor }}
                  onClick={() => setCorTag(cor)}
                  aria-label={`Cor ${cor}`}
                />
              ))}
            </div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={ocupado}>
              Criar etiqueta
            </button>
          </form>

          <ul className="crm-catalogo-lista">
            {etiquetas.length === 0 ? <li className="crm-catalogo-vazio">Nenhuma etiqueta criada ainda.</li> : null}
            {etiquetas.map((tag) => (
              <li key={tag.id} className="crm-catalogo-item">
                <span className="crm-tag-pill" style={{ borderColor: tag.cor, color: tag.cor }}>
                  <span className="crm-tag-dot" style={{ background: tag.cor }} />
                  {tag.nome}
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void removerTag(tag.id)} disabled={ocupado}>
                  Excluir
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="crm-catalogo-box">
          <form className="crm-form" onSubmit={(e) => void criarResposta(e)}>
            <div className="crm-form-linha">
              <div className="crm-campo">
                <label htmlFor="qr-atalho">Atalho (digite / no chat)</label>
                <input
                  id="qr-atalho"
                  className="campo"
                  value={atalho}
                  onChange={(e) => setAtalho(e.target.value)}
                  placeholder="ex: pix ou horario"
                  maxLength={40}
                  required
                />
              </div>
              <div className="crm-campo">
                <label htmlFor="qr-titulo">Título curto</label>
                <input
                  id="qr-titulo"
                  className="campo"
                  value={tituloResp}
                  onChange={(e) => setTituloResp(e.target.value)}
                  placeholder="ex: Dados para pagamento PIX"
                  maxLength={80}
                  required
                />
              </div>
            </div>
            <div className="crm-campo">
              <label htmlFor="qr-texto">Texto da mensagem</label>
              <textarea
                id="qr-texto"
                className="campo"
                rows={3}
                value={textoResp}
                onChange={(e) => setTextoResp(e.target.value)}
                placeholder="Mensagem pronta que preenche a caixa de envio..."
                maxLength={4096}
                required
              />
            </div>
            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={ocupado}>
                Salvar resposta rápida
              </button>
            </div>
          </form>

          <ul className="crm-catalogo-lista">
            {respostasRapidas.length === 0 ? (
              <li className="crm-catalogo-vazio">Nenhuma resposta rápida criada. Digite / na conversa após criar a primeira.</li>
            ) : null}
            {respostasRapidas.map((qr) => (
              <li key={qr.id} className="crm-catalogo-item crm-catalogo-item--coluna">
                <div className="crm-catalogo-item-topo">
                  <div>
                    <code className="crm-atalho-badge">/{qr.atalho}</code>
                    <strong>{qr.titulo}</strong>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void removerResposta(qr.id)} disabled={ocupado}>
                    Excluir
                  </button>
                </div>
                <p className="crm-catalogo-previa">{qr.texto}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialogo>
  );
}

export function ModalAgendarMensagem({
  aberto,
  aoFechar,
  conversaId,
  textoInicial,
  aoAgendar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  conversaId: string;
  textoInicial: string;
  aoAgendar: () => void;
}) {
  const [texto, setTexto] = useState(textoInicial);
  const [quando, setQuando] = useState(() => atalhoDeHorario('1h'));
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (!aberto) return null;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    const iso = deInputDateTimeLocal(quando);
    if (!iso) return setErro('Escolha uma data e hora válidas.');
    setOcupado(true);
    setErro(null);
    const res = await agendarMensagem({ conversaId, texto, paraQuandoIso: iso });
    setOcupado(false);
    if (!res.ok) return setErro(res.erro);
    aoFechar();
    aoAgendar();
  }

  return (
    <Dialogo aoFechar={aoFechar} titulo="Agendar envio automático no WhatsApp">
      <form className="crm-form" onSubmit={(e) => void enviar(e)}>
        <div className="crm-atalhos-hora">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQuando(atalhoDeHorario('1h'))}>
            Daqui 1 hora
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQuando(atalhoDeHorario('3h'))}>
            Daqui 3 horas
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQuando(atalhoDeHorario('amanha'))}>
            Amanhã 09h
          </button>
        </div>

        <div className="crm-campo">
          <label htmlFor="ag-data">Data e hora (horário de Brasília)</label>
          <input
            id="ag-data"
            type="datetime-local"
            className="campo"
            value={quando}
            onChange={(e) => setQuando(e.target.value)}
            required
          />
        </div>

        <div className="crm-campo">
          <label htmlFor="ag-texto">Mensagem a enviar</label>
          <textarea
            id="ag-texto"
            className="campo"
            rows={4}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="Escreva a mensagem agendada..."
            maxLength={4096}
            required
          />
        </div>

        {erro ? <p className="aviso aviso--erro">{erro}</p> : null}

        <div className="dialogo-acoes">
          <button type="button" className="btn btn-secondary btn-sm" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={ocupado}>
            {ocupado ? 'Agendando…' : 'Confirmar agendamento'}
          </button>
        </div>
      </form>
    </Dialogo>
  );
}

export function ModalConfirmarExclusao({
  aberto,
  aoFechar,
  contatoId,
  nomeContato,
  aoApagar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  contatoId: string;
  nomeContato: string;
  aoApagar: () => void;
}) {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (!aberto) return null;

  async function confirmar() {
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    const res = await apagarContatoEConversa({ contatoId });
    setOcupado(false);
    if (!res.ok) return setErro(res.erro);
    aoFechar();
    aoApagar();
  }

  return (
    <Dialogo aoFechar={aoFechar} titulo="Apagar contato e conversa">
      <div className="crm-form">
        <p className="crm-aviso-exclusao">
          Você está prestes a apagar permanentemente <strong>{nomeContato}</strong>, todo o histórico de mensagens, notas internas e arquivos
          recebidos dessa conversa. Essa ação fica registrada na auditoria e não pode ser desfeita.
        </p>
        {erro ? <p className="aviso aviso--erro">{erro}</p> : null}
        <div className="dialogo-acoes">
          <button type="button" className="btn btn-secondary btn-sm" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void confirmar()} disabled={ocupado}>
            {ocupado ? 'Apagando…' : 'Sim, apagar definitivamente'}
          </button>
        </div>
      </div>
    </Dialogo>
  );
}
