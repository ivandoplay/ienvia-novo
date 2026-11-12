'use client';

import { useRef, useState } from 'react';
import { CampoDeTexto } from '@/components/ui/campo-de-texto';
import { Dialogo } from '@/components/ui/dialogo';
import {
  LIMITES_DO_ESTUDIO,
  dobrarPt,
  exportarTreinamentoZip,
  gerarProximoCodigo,
  importarPacoteDoTreinamento,
  type CerebroCompleto,
  type DadosDoEstudio,
  type MensagemAprovada,
  type ModoDeContextoDoCerebro,
  type ObjecaoDeAtendimento,
  type ResultadoDaImportacao,
  type SkillDeHumanizacao,
  type SkillOperacional,
} from '@/lib/ia/estudio';
import type { CamposDaBase } from '@/lib/ia/treinamento';

type AbaDoEstudio = 'mensagens' | 'skills' | 'cerebro';
type SubAbaDeSkills = 'operacionais' | 'humanizacao' | 'objecoes';

interface Props {
  aba: 'identidade' | 'regras' | 'perguntas' | 'mensagens' | 'skills' | 'cerebro' | 'arquivos';
  rascunho: CamposDaBase;
  podeEditar: boolean;
  ocupado: boolean;
  arquivosCount: number;
  mudar: (mudancas: Partial<CamposDaBase>) => void;
  aoExtrairDosArquivos: () => Promise<ResultadoDaImportacao | null>;
  aoAvisar: (aviso: { tipo: 'ok' | 'erro' | 'atencao'; texto: string }) => void;
}

const cerebroBase = (atual: CerebroCompleto | null): CerebroCompleto =>
  atual ?? {
    id: 'cerebro-principal',
    nome: 'Cérebro completo',
    versao: '1.0',
    importadoEm: null,
    modoDeContexto: 'inteligente',
    playbookCentral: '',
    regrasCanonicas: '',
    fatosDoNegocio: {},
    filtrosDeVoz: [],
    personas: [],
    paresBomRuim: [],
    respostasDeReferencia: [],
  };

function mesclarPorId<T extends { id: string }>(atuais: readonly T[], novos: readonly T[]): T[] {
  const mapa = new Map<string, T>();
  for (const item of atuais) mapa.set(item.id.toUpperCase(), item);
  for (const item of novos) {
    const k = item.id.toUpperCase();
    if (!mapa.has(k)) mapa.set(k, item);
  }
  return Array.from(mapa.values());
}

