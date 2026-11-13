'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import QRCode from 'qrcode';
import {
  LIMITE_MIDIAS_POR_ITEM,
  type ArquivoDeCatalogo,
  type ItemDoCatalogo,
} from '@ienvia/shared/recursos';
import {
  formatarMensagemPix,
  ROTULOS_CHAVE_PIX,
  TIPOS_CHAVE_PIX,
  type ConfiguracaoPix,
  type TipoChavePix,
} from '@ienvia/shared/recursos-pix';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import type { DadosDoCatalogo } from '@/lib/dados/recursos';
import { enderecoDoRecurso } from '@/lib/inbox/arquivos';
import {
  excluirItemDoCatalogo,
  prepararUploadArquivoCatalogo,
  salvarConfiguracaoPix,
  salvarItemDoCatalogo,
} from './acoes';

type AbaCatalogo = 'itens' | 'pix';

interface ArquivoRascunho {
  id: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  sortOrder: number;
}

interface ItemRascunho {
  id: string;
  name: string;
  category: string;
  price: string;
  description: string;
  paymentLink: string;
  active: boolean;
  sortOrder: number;
  files: ArquivoRascunho[];
}

interface Props {
  dados: DadosDoCatalogo;
  ehDono: boolean;
}

function novoIdUuid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : '00000000-0000-4000-8000-000000000000';
}

function rascunhoVazio(ordem: number): ItemRascunho {
  return {
    id: novoIdUuid(),
    name: '',
    category: 'Produto',
    price: '',
    description: '',
    paymentLink: '',
    active: true,
    sortOrder: ordem,
    files: [],
  };
}

function deItemParaRascunho(item: ItemDoCatalogo): ItemRascunho {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    price: item.price,
    description: item.description,
    paymentLink: item.paymentLink,
    active: item.active,
    sortOrder: item.sortOrder,
    files: item.files.map((f: ArquivoDeCatalogo, i) => ({
      id: f.id,
      objectKey: f.objectKey,
      fileName: f.fileName,
      contentType: f.contentType,
      byteSize: f.byteSize,
      sortOrder: i,
    })),
  };
}

