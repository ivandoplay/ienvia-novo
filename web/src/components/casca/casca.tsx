'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icone } from '@/components/ui/icone';
import { ATALHOS_CELULAR, buscarItemPorRota, rotaEstaAtiva, type GrupoMenu, type ItemMenu } from '@/lib/navegacao';
import type { ResumoDaIa } from '@/lib/atendente/painel';
import { BuscaGlobal } from './busca-global';
import { ControleDaIa } from './controle-da-ia';
import { MenuDaConta } from './menu-da-conta';

export interface PropsDaCasca {
  menu: GrupoMenu[];
  usuario: {
    /** Nome para exibir (ou o login, quando o perfil não tem nome). */
    nome: string;
    /** O que a pessoa digita para entrar. */
    login: string;
    /** Rótulo curto do topo: "@joao". */
    apelido: string;
    iniciais: string;
    papel: string;
  };
  workspace: string;
  conexao: { texto: string; conectado: boolean };
  /** Como está a IA da empresa (para o botão "Pausar tudo"). `null` quando não deu para ler. */
  ia: ResumoDaIa | null;
  children: ReactNode;
}

const CONSULTA_CELULAR = '(max-width: 900px)';

/** `true` quando a tela é estreita o bastante para o menu virar gaveta. */
function useTelaDeCelular(): boolean {
  return useSyncExternalStore(
    (avisar) => {
      const consulta = window.matchMedia(CONSULTA_CELULAR);
      consulta.addEventListener('change', avisar);
      return () => consulta.removeEventListener('change', avisar);
    },
    () => window.matchMedia(CONSULTA_CELULAR).matches,
    () => false,
  );
}

/**
 * A moldura do painel: menu lateral, barra do topo, conteúdo e navegação do celular.
 * Tudo que é comum a todas as abas mora aqui; cada aba só entrega o seu miolo (`children`).
 */