export function AbasDoEstudio({
  aba,
  rascunho,
  podeEditar,
  ocupado,
  arquivosCount,
  mudar,
  aoExtrairDosArquivos,
  aoAvisar,
}: Props) {
  const [subSkill, setSubSkill] = useState<SubAbaDeSkills>('operacionais');
  const [buscaMsg, setBuscaMsg] = useState('');
  const [buscaSkill, setBuscaSkill] = useState('');
  const [previa, setPrevia] = useState<ResultadoDaImportacao | null>(null);
  const [aplicarIdentidade, setAplicarIdentidade] = useState(true);
  const [erroImport, setErroImport] = useState<string | null>(null);
  const [lendoArquivo, setLendoArquivo] = useState(false);
  const inputPacote = useRef<HTMLInputElement>(null);

  const estudio = rascunho.estudio;
  const mudarEstudio = (patch: Partial<DadosDoEstudio>) => mudar({ estudio: { ...estudio, ...patch } });
  const atualizarCerebro = (patch: Partial<CerebroCompleto>) =>
    mudarEstudio({ cerebroCompleto: { ...cerebroBase(estudio.cerebroCompleto), ...patch } });

  async function escolherPacote(arquivo: File | undefined) {
    if (!arquivo) return;
    setErroImport(null);
    if (arquivo.size > LIMITES_DO_ESTUDIO.arquivoZipBytes) {
      setErroImport('O arquivo ultrapassa o limite de 4 MB.');
      if (inputPacote.current) inputPacote.current.value = '';
      return;
    }
    setLendoArquivo(true);
    try {
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      const res = await importarPacoteDoTreinamento(bytes, arquivo.name);
      setPrevia(res);
      setAplicarIdentidade(Object.keys(res.sugestaoIdentidade).length > 0);
    } catch (erro) {
      setErroImport(erro instanceof Error ? erro.message : 'Não foi possível ler este pacote.');
    } finally {
      setLendoArquivo(false);
      if (inputPacote.current) inputPacote.current.value = '';
    }
  }

  function aplicarPrevia(modo: 'substituir' | 'mesclar') {
    if (!previa) return;
    const novoEstudio: DadosDoEstudio =
      modo === 'substituir'
        ? previa.estudio
        : {
            mensagensAprovadas: mesclarPorId(estudio.mensagensAprovadas, previa.estudio.mensagensAprovadas).slice(
              0,
              LIMITES_DO_ESTUDIO.mensagensAprovadas,
            ),
            habilidadesOperacionais: mesclarPorId(estudio.habilidadesOperacionais, previa.estudio.habilidadesOperacionais).slice(
              0,
              LIMITES_DO_ESTUDIO.habilidadesOperacionais,
            ),
            habilidadesDeHumanizacao: mesclarPorId(estudio.habilidadesDeHumanizacao, previa.estudio.habilidadesDeHumanizacao).slice(
              0,
              LIMITES_DO_ESTUDIO.habilidadesDeHumanizacao,
            ),
            objecoes: mesclarPorId(estudio.objecoes, previa.estudio.objecoes).slice(0, LIMITES_DO_ESTUDIO.objecoes),
            cerebroCompleto: previa.estudio.cerebroCompleto ?? estudio.cerebroCompleto,
          };

    const sug = aplicarIdentidade ? previa.sugestaoIdentidade : {};
    mudar({
      ...(sug.nomeDoNegocio ? { nomeDoNegocio: sug.nomeDoNegocio } : {}),
      ...(sug.nicho ? { nicho: sug.nicho } : {}),
      ...(sug.nomeDoAtendente ? { nomeDoAtendente: sug.nomeDoAtendente } : {}),
      ...(typeof sug.primeiraPessoa === 'boolean' ? { primeiraPessoa: sug.primeiraPessoa } : {}),
      ...(sug.resumo ? { resumo: sug.resumo } : {}),
      ...(sug.condicoes ? { condicoes: sug.condicoes } : {}),
      ...(sug.regras ? { regras: sug.regras } : {}),
      ...(sug.instrucoesExtras ? { instrucoesExtras: sug.instrucoesExtras } : {}),
      ...(sug.gatilhosDeRepasse ? { gatilhosDeRepasse: sug.gatilhosDeRepasse } : {}),
      ...(sug.perguntas && sug.perguntas.length > 0
        ? {
            perguntas:
              modo === 'substituir'
                ? sug.perguntas
                : [...rascunho.perguntas, ...sug.perguntas].slice(0, 100),
          }
        : {}),
      estudio: novoEstudio,
    });

    setPrevia(null);
    aoAvisar({
      tipo: 'atencao',
      texto: `Pacote "${previa.resumo.origem}" carregado na tela (${previa.resumo.mensagens} mensagens, ${previa.resumo.skillsOperacionais} skills operacionais, ${previa.resumo.skillsHumanizacao} de humanização e ${previa.resumo.objecoes} objeções). Confira e clique em "Salvar treinamento".`,
    });
  }

  function baixarBackupZip() {
    try {
      const zip = exportarTreinamentoZip(rascunho);
      const buffer = new Uint8Array(zip.byteLength);
      buffer.set(zip);
      const blob = new Blob([buffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const slug = (rascunho.rotulo || 'principal').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      a.href = url;
      a.download = `ienvia-treinamento-${slug || 'base'}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      aoAvisar({ tipo: 'ok', texto: 'Backup .zip baixado para o seu computador.' });
    } catch (erro) {
      aoAvisar({ tipo: 'erro', texto: erro instanceof Error ? erro.message : 'Não foi possível gerar o backup.' });
    }
  }

  async function extrairDeArquivos() {
    setErroImport(null);
    const resultado = await aoExtrairDosArquivos();
    if (resultado) {
      setPrevia(resultado);
      setAplicarIdentidade(false);
    }
  }

  const filtroMsg = dobrarPt(buscaMsg.trim());
  const mensagensFiltradas = estudio.mensagensAprovadas
    .map((m, idx) => ({ m, idx }))
    .filter(
      ({ m }) =>
        !filtroMsg ||
        dobrarPt(`${m.id} ${m.titulo} ${m.categoria} ${m.texto}`).includes(filtroMsg),
    );

  const filtroSkill = dobrarPt(buscaSkill.trim());
  const opsFiltradas = estudio.habilidadesOperacionais
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !filtroSkill || dobrarPt(`${s.id} ${s.nome} ${s.quando} ${s.exemploDeResposta}`).includes(filtroSkill));
  const humsFiltradas = estudio.habilidadesDeHumanizacao
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => !filtroSkill || dobrarPt(`${h.id} ${h.nome} ${h.gatilho} ${h.objetivo}`).includes(filtroSkill));
  const objsFiltradas = estudio.objecoes
    .map((o, idx) => ({ o, idx }))
    .filter(({ o }) => !filtroSkill || dobrarPt(`${o.id} ${o.padraoDeEntrada} ${o.natureza} ${o.skillId} ${o.estrategiaDeResposta}`).includes(filtroSkill));

  const cerebro = estudio.cerebroCompleto;
  const modoContexto: ModoDeContextoDoCerebro = cerebro?.modoDeContexto ?? 'inteligente';

  const visivel = (qual: AbaDoEstudio) => aba === qual;

  return (
    <>
      {/* ============================================================
          ABA: MENSAGENS PRONTAS (M01-M13+)
         ============================================================ */}
      <section
        className="panel"
        role="tabpanel"
        id="treino-painel-mensagens"
        aria-labelledby="treino-aba-mensagens"
        hidden={!visivel('mensagens')}
      >
        <h2 className="panel-title">Mensagens prontas (M01–M13+)</h2>
        <p className="panel-desc">
          Mensagens oficiais aprovadas para abertura, explicação do serviço, áudio, orçamento e fechamento. A IA usa estas mensagens como
          referência fiel de tom e conteúdo quando o contexto pede.
        </p>

        <div className="estudio-barra">
          <div className="form-group">
            <label className="form-label" htmlFor="estudio-busca-msg">
              Filtrar mensagens
            </label>
            <input
              id="estudio-busca-msg"
              className="campo"
              type="search"
              placeholder="Buscar por código (M01), título ou texto…"
              value={buscaMsg}
              onChange={(e) => setBuscaMsg(e.target.value)}
            />
          </div>
          {podeEditar && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={ocupado || estudio.mensagensAprovadas.length >= LIMITES_DO_ESTUDIO.mensagensAprovadas}
              onClick={() => {
                const novoId = gerarProximoCodigo(estudio.mensagensAprovadas, 'M', 2);
                const nova: MensagemAprovada = { id: novoId, titulo: `Nova mensagem ${novoId}`, categoria: 'Aprovada', texto: '', ativa: true };
                mudarEstudio({ mensagensAprovadas: [...estudio.mensagensAprovadas, nova] });
              }}
            >
              Adicionar mensagem pronta
            </button>
          )}
        </div>

        {mensagensFiltradas.length === 0 ? (
          <p className="treino-vazio">
            {estudio.mensagensAprovadas.length === 0
              ? 'Nenhuma mensagem pronta cadastrada. Adicione manualmente ou importe o Pacote Turbo.'
              : 'Nenhuma mensagem corresponde à busca.'}
          </p>
        ) : (
          <ol className="estudio-lista">
            {mensagensFiltradas.map(({ m, idx }) => (
              <li key={`${idx}-${m.id}`} className="estudio-card">
                <div className="estudio-card-topo">
                  <span className="estudio-codigo">{m.id}</span>
                  <label className="estudio-ativa">
                    <input
                      type="checkbox"
                      disabled={!podeEditar}
                      checked={m.ativa}
                      onChange={(e) =>
                        mudarEstudio({
                          mensagensAprovadas: estudio.mensagensAprovadas.map((x, i) => (i === idx ? { ...x, ativa: e.target.checked } : x)),
                        })
                      }
                    />
                    <span>Ativa</span>
                  </label>
                  {podeEditar && (
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() =>
                        mudarEstudio({
                          mensagensAprovadas: estudio.mensagensAprovadas.filter((_, i) => i !== idx),
                        })
                      }
                    >
                      Remover<span className="so-leitor-de-tela"> mensagem {m.id}</span>
                    </button>
                  )}
                </div>
                <div className="grade-de-campos">
                  <CampoDeTexto
                    rotulo={`Código (${m.id})`}
                    valor={m.id}
                    limite={LIMITES_DO_ESTUDIO.id}
                    desativado={!podeEditar}
                    aoMudar={(id) =>
                      mudarEstudio({
                        mensagensAprovadas: estudio.mensagensAprovadas.map((x, i) => (i === idx ? { ...x, id } : x)),
                      })
                    }
                  />
                  <CampoDeTexto
                    rotulo={`Título da ${m.id}`}
                    valor={m.titulo}
                    limite={LIMITES_DO_ESTUDIO.titulo}
                    desativado={!podeEditar}
                    aoMudar={(titulo) =>
                      mudarEstudio({
                        mensagensAprovadas: estudio.mensagensAprovadas.map((x, i) => (i === idx ? { ...x, titulo } : x)),
                      })
                    }
                  />
                  <CampoDeTexto
                    rotulo={`Categoria da ${m.id}`}
                    valor={m.categoria}
                    limite={LIMITES_DO_ESTUDIO.categoria}
                    desativado={!podeEditar}
                    aoMudar={(categoria) =>
                      mudarEstudio({
                        mensagensAprovadas: estudio.mensagensAprovadas.map((x, i) => (i === idx ? { ...x, categoria } : x)),
                      })
                    }
                  />
                </div>
                <CampoDeTexto
                  rotulo={`Texto da mensagem ${m.id}`}
                  valor={m.texto}
                  limite={LIMITES_DO_ESTUDIO.textoDaMensagem}
                  linhas={4}
                  desativado={!podeEditar}
                  aoMudar={(texto) =>
                    mudarEstudio({
                      mensagensAprovadas: estudio.mensagensAprovadas.map((x, i) => (i === idx ? { ...x, texto } : x)),
                    })
                  }
                />
              </li>
            ))}
          </ol>
        )}
        <p className="campo-dica">
          {estudio.mensagensAprovadas.length} de {LIMITES_DO_ESTUDIO.mensagensAprovadas} mensagens prontas.
        </p>
      </section>

      {/* ============================================================
          ABA: ESTÚDIO DE SKILLS (S01-S35, H01-H32, O001-O045)
         ============================================================ */}
      <section
        className="panel"
        role="tabpanel"
        id="treino-painel-skills"
        aria-labelledby="treino-aba-skills"
        hidden={!visivel('skills')}
      >
        <h2 className="panel-title">Estúdio de Skills e Objeções</h2>
        <p className="panel-desc">
          Skills operacionais (como conduzir cada etapa), skills de humanização (tom e naturalidade) e matriz de objeções (o que responder
          diante de desconfiança, preço, recusa ou dúvida).
        </p>

        <div className="estudio-subgrupos" role="group" aria-label="Categorias do Estúdio de Skills">
          <button
            type="button"
            className={subSkill === 'operacionais' ? 'subaba subaba--ativa' : 'subaba'}
            onClick={() => setSubSkill('operacionais')}
          >
            Operacionais ({estudio.habilidadesOperacionais.length})
          </button>
          <button
            type="button"
            className={subSkill === 'humanizacao' ? 'subaba subaba--ativa' : 'subaba'}
            onClick={() => setSubSkill('humanizacao')}
          >
            Humanização ({estudio.habilidadesDeHumanizacao.length})
          </button>
          <button
            type="button"
            className={subSkill === 'objecoes' ? 'subaba subaba--ativa' : 'subaba'}
            onClick={() => setSubSkill('objecoes')}
          >
            Objeções ({estudio.objecoes.length})
          </button>
        </div>

        <div className="estudio-barra">
          <div className="form-group">
            <label className="form-label" htmlFor="estudio-busca-skill">
              Filtrar neste grupo
            </label>
            <input
              id="estudio-busca-skill"
              className="campo"
              type="search"
              placeholder="Buscar por código (S01, H05, O001), nome ou gatilho…"
              value={buscaSkill}
              onChange={(e) => setBuscaSkill(e.target.value)}
            />
          </div>
          {podeEditar && subSkill === 'operacionais' && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={ocupado || estudio.habilidadesOperacionais.length >= LIMITES_DO_ESTUDIO.habilidadesOperacionais}
              onClick={() => {
                const id = gerarProximoCodigo(estudio.habilidadesOperacionais, 'S', 2);
                const nova: SkillOperacional = { id, nome: `Skill ${id}`, quando: '', exemploDeResposta: '', conteudoMd: '', ativa: true };
                mudarEstudio({ habilidadesOperacionais: [...estudio.habilidadesOperacionais, nova] });
              }}
            >
              Adicionar skill operacional
            </button>
          )}
          {podeEditar && subSkill === 'humanizacao' && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={ocupado || estudio.habilidadesDeHumanizacao.length >= LIMITES_DO_ESTUDIO.habilidadesDeHumanizacao}
              onClick={() => {
                const id = gerarProximoCodigo(estudio.habilidadesDeHumanizacao, 'H', 2);
                const nova: SkillDeHumanizacao = {
                  id,
                  nome: `Humanização ${id}`,
                  gatilho: '',
                  objetivo: '',
                  evitar: '',
                  respostaRuim: '',
                  respostaMelhor: '',
                  conteudoMd: '',
                  ativa: true,
                };
                mudarEstudio({ habilidadesDeHumanizacao: [...estudio.habilidadesDeHumanizacao, nova] });
              }}
            >
              Adicionar skill de humanização
            </button>
          )}
          {podeEditar && subSkill === 'objecoes' && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={ocupado || estudio.objecoes.length >= LIMITES_DO_ESTUDIO.objecoes}
              onClick={() => {
                const id = gerarProximoCodigo(estudio.objecoes, 'O', 3);
                const nova: ObjecaoDeAtendimento = {
                  id,
                  padraoDeEntrada: '',
                  natureza: '',
                  skillId: '',
                  estrategiaDeResposta: '',
                  evitar: '',
                  ativa: true,
                };
                mudarEstudio({ objecoes: [...estudio.objecoes, nova] });
              }}
            >
              Adicionar objeção
            </button>
          )}
        </div>

        {/* --- Subgrupo: Skills Operacionais --- */}
        {subSkill === 'operacionais' &&
          (opsFiltradas.length === 0 ? (
            <p className="treino-vazio">Nenhuma skill operacional encontrada.</p>
          ) : (
            <ol className="estudio-lista">
              {opsFiltradas.map(({ s, idx }) => (
                <li key={`${idx}-${s.id}`} className="estudio-card">
                  <div className="estudio-card-topo">
                    <span className="estudio-codigo">{s.id}</span>
                    <label className="estudio-ativa">
                      <input
                        type="checkbox"
                        disabled={!podeEditar}
                        checked={s.ativa}
                        onChange={(e) =>
                          mudarEstudio({
                            habilidadesOperacionais: estudio.habilidadesOperacionais.map((x, i) => (i === idx ? { ...x, ativa: e.target.checked } : x)),
                          })
                        }
                      />
                      <span>Ativa</span>
                    </label>
                    {podeEditar && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() =>
                          mudarEstudio({
                            habilidadesOperacionais: estudio.habilidadesOperacionais.filter((_, i) => i !== idx),
                          })
                        }
                      >
                        Remover<span className="so-leitor-de-tela"> skill {s.id}</span>
                      </button>
                    )}
                  </div>
                  <div className="grade-de-campos">
                    <CampoDeTexto
                      rotulo={`Código (${s.id})`}
                      valor={s.id}
                      limite={LIMITES_DO_ESTUDIO.id}
                      desativado={!podeEditar}
                      aoMudar={(id) =>
                        mudarEstudio({
                          habilidadesOperacionais: estudio.habilidadesOperacionais.map((x, i) => (i === idx ? { ...x, id } : x)),
                        })
                      }
                    />
                    <CampoDeTexto
                      rotulo={`Nome da ${s.id}`}
                      valor={s.nome}
                      limite={LIMITES_DO_ESTUDIO.nomeDaSkill}
                      desativado={!podeEditar}
                      aoMudar={(nome) =>
                        mudarEstudio({
                          habilidadesOperacionais: estudio.habilidadesOperacionais.map((x, i) => (i === idx ? { ...x, nome } : x)),
                        })
                      }
                    />
                  </div>
                  <CampoDeTexto
                    rotulo={`Quando acionar ${s.id}`}
                    valor={s.quando}
                    limite={LIMITES_DO_ESTUDIO.quando}
                    desativado={!podeEditar}
                    aoMudar={(quando) =>
                      mudarEstudio({
                        habilidadesOperacionais: estudio.habilidadesOperacionais.map((x, i) => (i === idx ? { ...x, quando } : x)),
                      })
                    }
                  />
                  <CampoDeTexto
                    rotulo={`Exemplo de resposta (${s.id})`}
                    valor={s.exemploDeResposta}
                    limite={LIMITES_DO_ESTUDIO.exemploDeResposta}
                    linhas={2}
                    desativado={!podeEditar}
                    aoMudar={(exemploDeResposta) =>
                      mudarEstudio({
                        habilidadesOperacionais: estudio.habilidadesOperacionais.map((x, i) => (i === idx ? { ...x, exemploDeResposta } : x)),
                      })
                    }
                  />
                  <CampoDeTexto
                    rotulo={`Instruções da skill ${s.id}`}
                    valor={s.conteudoMd}
                    limite={LIMITES_DO_ESTUDIO.conteudoMd}
                    linhas={3}
                    desativado={!podeEditar}
                    aoMudar={(conteudoMd) =>
                      mudarEstudio({
                        habilidadesOperacionais: estudio.habilidadesOperacionais.map((x, i) => (i === idx ? { ...x, conteudoMd } : x)),
                      })
                    }
                  />
                </li>
              ))}
            </ol>
          ))}

        {/* --- Subgrupo: Skills de Humanização --- */}
        {subSkill === 'humanizacao' &&
          (humsFiltradas.length === 0 ? (
            <p className="treino-vazio">Nenhuma skill de humanização encontrada.</p>
          ) : (
            <ol className="estudio-lista">
              {humsFiltradas.map(({ h, idx }) => (
                <li key={`${idx}-${h.id}`} className="estudio-card">
                  <div className="estudio-card-topo">
                    <span className="estudio-codigo">{h.id}</span>
                    <label className="estudio-ativa">
                      <input
                        type="checkbox"
                        disabled={!podeEditar}
                        checked={h.ativa}
                        onChange={(e) =>
                          mudarEstudio({
                            habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.map((x, i) =>
                              i === idx ? { ...x, ativa: e.target.checked } : x,
                            ),
                          })
                        }
                      />
                      <span>Ativa</span>
                    </label>
                    {podeEditar && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() =>
                          mudarEstudio({
                            habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.filter((_, i) => i !== idx),
                          })
                        }
                      >
                        Remover<span className="so-leitor-de-tela"> humanização {h.id}</span>
                      </button>
                    )}
                  </div>
                  <div className="grade-de-campos">
                    <CampoDeTexto
                      rotulo={`Código (${h.id})`}
                      valor={h.id}
                      limite={LIMITES_DO_ESTUDIO.id}
                      desativado={!podeEditar}
                      aoMudar={(id) =>
                        mudarEstudio({
                          habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.map((x, i) => (i === idx ? { ...x, id } : x)),
                        })
                      }
                    />
                    <CampoDeTexto
                      rotulo={`Nome (${h.id})`}
                      valor={h.nome}
                      limite={LIMITES_DO_ESTUDIO.nomeDaSkill}
                      desativado={!podeEditar}
                      aoMudar={(nome) =>
                        mudarEstudio({
                          habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.map((x, i) => (i === idx ? { ...x, nome } : x)),
                        })
                      }
                    />
                  </div>
                  <div className="grade-de-campos">
                    <CampoDeTexto
                      rotulo={`Gatilho (${h.id})`}
                      valor={h.gatilho}
                      limite={LIMITES_DO_ESTUDIO.quando}
                      desativado={!podeEditar}
                      aoMudar={(gatilho) =>
                        mudarEstudio({
                          habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.map((x, i) => (i === idx ? { ...x, gatilho } : x)),
                        })
                      }
                    />
                    <CampoDeTexto
                      rotulo={`Objetivo (${h.id})`}
                      valor={h.objetivo}
                      limite={LIMITES_DO_ESTUDIO.quando}
                      desativado={!podeEditar}
                      aoMudar={(objetivo) =>
                        mudarEstudio({
                          habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.map((x, i) => (i === idx ? { ...x, objetivo } : x)),
                        })
                      }
                    />
                  </div>
                  <CampoDeTexto
                    rotulo={`O que evitar (${h.id})`}
                    valor={h.evitar}
                    limite={LIMITES_DO_ESTUDIO.quando}
                    desativado={!podeEditar}
                    aoMudar={(evitar) =>
                      mudarEstudio({
                        habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.map((x, i) => (i === idx ? { ...x, evitar } : x)),
                      })
                    }
                  />
                  <div className="grade-de-campos">
                    <CampoDeTexto
                      rotulo={`Como NÃO responder (${h.id})`}
                      valor={h.respostaRuim}
                      limite={LIMITES_DO_ESTUDIO.exemploDeResposta}
                      linhas={2}
                      desativado={!podeEditar}
                      aoMudar={(respostaRuim) =>
                        mudarEstudio({
                          habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.map((x, i) => (i === idx ? { ...x, respostaRuim } : x)),
                        })
                      }
                    />
                    <CampoDeTexto
                      rotulo={`Resposta melhor (${h.id})`}
                      valor={h.respostaMelhor}
                      limite={LIMITES_DO_ESTUDIO.exemploDeResposta}
                      linhas={2}
                      desativado={!podeEditar}
                      aoMudar={(respostaMelhor) =>
                        mudarEstudio({
                          habilidadesDeHumanizacao: estudio.habilidadesDeHumanizacao.map((x, i) => (i === idx ? { ...x, respostaMelhor } : x)),
                        })
                      }
                    />
                  </div>
                </li>
              ))}
            </ol>
          ))}

        {/* --- Subgrupo: Matriz de Objeções --- */}
        {subSkill === 'objecoes' &&
          (objsFiltradas.length === 0 ? (
            <p className="treino-vazio">Nenhuma objeção cadastrada ainda.</p>
          ) : (
            <ol className="estudio-lista">
              {objsFiltradas.map(({ o, idx }) => (
                <li key={`${idx}-${o.id}`} className="estudio-card">
                  <div className="estudio-card-topo">
                    <span className="estudio-codigo">{o.id}</span>
                    <label className="estudio-ativa">
                      <input
                        type="checkbox"
                        disabled={!podeEditar}
                        checked={o.ativa}
                        onChange={(e) =>
                          mudarEstudio({
                            objecoes: estudio.objecoes.map((x, i) => (i === idx ? { ...x, ativa: e.target.checked } : x)),
                          })
                        }
                      />
                      <span>Ativa</span>
                    </label>
                    {podeEditar && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() =>
                          mudarEstudio({
                            objecoes: estudio.objecoes.filter((_, i) => i !== idx),
                          })
                        }
                      >
                        Remover<span className="so-leitor-de-tela"> objeção {o.id}</span>
                      </button>
                    )}
                  </div>
                  <div className="grade-de-campos">
                    <CampoDeTexto
                      rotulo={`Código (${o.id})`}
                      valor={o.id}
                      limite={LIMITES_DO_ESTUDIO.id}
                      desativado={!podeEditar}
                      aoMudar={(id) =>
                        mudarEstudio({
                          objecoes: estudio.objecoes.map((x, i) => (i === idx ? { ...x, id } : x)),
                        })
                      }
                    />
                    <CampoDeTexto
                      rotulo={`Natureza (${o.id})`}
                      valor={o.natureza}
                      limite={160}
                      desativado={!podeEditar}
                      aoMudar={(natureza) =>
                        mudarEstudio({
                          objecoes: estudio.objecoes.map((x, i) => (i === idx ? { ...x, natureza } : x)),
                        })
                      }
                    />
                    <CampoDeTexto
                      rotulo={`Skill ligada (${o.id})`}
                      valor={o.skillId}
                      limite={LIMITES_DO_ESTUDIO.id}
                      exemplo="Ex.: S09"
                      desativado={!podeEditar}
                      aoMudar={(skillId) =>
                        mudarEstudio({
                          objecoes: estudio.objecoes.map((x, i) => (i === idx ? { ...x, skillId } : x)),
                        })
                      }
                    />
                  </div>
                  <CampoDeTexto
                    rotulo={`Quando o cliente disser / padrão (${o.id})`}
                    valor={o.padraoDeEntrada}
                    limite={LIMITES_DO_ESTUDIO.padraoDeEntrada}
                    desativado={!podeEditar}
                    aoMudar={(padraoDeEntrada) =>
                      mudarEstudio({
                        objecoes: estudio.objecoes.map((x, i) => (i === idx ? { ...x, padraoDeEntrada } : x)),
                      })
                    }
                  />
                  <CampoDeTexto
                    rotulo={`Estratégia de resposta (${o.id})`}
                    valor={o.estrategiaDeResposta}
                    limite={LIMITES_DO_ESTUDIO.estrategia}
                    linhas={2}
                    desativado={!podeEditar}
                    aoMudar={(estrategiaDeResposta) =>
                      mudarEstudio({
                        objecoes: estudio.objecoes.map((x, i) => (i === idx ? { ...x, estrategiaDeResposta } : x)),
                      })
                    }
                  />
                  <CampoDeTexto
                    rotulo={`O que evitar (${o.id})`}
                    valor={o.evitar}
                    limite={LIMITES_DO_ESTUDIO.estrategia}
                    desativado={!podeEditar}
                    aoMudar={(evitar) =>
                      mudarEstudio({
                        objecoes: estudio.objecoes.map((x, i) => (i === idx ? { ...x, evitar } : x)),
                      })
                    }
                  />
                </li>
              ))}
            </ol>
          ))}
      </section>

      {/* ============================================================
          ABA: CÉREBRO COMPLETO & PACOTE TURBO
         ============================================================ */}
      <section
        className="panel"
        role="tabpanel"
        id="treino-painel-cerebro"
        aria-labelledby="treino-aba-cerebro"
        hidden={!visivel('cerebro')}
      >
        <h2 className="panel-title">Cérebro completo e Pacote Turbo</h2>
        <p className="panel-desc">
          Importe um Pacote Turbo (.zip, .json ou .md com mensagens M01–M13, skills S01–S35, humanização H01–H32, objeções e personas),
          ajuste o modo de seleção por turno ou baixe um backup completo da base.
        </p>

        <div className="estudio-pacote-caixa">
          {podeEditar && (
            <div className="form-group">
              <label className="form-label" htmlFor="estudio-importar-pacote">
                Importar Pacote Turbo (.zip, .json ou .md)
              </label>
              <div className="linha-de-campo">
                <input
                  ref={inputPacote}
                  id="estudio-importar-pacote"
                  className="campo"
                  type="file"
                  accept=".zip,.json,.md,.txt"
                  disabled={ocupado || lendoArquivo}
                  onChange={(e) => void escolherPacote(e.target.files?.[0])}
                />
                {arquivosCount > 0 && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={ocupado || lendoArquivo}
                    onClick={() => void extrairDeArquivos()}
                  >
                    Extrair dos arquivos anexados ({arquivosCount})
                  </button>
                )}
              </div>
              <p className="campo-dica">
                Compatível com pacotes no formato <code>PACOTE-*.zip</code> e backups exportados aqui. Você vê a prévia completa antes de
                aplicar.
              </p>
            </div>
          )}

          <div className="estudio-acoes-backup">
            <button type="button" className="btn btn-secondary" disabled={ocupado} onClick={baixarBackupZip}>
              Exportar backup completo (.zip)
            </button>
          </div>
          {erroImport && (
            <p className="aviso aviso--erro" role="alert">
              {erroImport}
            </p>
          )}
        </div>

        <fieldset className="opcoes" disabled={!podeEditar}>
          <legend>Como a IA recebe as skills e mensagens em cada conversa</legend>
          {(
            [
              [
                'inteligente',
                'Seleção inteligente por turno (recomendado)',
                'Escolhe automaticamente as mensagens, skills, objeções e personas mais relevantes para a fala atual do cliente. Mais rápido e econômico.',
              ],
              [
                'completo',
                'Pacote completo em toda conversa',
                'Envia todas as mensagens e skills ativas em todo turno. Útil para bases pequenas ou testes exaustivos.',
              ],
            ] as Array<[ModoDeContextoDoCerebro, string, string]>
          ).map(([valor, titulo, exp]) => (
            <label key={valor} className="opcao">
              <input
                type="radio"
                name="cerebro-modo-contexto"
                checked={modoContexto === valor}
                onChange={() => atualizarCerebro({ modoDeContexto: valor })}
              />
              <span>
                <strong>{titulo}</strong>
                <small>{exp}</small>
              </span>
            </label>
          ))}
        </fieldset>

        {cerebro && (
          <div className="estudio-cerebro-resumo">
            <p className="aviso">
              <strong>{cerebro.nome}</strong> · versão {cerebro.versao} · {cerebro.personas.length} personas ·{' '}
              {cerebro.paresBomRuim.length} exemplos bom/ruim · {cerebro.respostasDeReferencia.length} respostas de referência.
            </p>
          </div>
        )}

        <CampoDeTexto
          rotulo="Playbook central do cérebro"
          valor={cerebro?.playbookCentral ?? ''}
          limite={LIMITES_DO_ESTUDIO.playbookCentral}
          linhas={5}
          exemplo="Diretrizes principais de atendimento e estratégia."
          desativado={!podeEditar}
          aoMudar={(playbookCentral) => atualizarCerebro({ playbookCentral })}
        />
        <CampoDeTexto
          rotulo="Regras canônicas e filtros de postura"
          valor={cerebro?.regrasCanonicas ?? ''}
          limite={LIMITES_DO_ESTUDIO.regrasCanonicas}
          linhas={5}
          exemplo="Princípios obrigatórios de voz, postura e condução."
          desativado={!podeEditar}
          aoMudar={(regrasCanonicas) => atualizarCerebro({ regrasCanonicas })}
        />

        {cerebro && cerebro.personas.length > 0 && (
          <details className="estudio-detalhes">
            <summary>Personas detectadas ({cerebro.personas.length})</summary>
            <ul>
              {cerebro.personas.map((p) => (
                <li key={p.id}>
                  <strong>
                    {p.id} · {p.nome}
                  </strong>
                  {p.sinais && <small>Sinais: {p.sinais}</small>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {previa && (
        <Dialogo titulo="Prévia do Pacote Turbo" aoFechar={() => setPrevia(null)} largo>
          <p className="dialogo-texto">
            Arquivo lido: <strong>{previa.resumo.origem}</strong>
          </p>
          <ul className="estudio-previa-grade">
            <li>
              <strong>{previa.resumo.mensagens}</strong> mensagens prontas
            </li>
            <li>
              <strong>{previa.resumo.skillsOperacionais}</strong> skills operacionais
            </li>
            <li>
              <strong>{previa.resumo.skillsHumanizacao}</strong> skills de humanização
            </li>
            <li>
              <strong>{previa.resumo.objecoes}</strong> objeções mapeadas
            </li>
            <li>
              <strong>{previa.resumo.personas}</strong> personas
            </li>
            <li>
              <strong>{previa.resumo.respostasReferencia}</strong> respostas de referência
            </li>
          </ul>
          {Object.keys(previa.sugestaoIdentidade).length > 0 && (
            <label className="estudio-previa-opcao">
              <input
                type="checkbox"
                checked={aplicarIdentidade}
                onChange={(e) => setAplicarIdentidade(e.target.checked)}
              />
              <span>Atualizar também identidade, sobre o negócio e regras com os dados do pacote</span>
            </label>
          )}
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setPrevia(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => aplicarPrevia('mesclar')}>
              Mesclar com atuais
            </button>
            <button type="button" className="btn btn-primary" onClick={() => aplicarPrevia('substituir')}>
              Substituir Estúdio
            </button>
          </div>
        </Dialogo>
      )}
    </>
  );
}