function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PainelDeCatalogo({ dados, ehDono }: Props) {
  const [aba, setAba] = useState<AbaCatalogo>('itens');
  const [itens, setItens] = useState<ItemDoCatalogo[]>(dados.itens);
  const [pix, setPix] = useState<ConfiguracaoPix>(dados.pix);

  const [busca, setBusca] = useState('');
  const [filtroCategoria, setFiltroCategoria] = useState('todas');
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(
    dados.erroLeitura ? { tipo: 'erro', texto: dados.erroLeitura } : null,
  );

  // Modal de edição/criação de item
  const [editando, setEditando] = useState<ItemRascunho | null>(null);
  const [erroModal, setErroModal] = useState<string | null>(null);
  const [enviandoArquivos, setEnviandoArquivos] = useState(false);
  const [confirmarExclusao, setConfirmarExclusao] = useState<ItemDoCatalogo | null>(null);
  const [valorTestePix, setValorTestePix] = useState('149,90');
  const [qrPrevia, setQrPrevia] = useState<{ codigo: string; url: string } | null>(null);
  const [copiado, setCopiado] = useState(false);

  const [pendente, iniciarTransacao] = useTransition();

  const categorias = useMemo(() => {
    const mapa = new Set<string>();
    for (const item of itens) {
      if (item.category.trim()) mapa.add(item.category.trim());
    }
    return Array.from(mapa).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [itens]);

  const itensFiltrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return itens.filter((item) => {
      if (filtroCategoria !== 'todas' && item.category.trim() !== filtroCategoria) return false;
      if (!termo) return true;
      return (
        item.name.toLowerCase().includes(termo) ||
        item.category.toLowerCase().includes(termo) ||
        item.description.toLowerCase().includes(termo) ||
        item.price.toLowerCase().includes(termo)
      );
    });
  }, [itens, busca, filtroCategoria]);

  const previaPix = useMemo(() => {
    return formatarMensagemPix({ ...pix, allowDisabled: true }, valorTestePix || null);
  }, [pix, valorTestePix]);

  useEffect(() => {
    let ativo = true;
    const codigo = previaPix?.qrBrcode;
    if (!codigo) return;
    void QRCode.toDataURL(codigo, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then((url) => {
        if (ativo) setQrPrevia({ codigo, url });
      })
      .catch(() => {
        if (ativo) setQrPrevia(null);
      });
    return () => {
      ativo = false;
    };
  }, [previaPix?.qrBrcode]);

  const qrPreviaUrl = previaPix?.qrBrcode && qrPrevia?.codigo === previaPix.qrBrcode ? qrPrevia.url : null;

  async function subirArquivosNoItem(arquivos: FileList | null) {
    if (!arquivos || arquivos.length === 0 || !editando) return;
    setErroModal(null);
    const restantes = LIMITE_MIDIAS_POR_ITEM - editando.files.length;
    if (restantes <= 0) {
      setErroModal(`Cada item aceita no máximo ${LIMITE_MIDIAS_POR_ITEM} arquivos.`);
      return;
    }
    const lista = Array.from(arquivos).slice(0, restantes);
    setEnviandoArquivos(true);

    try {
      const novos: ArquivoRascunho[] = [];
      for (const arquivo of lista) {
        const tipo = arquivo.type || (arquivo.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
        const prep = await prepararUploadArquivoCatalogo({
          itemId: editando.id,
          fileName: arquivo.name,
          contentType: tipo,
          byteSize: arquivo.size,
        });
        if (!prep.ok) {
          setErroModal(prep.erro);
          continue;
        }
        const envio = await fetch(prep.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': tipo },
          body: arquivo,
        });
        if (!envio.ok) {
          setErroModal(`Não foi possível enviar "${arquivo.name}". Tente de novo.`);
          continue;
        }
        novos.push({
          id: prep.fileId,
          objectKey: prep.objectKey,
          fileName: prep.safeName,
          contentType: tipo,
          byteSize: arquivo.size,
          sortOrder: editando.files.length + novos.length,
        });
      }
      if (novos.length > 0) {
        setEditando((atual) => (atual ? { ...atual, files: [...atual.files, ...novos].slice(0, LIMITE_MIDIAS_POR_ITEM) } : atual));
      }
    } finally {
      setEnviandoArquivos(false);
    }
  }

  function salvarEdicaoItem() {
    if (!editando) return;
    setErroModal(null);
    iniciarTransacao(async () => {
      const res = await salvarItemDoCatalogo({
        id: editando.id,
        name: editando.name,
        category: editando.category,
        price: editando.price,
        description: editando.description,
        paymentLink: editando.paymentLink,
        active: editando.active,
        sortOrder: editando.sortOrder,
        files: editando.files.map((f) => ({
          objectKey: f.objectKey,
          fileName: f.fileName,
          contentType: f.contentType,
          byteSize: f.byteSize,
        })),
      });
      if (!res.ok) {
        setErroModal(res.erro);
        return;
      }
      setItens((prev) => {
        const existe = prev.some((i) => i.id === res.item.id);
        return existe ? prev.map((i) => (i.id === res.item.id ? res.item : i)) : [res.item, ...prev];
      });
      setEditando(null);
      setAviso({ tipo: 'ok', texto: `Item "${res.item.name}" salvo no catálogo.` });
    });
  }

  function alternarAtivo(item: ItemDoCatalogo) {
    if (!ehDono) return;
    setAviso(null);
    iniciarTransacao(async () => {
      const res = await salvarItemDoCatalogo({
        id: item.id,
        name: item.name,
        category: item.category,
        price: item.price,
        description: item.description,
        paymentLink: item.paymentLink,
        active: !item.active,
        sortOrder: item.sortOrder,
        files: item.files.map((f) => ({
          objectKey: f.objectKey,
          fileName: f.fileName,
          contentType: f.contentType,
          byteSize: f.byteSize,
        })),
      });
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        return;
      }
      setItens((prev) => prev.map((i) => (i.id === res.item.id ? res.item : i)));
      setAviso({ tipo: 'ok', texto: res.item.active ? `"${res.item.name}" ativado para a IA.` : `"${res.item.name}" ocultado da IA.` });
    });
  }

  function confirmarRemoverItem() {
    if (!confirmarExclusao) return;
    const alvo = confirmarExclusao;
    iniciarTransacao(async () => {
      const res = await excluirItemDoCatalogo(alvo.id);
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        setConfirmarExclusao(null);
        return;
      }
      setItens((prev) => prev.filter((i) => i.id !== alvo.id));
      setConfirmarExclusao(null);
      setAviso({ tipo: 'ok', texto: `"${alvo.name}" removido do catálogo.` });
    });
  }

  function salvarPix() {
    setAviso(null);
    iniciarTransacao(async () => {
      const res = await salvarConfiguracaoPix(pix);
      if (!res.ok) {
        setAviso({ tipo: 'erro', texto: res.erro });
        return;
      }
      setPix(res.pix);
      setAviso({ tipo: 'ok', texto: 'Configuração de PIX e QR Code salva.' });
    });
  }

  async function copiarCodigoPix() {
    if (!previaPix?.qrBrcode || typeof navigator === 'undefined' || !navigator.clipboard) return;
    await navigator.clipboard.writeText(previaPix.qrBrcode);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2200);
  }

  return (
    <div className="f6-pagina">
      <div className="page-header">
        <div>
          <h1>Catálogo &amp; PIX</h1>
          <p>
            Cadastre produtos com até 5 fotos ou PDFs e ative o envio automático de PIX com QR Code e Copia e Cola para a IA e a Inbox.
          </p>
        </div>
        {aba === 'itens' && ehDono ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setErroModal(null);
              setEditando(rascunhoVazio(itens.length));
            }}
          >
            <Icone nome="adicionar" className="icon-15" />
            Novo item do catálogo
          </button>
        ) : null}
      </div>

      <div className="f5-abas" role="tablist" aria-label="Seções do catálogo">
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'itens'}
          className={`f5-aba${aba === 'itens' ? ' ativa' : ''}`}
          onClick={() => setAba('itens')}
        >
          <Icone nome="catalogo" className="icon-15" />
          Produtos e Serviços ({itens.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === 'pix'}
          className={`f5-aba${aba === 'pix' ? ' ativa' : ''}`}
          onClick={() => setAba('pix')}
        >
          <Icone nome="qrCode" className="icon-15" />
          PIX e QR Code {pix.enabled ? '· Ativo' : ''}
        </button>
      </div>

      {!ehDono ? (
        <div className="f5-aviso-topo">
          <span>Você pode consultar os itens do catálogo e enviar qualquer item ou PIX diretamente nas conversas da Inbox. Somente o dono da conta edita ou apaga itens.</span>
        </div>
      ) : null}

      {aviso ? (
        <div className={`aviso ${aviso.tipo === 'ok' ? 'aviso--ok' : 'aviso--erro'}`} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>
          {aviso.texto}
        </div>
      ) : null}

      {aba === 'itens' ? (
        <section aria-label="Itens do catálogo">
          <div className="f6-barra-topo" style={{ marginBottom: 14 }}>
            <div className="f6-filtros">
              <label htmlFor="f6-busca-catalogo" className="so-leitor-de-tela">
                Buscar item do catálogo
              </label>
              <input
                id="f6-busca-catalogo"
                type="search"
                className="campo"
                placeholder="Buscar por nome, categoria ou preço..."
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                style={{ minWidth: 240 }}
              />
              <label htmlFor="f6-cat-catalogo" className="so-leitor-de-tela">
                Filtrar por categoria
              </label>
              <select
                id="f6-cat-catalogo"
                className="campo"
                value={filtroCategoria}
                onChange={(e) => setFiltroCategoria(e.target.value)}
              >
                <option value="todas">Todas as categorias ({itens.length})</option>
                {categorias.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {itensFiltrados.length === 0 ? (
            <div className="panel" style={{ textAlign: 'center', padding: '32px 20px' }}>
              <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)' }}>
                {itens.length === 0
                  ? 'Nenhum item no catálogo ainda. Cadastre o primeiro produto ou serviço com fotos/PDFs.'
                  : 'Nenhum item encontrado com os filtros atuais.'}
              </p>
              {itens.length === 0 && ehDono ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setErroModal(null);
                    setEditando(rascunhoVazio(0));
                  }}
                >
                  <Icone nome="adicionar" className="icon-15" />
                  Cadastrar primeiro item
                </button>
              ) : null}
            </div>
          ) : (
            <div className="f6-grade-cards">
              {itensFiltrados.map((item) => (
                <article key={item.id} className={`f6-card${item.active ? '' : ' f6-card--inativo'}`}>
                  <div className="f6-card-topo">
                    <div>
                      <h2 className="f6-card-titulo">{item.name}</h2>
                      <p className="f6-card-sub">
                        {item.category || 'Produto'} · {item.active ? 'Ativo para IA e Inbox' : 'Oculto da IA'}
                      </p>
                    </div>
                    {item.price ? <span className="f6-preco">R$ {item.price}</span> : null}
                  </div>

                  {item.description ? <p className="f6-desc">{item.description}</p> : null}

                  {item.files.length > 0 ? (
                    <div className="f6-midias-strip">
                      {item.files.map((arq) => {
                        const url = enderecoDoRecurso(arq.objectKey);
                        const ehPdf = arq.contentType === 'application/pdf';
                        return (
                          <a
                            key={arq.id}
                            href={url ?? '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="f6-thumb"
                            title={arq.fileName}
                          >
                            {ehPdf || !url ? (
                              <>
                                <Icone nome="documento" className="icon-18" />
                                <span>PDF</span>
                              </>
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={url} alt={arq.fileName} />
                            )}
                          </a>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="f6-card-sub">Sem foto ou PDF anexado (apenas dados em texto para a IA).</p>
                  )}

                  {item.paymentLink ? (
                    <p className="f6-card-sub" style={{ wordBreak: 'break-all' }}>
                      Link: <a href={item.paymentLink} target="_blank" rel="noopener noreferrer">{item.paymentLink}</a>
                    </p>
                  ) : null}

                  {ehDono ? (
                    <div className="f6-card-acoes">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={pendente}
                        onClick={() => alternarAtivo(item)}
                      >
                        {item.active ? 'Desativar' : 'Ativar'}
                      </button>
                      <div className="f6-card-botoes">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setErroModal(null);
                            setEditando(deItemParaRascunho(item));
                          }}
                        >
                          <Icone nome="lapis" className="icon-15" />
                          Editar
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setConfirmarExclusao(item)}
                        >
                          <Icone nome="lixeira" className="icon-15" />
                          Excluir
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="f6-pix-grade" aria-label="Configuração PIX e QR Code">
          <div className="panel" style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 16 }}>Cobrança PIX automática</h2>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
                  Quando ativado, a IA gera QR Code e Copia e Cola EMV padrão Banco Central na hora.
                </p>
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: ehDono ? 'pointer' : 'default', fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={pix.enabled}
                  disabled={!ehDono}
                  onChange={(e) => setPix((p) => ({ ...p, enabled: e.target.checked }))}
                />
                Ativo
              </label>
            </div>

            <div className="f5-grade-2">
              <div className="campo-bloco">
                <label htmlFor="pix-tipo">Tipo de chave PIX</label>
                <select
                  id="pix-tipo"
                  className="campo"
                  value={pix.keyType}
                  disabled={!ehDono}
                  onChange={(e) => setPix((p) => ({ ...p, keyType: e.target.value as TipoChavePix }))}
                >
                  {TIPOS_CHAVE_PIX.map((tipo) => (
                    <option key={tipo} value={tipo}>
                      {ROTULOS_CHAVE_PIX[tipo]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="campo-bloco">
                <label htmlFor="pix-chave">Chave PIX</label>
                <input
                  id="pix-chave"
                  type="text"
                  className="campo"
                  placeholder={pix.keyType === 'email' ? 'pix@suaempresa.com' : pix.keyType === 'celular' ? '(86) 99999-0000' : 'Informe sua chave'}
                  value={pix.key}
                  disabled={!ehDono}
                  onChange={(e) => setPix((p) => ({ ...p, key: e.target.value }))}
                />
              </div>
            </div>

            <div className="f5-grade-2">
              <div className="campo-bloco">
                <label htmlFor="pix-favorecido">Nome do favorecido (aparece no QR Code)</label>
                <input
                  id="pix-favorecido"
                  type="text"
                  className="campo"
                  placeholder="Nome ou razão social"
                  value={pix.receiverName}
                  disabled={!ehDono}
                  onChange={(e) => setPix((p) => ({ ...p, receiverName: e.target.value }))}
                />
              </div>

              <div className="campo-bloco">
                <label htmlFor="pix-banco">Banco / Instituição</label>
                <input
                  id="pix-banco"
                  type="text"
                  className="campo"
                  placeholder="Ex.: Nubank, Inter, Banco do Brasil"
                  value={pix.bankName}
                  disabled={!ehDono}
                  onChange={(e) => setPix((p) => ({ ...p, bankName: e.target.value }))}
                />
              </div>
            </div>

            <div className="campo-bloco">
              <label htmlFor="pix-cidade">Cidade (padrão EMV)</label>
              <input
                id="pix-cidade"
                type="text"
                className="campo"
                placeholder="BRASIL"
                value={pix.city}
                disabled={!ehDono}
                onChange={(e) => setPix((p) => ({ ...p, city: e.target.value }))}
              />
            </div>

            <div className="campo-bloco">
              <label htmlFor="pix-instrucoes">Instruções extras ao enviar PIX</label>
              <textarea
                id="pix-instrucoes"
                rows={3}
                className="campo"
                placeholder="Ex.: Assim que pagar, envie o comprovante por aqui para confirmarmos."
                value={pix.instructions}
                disabled={!ehDono}
                onChange={(e) => setPix((p) => ({ ...p, instructions: e.target.value }))}
              />
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={pix.sendQrImage}
                  disabled={!ehDono}
                  onChange={(e) => setPix((p) => ({ ...p, sendQrImage: e.target.checked }))}
                />
                Enviar imagem do QR Code no WhatsApp
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={pix.includeCopyPaste}
                  disabled={!ehDono}
                  onChange={(e) => setPix((p) => ({ ...p, includeCopyPaste: e.target.checked }))}
                />
                Enviar código PIX Copia e Cola separado
              </label>
            </div>

            {ehDono ? (
              <div>
                <button type="button" className="btn btn-primary" disabled={pendente} onClick={salvarPix}>
                  {pendente ? 'Salvando PIX…' : 'Salvar configuração PIX'}
                </button>
              </div>
            ) : null}
          </div>

          <aside className="f6-pix-previa" aria-label="Prévia do QR Code PIX">
            <h2 style={{ margin: 0, fontSize: 15 }}>Prévia ao vivo do QR Code</h2>
            <div className="campo-bloco">
              <label htmlFor="pix-valor-teste">Simular valor (opcional)</label>
              <input
                id="pix-valor-teste"
                type="text"
                className="campo"
                placeholder="149,90"
                value={valorTestePix}
                onChange={(e) => setValorTestePix(e.target.value)}
              />
            </div>

            {previaPix && qrPreviaUrl ? (
              <>
                <div className="f6-pix-qr-box">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrPreviaUrl} alt="QR Code PIX de prévia" />
                  <small style={{ color: '#475569', fontSize: 11.5 }}>
                    {pix.receiverName || 'RECEBEDOR'} · {pix.city || 'BRASIL'}
                  </small>
                </div>
                <div className="campo-bloco">
                  <label>BR Code EMV (Copia e Cola)</label>
                  <div className="f6-codigo-mono">{previaPix.qrBrcode}</div>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copiarCodigoPix()}>
                  <Icone nome={copiado ? 'confere' : 'copiar'} className="icon-15" />
                  {copiado ? 'Código copiado!' : 'Copiar código PIX'}
                </button>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
                Preencha uma chave PIX válida ao lado para visualizar o QR Code e o código EMV em tempo real.
              </p>
            )}
          </aside>
        </section>
      )}

      {editando ? (
        <Dialogo
          titulo={itens.some((i) => i.id === editando.id) ? `Editar: ${editando.name || 'Item'}` : 'Novo item do catálogo'}
          aoFechar={() => {
            if (!pendente && !enviandoArquivos) setEditando(null);
          }}
          largo
        >
          <div style={{ display: 'grid', gap: 12 }}>
            {erroModal ? (
              <div className="aviso aviso--erro" role="alert">
                {erroModal}
              </div>
            ) : null}

            <div className="f5-grade-2">
              <div className="campo-bloco">
                <label htmlFor="cat-nome">Nome do produto / serviço</label>
                <input
                  id="cat-nome"
                  type="text"
                  className="campo"
                  placeholder="Ex.: Toyota Corolla 2024 XEi"
                  value={editando.name}
                  onChange={(e) => setEditando({ ...editando, name: e.target.value })}
                />
              </div>

              <div className="campo-bloco">
                <label htmlFor="cat-categoria">Categoria</label>
                <input
                  id="cat-categoria"
                  type="text"
                  className="campo"
                  placeholder="Produto, Serviço, Combo..."
                  value={editando.category}
                  onChange={(e) => setEditando({ ...editando, category: e.target.value })}
                />
              </div>
            </div>

            <div className="f5-grade-2">
              <div className="campo-bloco">
                <label htmlFor="cat-preco">Preço / faixa (ex.: 149,90)</label>
                <input
                  id="cat-preco"
                  type="text"
                  className="campo"
                  placeholder="149,90 ou Sob consulta"
                  value={editando.price}
                  onChange={(e) => setEditando({ ...editando, price: e.target.value })}
                />
              </div>

              <div className="campo-bloco">
                <label htmlFor="cat-link">Link de pagamento (opcional, https://)</label>
                <input
                  id="cat-link"
                  type="url"
                  className="campo"
                  placeholder="https://checkout.suaempresa.com/item"
                  value={editando.paymentLink}
                  onChange={(e) => setEditando({ ...editando, paymentLink: e.target.value })}
                />
              </div>
            </div>

            <div className="campo-bloco">
              <label htmlFor="cat-desc">Detalhes para a IA usar na resposta</label>
              <textarea
                id="cat-desc"
                rows={4}
                className="campo"
                placeholder="Especificações, diferenciais, garantia, o que está incluso..."
                value={editando.description}
                onChange={(e) => setEditando({ ...editando, description: e.target.value })}
              />
            </div>

            <div className="campo-bloco">
              <label>Fotos e PDFs ({editando.files.length}/{LIMITE_MIDIAS_POR_ITEM})</label>
              <div className="f6-midias-strip">
                {editando.files.map((arq, indice) => {
                  const url = enderecoDoRecurso(arq.objectKey);
                  const ehPdf = arq.contentType === 'application/pdf';
                  return (
                    <div key={arq.objectKey} className="f6-thumb" title={`${arq.fileName} (${formatarTamanho(arq.byteSize)})`}>
                      {ehPdf || !url ? (
                        <>
                          <Icone nome="documento" className="icon-18" />
                          <span>{arq.fileName.slice(0, 12)}</span>
                        </>
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={url} alt={arq.fileName} />
                      )}
                      <button
                        type="button"
                        className="f6-thumb-remover"
                        aria-label={`Remover ${arq.fileName}`}
                        onClick={() =>
                          setEditando((atual) =>
                            atual
                              ? { ...atual, files: atual.files.filter((_, i) => i !== indice) }
                              : atual,
                          )
                        }
                      >
                        <Icone nome="fechar" className="icon-15" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {editando.files.length < LIMITE_MIDIAS_POR_ITEM ? (
                <div style={{ marginTop: 8 }}>
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                    disabled={enviandoArquivos}
                    onChange={(e) => {
                      void subirArquivosNoItem(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  {enviandoArquivos ? (
                    <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      Enviando arquivos para o depósito…
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
              <input
                type="checkbox"
                checked={editando.active}
                onChange={(e) => setEditando({ ...editando, active: e.target.checked })}
              />
              Disponível para a IA enviar automaticamente quando o cliente pedir
            </label>

            <div className="dialogo-acoes">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={pendente || enviandoArquivos}
                onClick={() => setEditando(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendente || enviandoArquivos}
                onClick={salvarEdicaoItem}
              >
                {pendente ? 'Salvando…' : 'Salvar item'}
              </button>
            </div>
          </div>
        </Dialogo>
      ) : null}

      {confirmarExclusao ? (
        <Dialogo titulo="Excluir item do catálogo?" aoFechar={() => setConfirmarExclusao(null)}>
          <p style={{ margin: '0 0 14px' }}>
            Tem certeza que deseja excluir <strong>{confirmarExclusao.name}</strong>? As fotos e PDFs anexados a este item também serão removidos do depósito.
          </p>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" disabled={pendente} onClick={() => setConfirmarExclusao(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" disabled={pendente} onClick={confirmarRemoverItem}>
              {pendente ? 'Excluindo…' : 'Excluir item'}
            </button>
          </div>
        </Dialogo>
      ) : null}
    </div>
  );
}
