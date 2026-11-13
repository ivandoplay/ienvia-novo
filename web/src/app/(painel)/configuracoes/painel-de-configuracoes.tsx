'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { MARCA_PADRAO, type PoliticaDeDados } from '@ienvia/shared/contas';
import { selecionarWorkspaceAtivo } from '@/app/acoes-de-sessao';
import type { DadosDeConfiguracoes } from '@/lib/dados/configuracoes';
import type { Papel, WorkspaceDaSessao } from '@/lib/sessao';
import { alterarMinhaSenha, salvarMarcaEPerfil, salvarNomePessoal, salvarPoliticaDeDados } from './acoes';

interface Props {
  dados: DadosDeConfiguracoes;
  papel: Papel;
  loginUsuario: string;
  workspaces: WorkspaceDaSessao[];
  emModoSuporte: boolean;
}

export function PainelDeConfiguracoes({ dados, papel, loginUsuario, workspaces, emModoSuporte }: Props) {
  const router = useRouter();
  const ehDono = papel === 'owner';

  // --- Marca e perfil ---
  const [nomeWorkspace, setNomeWorkspace] = useState(dados.workspace.name);
  const [nomeDaMarca, setNomeDaMarca] = useState(dados.workspace.brandName || MARCA_PADRAO.nomeDaMarca);
  const [subtituloDaMarca, setSubtituloDaMarca] = useState(dados.workspace.brandSubtitle);
  const [nomeDoUsuario, setNomeDoUsuario] = useState(dados.perfil.displayName || loginUsuario);
  const [salvandoMarca, setSalvandoMarca] = useState(false);
  const [avisoMarca, setAvisoMarca] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  // --- Senha ---
  const [senhaAtual, setSenhaAtual] = useState('');
  const [novaSenha, setNovaSenha] = useState('');
  const [confirmarSenha, setConfirmarSenha] = useState('');
  const [salvandoSenha, setSalvandoSenha] = useState(false);
  const [avisoSenha, setAvisoSenha] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  // --- Política LGPD ---
  const [politica, setPolitica] = useState<PoliticaDeDados>(dados.politicaDeDados);
  const [salvandoPolitica, setSalvandoPolitica] = useState(false);
  const [avisoPolitica, setAvisoPolitica] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  // --- Exportação ---
  const [exportando, setExportando] = useState(false);
  const [avisoExportar, setAvisoExportar] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  // --- Troca de workspace ---
  const [trocandoWs, setTrocandoWs] = useState<string | null>(null);

  async function aoSalvarMarca(evento: FormEvent) {
    evento.preventDefault();
    setSalvandoMarca(true);
    setAvisoMarca(null);

    const res = ehDono
      ? await salvarMarcaEPerfil({ nomeWorkspace, nomeDaMarca, subtituloDaMarca, nomeDoUsuario })
      : await salvarNomePessoal(nomeDoUsuario);

    setSalvandoMarca(false);
    if (!res.ok) {
      setAvisoMarca({ tipo: 'erro', texto: res.erro });
      return;
    }
    setAvisoMarca({ tipo: 'ok', texto: res.mensagem });
    router.refresh();
  }

  async function aoAlterarSenha(evento: FormEvent) {
    evento.preventDefault();
    setSalvandoSenha(true);
    setAvisoSenha(null);
    const res = await alterarMinhaSenha({ senhaAtual, novaSenha, confirmarSenha });
    setSalvandoSenha(false);
    if (!res.ok) {
      setAvisoSenha({ tipo: 'erro', texto: res.erro });
      return;
    }
    setSenhaAtual('');
    setNovaSenha('');
    setConfirmarSenha('');
    setAvisoSenha({ tipo: 'ok', texto: res.mensagem });
  }

  async function aoSalvarPolitica(evento: FormEvent) {
    evento.preventDefault();
    setSalvandoPolitica(true);
    setAvisoPolitica(null);
    const res = await salvarPoliticaDeDados(politica);
    setSalvandoPolitica(false);
    if (!res.ok) {
      setAvisoPolitica({ tipo: 'erro', texto: res.erro });
      return;
    }
    setPolitica(res.dados);
    setAvisoPolitica({ tipo: 'ok', texto: res.mensagem });
  }

  async function aoExportar() {
    setExportando(true);
    setAvisoExportar(null);
    try {
      const resp = await fetch('/api/configuracoes/exportar', { method: 'GET', cache: 'no-store' });
      if (!resp.ok) {
        const corpo = (await resp.json().catch(() => null)) as { erro?: string } | null;
        setAvisoExportar({ tipo: 'erro', texto: corpo?.erro ?? 'Não foi possível exportar os dados agora.' });
        return;
      }
      const blob = await resp.blob();
      const disp = resp.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disp);
      const nomeArquivo = match?.[1] ?? `ienvia-dados-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nomeArquivo;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setAvisoExportar({ tipo: 'ok', texto: `Arquivo ${nomeArquivo} baixado com os seus dados.` });
    } catch {
      setAvisoExportar({ tipo: 'erro', texto: 'Erro de rede ao baixar a cópia dos dados.' });
    } finally {
      setExportando(false);
    }
  }

  async function trocarWorkspace(id: string) {
    setTrocandoWs(id);
    const res = await selecionarWorkspaceAtivo(id);
    setTrocandoWs(null);
    if (res.ok) router.refresh();
  }

  return (
    <div className="f7-grid">
      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">{ehDono ? 'Marca e nome do sistema' : 'Seu perfil'}</h2>
        </div>
        <p className="panel-desc">
          {ehDono
            ? 'Personalize o nome da empresa e a marca exibida no topo do menu lateral. As mudanças aparecem imediatamente no painel.'
            : 'Atualize como seu nome aparece no topo e nas anotações internas. A marca e o nome da empresa ficam com o proprietário.'}
        </p>

        {avisoMarca ? (
          <div className={avisoMarca.tipo === 'ok' ? 'f7-alert f7-alert--ok' : 'f7-alert f7-alert--erro'} role="status">
            {avisoMarca.texto}
          </div>
        ) : null}

        <form onSubmit={aoSalvarMarca}>
          <div className="f7-form-grid">
            {ehDono ? (
              <>
                <div className="form-group f7-span-2">
                  <label className="form-label" htmlFor="cfg-ws-nome">
                    Nome da empresa (workspace)
                  </label>
                  <input
                    id="cfg-ws-nome"
                    className="f7-input"
                    value={nomeWorkspace}
                    onChange={(e) => setNomeWorkspace(e.target.value)}
                    minLength={2}
                    maxLength={120}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cfg-brand-nome">
                    Nome da marca no topo
                  </label>
                  <input
                    id="cfg-brand-nome"
                    className="f7-input"
                    value={nomeDaMarca}
                    onChange={(e) => setNomeDaMarca(e.target.value)}
                    minLength={2}
                    maxLength={40}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cfg-brand-sub">
                    Subtítulo da marca
                  </label>
                  <input
                    id="cfg-brand-sub"
                    className="f7-input"
                    value={subtituloDaMarca}
                    onChange={(e) => setSubtituloDaMarca(e.target.value)}
                    maxLength={60}
                    placeholder="Opcional (ex.: Atendimento VIP)"
                  />
                </div>
              </>
            ) : null}

            <div className="form-group f7-span-2">
              <label className="form-label" htmlFor="cfg-usuario-nome">
                Seu nome de exibição
              </label>
              <input
                id="cfg-usuario-nome"
                className="f7-input"
                value={nomeDoUsuario}
                onChange={(e) => setNomeDoUsuario(e.target.value)}
                minLength={1}
                maxLength={80}
                required
              />
              <div className="f7-hint">Login de acesso: {loginUsuario}</div>
            </div>
          </div>

          {ehDono ? (
            <div className="f7-brand-preview" aria-label="Prévia da marca no menu">
              <span className="f7-brand-preview-mark" aria-hidden="true">
                {(nomeDaMarca.trim() || 'I')[0]?.toUpperCase()}
              </span>
              <div>
                <div className="brand-title">{nomeDaMarca.trim() || MARCA_PADRAO.nomeDaMarca}</div>
                {subtituloDaMarca.trim() ? <div className="brand-sub">{subtituloDaMarca.trim()}</div> : null}
              </div>
            </div>
          ) : null}

          <div className="f7-actions">
            <button type="submit" className="btn btn-primary" disabled={salvandoMarca}>
              {salvandoMarca ? 'Salvando...' : ehDono ? 'Salvar marca e perfil' : 'Salvar perfil'}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Trocar senha de acesso</h2>
        </div>
        <p className="panel-desc">
          Altera a senha da conta conectada agora ({loginUsuario}). Use pelo menos 8 caracteres.
        </p>

        {avisoSenha ? (
          <div className={avisoSenha.tipo === 'ok' ? 'f7-alert f7-alert--ok' : 'f7-alert f7-alert--erro'} role="status">
            {avisoSenha.texto}
          </div>
        ) : null}

        <form onSubmit={aoAlterarSenha}>
          <div className="form-group">
            <label className="form-label" htmlFor="cfg-senha-atual">
              Senha atual
            </label>
            <input
              id="cfg-senha-atual"
              type="password"
              className="f7-input"
              autoComplete="current-password"
              value={senhaAtual}
              onChange={(e) => setSenhaAtual(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="cfg-nova-senha">
              Nova senha
            </label>
            <input
              id="cfg-nova-senha"
              type="password"
              className="f7-input"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              value={novaSenha}
              onChange={(e) => setNovaSenha(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="cfg-confirmar-senha">
              Confirmar nova senha
            </label>
            <input
              id="cfg-confirmar-senha"
              type="password"
              className="f7-input"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              value={confirmarSenha}
              onChange={(e) => setConfirmarSenha(e.target.value)}
              required
            />
          </div>
          <div className="f7-actions">
            <button type="submit" className="btn btn-primary" disabled={salvandoSenha}>
              {salvandoSenha ? 'Alterando...' : 'Atualizar senha'}
            </button>
          </div>
        </form>
      </section>

      {ehDono ? (
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Exportar meus dados</h2>
          </div>
          <p className="panel-desc">
            Gera um arquivo JSON limpo com todos os dados desta empresa: catálogo, chave PIX, áudios, bases de
            treinamento, contatos, funis/etiquetas do CRM, conversas e até as 5.000 mensagens mais recentes.
          </p>
          <p className="f7-hint">
            Por segurança, senhas, tokens de conexão e chaves de API cifradas nunca entram na exportação.
          </p>

          {avisoExportar ? (
            <div
              className={avisoExportar.tipo === 'ok' ? 'f7-alert f7-alert--ok' : 'f7-alert f7-alert--erro'}
              role="status"
            >
              {avisoExportar.texto}
            </div>
          ) : null}

          <div className="f7-meta-row">
            <span className="f7-stat-chip">
              Limite contratado: <strong>{dados.workspace.maxInstances}</strong> chips
            </span>
          </div>

          <div className="f7-actions">
            <button type="button" className="btn btn-secondary" disabled={exportando} onClick={aoExportar}>
              {exportando ? 'Gerando JSON...' : 'Baixar cópia em JSON'}
            </button>
          </div>
        </section>
      ) : null}

      {ehDono ? (
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Guarda e limpeza automática (LGPD)</h2>
          </div>
          <p className="panel-desc">
            Defina por quantos dias o sistema guarda mensagens e arquivos de conversas antes da limpeza automática.
            Itens do Catálogo e Áudios Estratégicos não expiram.
          </p>

          <div className="f7-meta-row">
            <span className="f7-stat-chip">
              Na fila de limpeza: <strong>{dados.retencao.expiradosPendentes}</strong>
            </span>
            <span className="f7-stat-chip">
              Arquivos já removidos: <strong>{dados.retencao.jaExcluidos}</strong>
            </span>
          </div>

          {avisoPolitica ? (
            <div
              className={avisoPolitica.tipo === 'ok' ? 'f7-alert f7-alert--ok' : 'f7-alert f7-alert--erro'}
              role="status"
            >
              {avisoPolitica.texto}
            </div>
          ) : null}

          <form onSubmit={aoSalvarPolitica}>
            <div className="f7-form-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="cfg-ret-msg">
                  Guarda de mensagens (dias)
                </label>
                <input
                  id="cfg-ret-msg"
                  type="number"
                  className="f7-input"
                  min={1}
                  max={3650}
                  value={politica.messageRetentionDays}
                  onChange={(e) =>
                    setPolitica((p) => ({ ...p, messageRetentionDays: Number(e.target.value) || 0 }))
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cfg-ret-midia">
                  Guarda de mídias da Inbox (dias)
                </label>
                <input
                  id="cfg-ret-midia"
                  type="number"
                  className="f7-input"
                  min={1}
                  max={3650}
                  value={politica.mediaRetentionDays}
                  onChange={(e) =>
                    setPolitica((p) => ({ ...p, mediaRetentionDays: Number(e.target.value) || 0 }))
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cfg-ret-rec">
                  Janela de recuperação (dias)
                </label>
                <input
                  id="cfg-ret-rec"
                  type="number"
                  className="f7-input"
                  min={1}
                  max={180}
                  value={politica.recoveryWindowDays}
                  onChange={(e) =>
                    setPolitica((p) => ({ ...p, recoveryWindowDays: Number(e.target.value) || 0 }))
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cfg-ret-sla">
                  Prazo exclusão LGPD (dias)
                </label>
                <input
                  id="cfg-ret-sla"
                  type="number"
                  className="f7-input"
                  min={1}
                  max={90}
                  value={politica.activeDataPurgeSlaDays}
                  onChange={(e) =>
                    setPolitica((p) => ({ ...p, activeDataPurgeSlaDays: Number(e.target.value) || 0 }))
                  }
                  required
                />
              </div>
            </div>

            <div className="f7-actions">
              <button type="submit" className="btn btn-primary" disabled={salvandoPolitica}>
                {salvandoPolitica ? 'Salvando...' : 'Salvar política de guarda'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {!emModoSuporte && workspaces.length > 1 ? (
        <section className="panel f7-span-2">
          <div className="panel-header">
            <h2 className="panel-title">Trocar de workspace</h2>
          </div>
          <p className="panel-desc">Sua conta participa de mais de uma empresa. Escolha qual painel abrir agora.</p>
          <div className="ws-troca-lista">
            {workspaces.map((ws) => {
              const atual = ws.id === dados.workspace.id;
              return (
                <div key={ws.id} className="ws-troca-item">
                  <div>
                    <strong>{ws.nome}</strong>
                    <div className="f7-hint">{ws.papel === 'owner' ? 'Proprietário' : 'Atendente'}</div>
                  </div>
                  <button
                    type="button"
                    className={atual ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
                    disabled={atual || trocandoWs !== null}
                    onClick={() => trocarWorkspace(ws.id)}
                  >
                    {atual ? 'Ativo agora' : trocandoWs === ws.id ? 'Abrindo...' : 'Abrir workspace'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