export function Casca({ menu, usuario, workspace, conexao, ia, children }: PropsDaCasca) {
  const caminho = usePathname();
  const ehCelular = useTelaDeCelular();
  const [gavetaAberta, setGavetaAberta] = useState(false);
  const [contaAberta, setContaAberta] = useState(false);
  const botaoDoMenu = useRef<HTMLButtonElement>(null);
  const menuLateral = useRef<HTMLElement>(null);
  /** Marcado quando a gaveta foi fechada pelo teclado: o foco deve voltar ao botão que a abriu. */
  const devolverFoco = useRef(false);

  const fecharGaveta = useCallback(() => setGavetaAberta(false), []);

  useEffect(() => {
    if (!gavetaAberta) {
      if (devolverFoco.current) {
        devolverFoco.current = false;
        botaoDoMenu.current?.focus();
      }
      return;
    }

    // Ao abrir, o foco entra na gaveta; a tecla Esc fecha.
    menuLateral.current?.querySelector<HTMLElement>('a, summary, button')?.focus();
    const aoApertarTecla = (evento: KeyboardEvent) => {
      if (evento.key !== 'Escape') return;
      devolverFoco.current = true;
      setGavetaAberta(false);
    };
    document.addEventListener('keydown', aoApertarTecla);
    return () => document.removeEventListener('keydown', aoApertarTecla);
  }, [gavetaAberta]);

  const tituloNoCelular = caminho === '/visao-geral' ? 'Início' : (buscarItemPorRota(caminho)?.rotulo ?? 'Ienvia');
  const gavetaVisivel = ehCelular && gavetaAberta;

  return (
    <div className="casca">
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo principal
      </a>

      <aside
        id="menu-principal"
        ref={menuLateral}
        className={gavetaVisivel ? 'sidebar drawer-open' : 'sidebar'}
        aria-label="Menu principal"
        // No celular, com a gaveta fechada, o menu fica fora da tela e fora do alcance do teclado.
        inert={ehCelular && !gavetaAberta}
      >
        <div className="brand">
          <div className="brand-left">
            <div className="brand-mark" aria-hidden="true">
              <Image src="/ienvia-icone.png" alt="" width={32} height={32} priority />
            </div>
            <div className="brand-textos">
              <div className="brand-title">Ienvia</div>
              <div className="brand-sub">Atendente Universal</div>
            </div>
          </div>
        </div>

        <nav className="nav-menu" aria-label="Seções do painel">
          {menu.map((grupo) => (
            <GrupoDoMenu key={grupo.rotulo} grupo={grupo} caminho={caminho} aoNavegar={fecharGaveta} />
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="active-profile-box">
            <div className="active-profile-label">Workspace ativo</div>
            <div className="active-profile-name">{workspace}</div>
          </div>
        </div>
      </aside>

      <div
        className={gavetaVisivel ? 'sidebar-drawer-backdrop visible' : 'sidebar-drawer-backdrop'}
        aria-hidden="true"
        onClick={fecharGaveta}
      />

      {/* Com a gaveta aberta, o que está atrás dela fica fora do alcance do toque e do teclado. */}
      <div className="main-wrapper" inert={gavetaVisivel}>
        <header className="topbar">
          <div className="topbar-left">
            <button
              ref={botaoDoMenu}
              type="button"
              className="sidebar-toggle-btn"
              aria-label="Abrir menu de navegação"
              aria-controls="menu-principal"
              aria-expanded={gavetaVisivel}
              onClick={() => setGavetaAberta(true)}
            >
              <Icone nome="menu" />
            </button>

            <div className="mob-topbar-brand">
              <div className="brand-mark brand-mark--pequena" aria-hidden="true">
                <Image src="/ienvia-icone.png" alt="" width={28} height={28} />
              </div>
              <span className="mob-topbar-title">{tituloNoCelular}</span>
            </div>

            <div
              className={conexao.conectado ? 'status-pill connected' : 'status-pill'}
              title="Situação da conexão com o WhatsApp"
            >
              <span className="status-dot" />
              <span>{conexao.texto}</span>
            </div>
          </div>

          <div className="topbar-right">
            <BuscaGlobal />
            <ControleDaIa ia={ia} />
            <button
              type="button"
              className="account-trigger-btn"
              aria-haspopup="dialog"
              aria-expanded={contaAberta}
              onClick={() => setContaAberta(true)}
            >
              <span className="account-avatar-dot" aria-hidden="true">
                {usuario.iniciais}
              </span>
              <span className="so-leitor-de-tela">Conta e preferências</span>
              <span className="account-trigger-label">{usuario.apelido}</span>
              <Icone nome="seta" className="account-trigger-label account-seta" />
            </button>
          </div>
        </header>

        <main id="conteudo" className="content-area" tabIndex={-1}>
          <div className="pagina">{children}</div>
        </main>
      </div>

      <nav className="mobile-bottom-nav" aria-label="Navegação principal no celular" inert={gavetaVisivel}>
        {ATALHOS_CELULAR.map((atalho) => {
          const ativo = atalho.rotasDoGrupo.some((rota) => rotaEstaAtiva(rota, caminho));
          return (
            <Link
              key={atalho.rota}
              href={atalho.rota}
              className={ativo ? 'mob-nav-btn active' : 'mob-nav-btn'}
              aria-current={ativo ? 'page' : undefined}
            >
              <Icone nome={atalho.icone} />
              <span>{atalho.rotulo}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className="mob-nav-btn"
          aria-controls="menu-principal"
          aria-expanded={gavetaVisivel}
          onClick={() => setGavetaAberta(true)}
        >
          <Icone nome="mais" />
          <span>Mais</span>
          <span className="so-leitor-de-tela">: todas as abas do painel</span>
        </button>
      </nav>

      <MenuDaConta
        aberto={contaAberta}
        aoFechar={() => setContaAberta(false)}
        usuario={usuario}
        workspace={workspace}
      />
    </div>
  );
}

function GrupoDoMenu({ grupo, caminho, aoNavegar }: { grupo: GrupoMenu; caminho: string; aoNavegar: () => void }) {
  return (
    <>
      <div className="nav-group-label">{grupo.rotulo}</div>

      {grupo.itens.map((item) => (
        <LinkDoMenu key={item.rota} item={item} caminho={caminho} aoNavegar={aoNavegar} />
      ))}

      {grupo.secoes.map((secao) => (
        <details key={secao.id} className="nav-section" open>
          <summary className="nav-section-toggle">
            <span className="nav-section-toggle-left">
              <Icone nome={secao.icone} />
              <span>{secao.rotulo}</span>
            </span>
            <Icone nome="seta" className="nav-section-chevron" />
          </summary>
          <div className="nav-section-items">
            {secao.itens.map((item) => (
              <LinkDoMenu key={item.rota} item={item} caminho={caminho} aoNavegar={aoNavegar} />
            ))}
          </div>
        </details>
      ))}
    </>
  );
}

function LinkDoMenu({ item, caminho, aoNavegar }: { item: ItemMenu; caminho: string; aoNavegar: () => void }) {
  const ativo = rotaEstaAtiva(item.rota, caminho);
  return (
    <Link
      href={item.rota}
      className={ativo ? 'nav-btn active' : 'nav-btn'}
      aria-current={ativo ? 'page' : undefined}
      title={item.descricao}
      onClick={aoNavegar}
    >
      <span className="nav-btn-left">
        <Icone nome={item.icone} />
        <span>{item.rotulo}</span>
      </span>
    </Link>
  );
}
