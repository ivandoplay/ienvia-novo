'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import { descreverEtapaCrm, formatarReais } from '@/lib/inbox/regras';

interface ResultadoBusca {
  conversas: Array<{
    id: string;
    nome: string;
    telefone: string;
    previa: string;
    quando: string;
    etapaCrm: string;
    valorNegocio: number;
  }>;
  contatos: Array<{
    id: string;
    nome: string;
    telefone: string;
    empresa: string;
    conversaId: string | null;
  }>;
  notas: Array<{
    id: string;
    conversaId: string;
    texto: string;
    contatoNome: string;
  }>;
}

const ATALHOS_RAPIDOS = [
  { rotulo: 'Inbox · Conversas', rota: '/inbox' },
  { rotulo: 'CRM · Agenda de Contatos', rota: '/inbox?aba=contatos' },
  { rotulo: 'CRM · Quadro Kanban', rota: '/inbox?aba=kanban' },
  { rotulo: 'Visão geral', rota: '/visao-geral' },
  { rotulo: 'Instâncias (Chips)', rota: '/instancias' },
];

export function BuscaGlobal() {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [termo, setTermo] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoBusca>({ conversas: [], contatos: [], notas: [] });
  const campoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const aoTecla = (evento: KeyboardEvent) => {
      if ((evento.ctrlKey || evento.metaKey) && evento.key.toLowerCase() === 'k') {
        evento.preventDefault();
        setAberto((atual) => !atual);
      }
    };
    window.addEventListener('keydown', aoTecla);
    return () => window.removeEventListener('keydown', aoTecla);
  }, []);

  useEffect(() => {
    if (!aberto) return;
    const t = window.setTimeout(() => campoRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [aberto]);

  useEffect(() => {
    if (!aberto) return;
    const limpo = termo.trim();
    if (!limpo) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCarregando(true);
      try {
        const res = await fetch(`/api/crm/busca?q=${encodeURIComponent(limpo)}`, { signal: controller.signal });
        if (!res.ok) return;
        const json = (await res.json()) as ResultadoBusca;
        setResultado(json);
      } catch {
        // abortado ou rede instável
      } finally {
        setCarregando(false);
      }
    }, 200);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [termo, aberto]);

  const irPara = (destino: string) => {
    setAberto(false);
    setTermo('');
    setResultado({ conversas: [], contatos: [], notas: [] });
    router.push(destino);
  };

  const aoDigitar = (valor: string) => {
    setTermo(valor);
    if (!valor.trim()) {
      setResultado({ conversas: [], contatos: [], notas: [] });
      setCarregando(false);
    }
  };

  const temResultados =
    resultado.conversas.length > 0 || resultado.contatos.length > 0 || resultado.notas.length > 0;

  return (
    <>
      <button
        type="button"
        className="busca-global-gatilho"
        onClick={() => setAberto(true)}
        title="Buscar conversas, contatos e notas (Ctrl+K)"
      >
        <Icone nome="busca" />
        <span className="busca-global-texto">Buscar...</span>
        <span className="so-leitor-de-tela">Buscar no CRM</span>
        <kbd className="busca-global-kbd">Ctrl+K</kbd>
      </button>

      {aberto ? (
        <Dialogo aoFechar={() => setAberto(false)} titulo="Busca rápida no CRM">
          <div className="busca-global-corpo">
          <label className="busca-global-campo">
            <Icone nome="busca" />
            <input
              ref={campoRef}
              type="search"
              value={termo}
              onChange={(e) => aoDigitar(e.target.value)}
              placeholder="Nome, WhatsApp, empresa, mensagem ou nota..."
              aria-label="Buscar no workspace"
            />
          </label>

          {!termo.trim() ? (
            <div className="busca-global-secao">
              <div className="busca-global-rotulo">Ir rápido para</div>
              <div className="busca-global-lista">
                {ATALHOS_RAPIDOS.map((item) => (
                  <button key={item.rota} type="button" className="busca-global-item" onClick={() => irPara(item.rota)}>
                    <span className="busca-global-item-titulo">{item.rotulo}</span>
                    <span className="busca-global-item-meta">{item.rota}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : carregando && !temResultados ? (
            <p className="busca-global-vazio">Procurando…</p>
          ) : !temResultados ? (
            <p className="busca-global-vazio">Nada encontrado para “{termo.trim()}”.</p>
          ) : (
            <div className="busca-global-resultados">
              {resultado.conversas.length > 0 && (
                <div className="busca-global-secao">
                  <div className="busca-global-rotulo">Conversas</div>
                  <div className="busca-global-lista">
                    {resultado.conversas.map((conv) => (
                      <button key={conv.id} type="button" className="busca-global-item" onClick={() => irPara(`/inbox?c=${conv.id}`)}>
                        <div>
                          <div className="busca-global-item-titulo">{conv.nome}</div>
                          <div className="busca-global-item-sub">{conv.previa || conv.telefone}</div>
                        </div>
                        <div className="busca-global-item-meta">
                          <span>{descreverEtapaCrm(conv.etapaCrm).texto}</span>
                          {conv.valorNegocio > 0 && <strong>{formatarReais(conv.valorNegocio)}</strong>}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {resultado.contatos.length > 0 && (
                <div className="busca-global-secao">
                  <div className="busca-global-rotulo">Contatos</div>
                  <div className="busca-global-lista">
                    {resultado.contatos.map((cont) => (
                      <button
                        key={cont.id}
                        type="button"
                        className="busca-global-item"
                        onClick={() =>
                          irPara(cont.conversaId ? `/inbox?c=${cont.conversaId}` : `/inbox?aba=contatos&busca=${encodeURIComponent(cont.nome)}`)
                        }
                      >
                        <div>
                          <div className="busca-global-item-titulo">{cont.nome}</div>
                          <div className="busca-global-item-sub">{[cont.empresa, cont.telefone].filter(Boolean).join(' · ')}</div>
                        </div>
                        <span className="busca-global-item-meta">{cont.conversaId ? 'Abrir conversa' : 'Ver contato'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {resultado.notas.length > 0 && (
                <div className="busca-global-secao">
                  <div className="busca-global-rotulo">Notas internas</div>
                  <div className="busca-global-lista">
                    {resultado.notas.map((nota) => (
                      <button key={nota.id} type="button" className="busca-global-item" onClick={() => irPara(`/inbox?c=${nota.conversaId}`)}>
                        <div>
                          <div className="busca-global-item-titulo">{nota.contatoNome}</div>
                          <div className="busca-global-item-sub">{nota.texto}</div>
                        </div>
                        <span className="busca-global-item-meta">Nota</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        </Dialogo>
      ) : null}
    </>
  );
}
