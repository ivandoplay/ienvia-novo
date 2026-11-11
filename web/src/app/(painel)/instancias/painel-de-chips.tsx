'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Icone } from '@/components/ui/icone';
import type { Chip } from '@/lib/dados/instancias';
import {
  FUNCOES_DO_CHIP,
  descreverEstado,
  formatarCodigoDePareamento,
  formatarTelefone,
  rotuloDaFuncao,
} from '@/lib/instancias/regras';
import {
  adicionarChip,
  conferirChip,
  desconectarChip,
  gerarQrCode,
  removerChip,
  salvarChip,
  type EstadoDoFormulario,
} from './acoes';

interface Props {
  chips: Chip[];
  /** Quantos chips a conta pode ter. */
  limite: number;
  /** Só o dono da conta mexe nos chips. */
  podeEditar: boolean;
  evolutionConfigurada: boolean;
  temEnderecoPublico: boolean;
  falhouAoCarregar: boolean;
}

/** O que está sendo mostrado para conectar um chip: a imagem do QR Code ou o código de 8 dígitos. */
interface Conexao {
  chipId: string;
  imagem: string | null;
  codigo: string | null;
  /** Quantas vezes o QR Code já foi renovado sozinho. */
  renovacoes: number;
  expirou: boolean;
}

interface Recado {
  tipo: 'ok' | 'erro';
  texto: string;
}

type Janela = { tipo: 'novo' } | { tipo: 'editar'; chip: Chip } | { tipo: 'remover'; chip: Chip } | null;

/** De quanto em quanto tempo perguntamos se o chip já conectou. */
const INTERVALO_DE_CONFERENCIA = 3_000;
/** O WhatsApp troca o QR Code de tempos em tempos; renovamos antes de ele vencer. */
const VALIDADE_DO_QR = 35_000;
const RENOVACOES_MAXIMAS = 5;

export function PainelDeChips({ chips, limite, podeEditar, evolutionConfigurada, temEnderecoPublico, falhouAoCarregar }: Props) {
  const router = useRouter();
  const [janela, setJanela] = useState<Janela>(null);
  const [conexao, setConexao] = useState<Conexao | null>(null);
  const [recados, setRecados] = useState<Record<string, Recado>>({});
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [, iniciar] = useTransition();

  const podeAdicionar = podeEditar && evolutionConfigurada && chips.length < limite;
  const idsDosChips = chips.map((chip) => chip.id).join(',');

  const avisar = (chipId: string, recado: Recado | null) =>
    setRecados((atuais) => {
      const proximos = { ...atuais };
      if (recado) proximos[chipId] = recado;
      else delete proximos[chipId];
      return proximos;
    });

  // Ao abrir a tela, confere com a Evolution como cada chip está de verdade.
  const jaConferiu = useRef('');
  useEffect(() => {
    if (!podeEditar || !evolutionConfigurada || !idsDosChips || jaConferiu.current === idsDosChips) return;
    jaConferiu.current = idsDosChips;
    let cancelado = false;
    void (async () => {
      for (const chipId of idsDosChips.split(',')) {
        if (cancelado) return;
        await conferirChip(chipId, true).catch(() => undefined);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [idsDosChips, podeEditar, evolutionConfigurada]);

  // Enquanto um QR Code (ou código) está na tela: pergunta se já conectou e renova o QR antes de vencer.
  useEffect(() => {
    if (!conexao || conexao.expirou) return;
    const { chipId } = conexao;
    let ativo = true;

    const conferencia = setInterval(() => {
      void conferirChip(chipId)
        .then((resposta) => {
          if (!ativo || !resposta.ok || resposta.estado !== 'connected') return;
          setConexao(null);
          avisar(chipId, { tipo: 'ok', texto: 'Chip conectado!' });
          router.refresh();
        })
        .catch(() => undefined);
    }, INTERVALO_DE_CONFERENCIA);

    const renovacao = setTimeout(() => {
      if (!conexao.imagem) return; // o código de 8 dígitos não é renovado sozinho
      if (conexao.renovacoes >= RENOVACOES_MAXIMAS) {
        setConexao({ ...conexao, expirou: true });
        return;
      }
      void gerarQrCode(chipId)
        .then((resposta) => {
          if (!ativo) return;
          if (resposta.ok && resposta.qr.imagem) {
            setConexao({ ...conexao, imagem: resposta.qr.imagem, renovacoes: conexao.renovacoes + 1 });
          } else {
            setConexao({ ...conexao, expirou: true });
          }
        })
        .catch(() => undefined);
    }, VALIDADE_DO_QR);

    return () => {
      ativo = false;
      clearInterval(conferencia);
      clearTimeout(renovacao);
    };
  }, [conexao, router]);

  function pedirConexao(chip: Chip, numero?: string) {
    const chave = `${numero === undefined ? 'qr' : 'codigo'}:${chip.id}`;
    setOcupado(chave);
    avisar(chip.id, null);
    iniciar(async () => {
      const resposta = await gerarQrCode(chip.id, numero).catch(() => null);
      setOcupado(null);
      if (!resposta) {
        avisar(chip.id, { tipo: 'erro', texto: 'Não foi possível falar com o servidor. Tente de novo.' });
      } else if (!resposta.ok) {
        avisar(chip.id, { tipo: 'erro', texto: resposta.erro });
      } else if (resposta.conectado) {
        setConexao(null);
        avisar(chip.id, { tipo: 'ok', texto: 'Este chip já está conectado.' });
        router.refresh();
      } else {
        setConexao({
          chipId: chip.id,
          imagem: numero === undefined ? resposta.qr.imagem : null,
          codigo: numero === undefined ? null : resposta.qr.codigoDePareamento,
          renovacoes: 0,
          expirou: false,
        });
      }
    });
  }

  function executar(chave: string, chip: Chip, acao: () => Promise<{ ok: true } | { ok: false; erro: string }>, sucesso?: string) {
    setOcupado(chave);
    avisar(chip.id, null);
    iniciar(async () => {
      const resposta = await acao().catch(() => null);
      setOcupado(null);
      if (!resposta) avisar(chip.id, { tipo: 'erro', texto: 'Não foi possível falar com o servidor. Tente de novo.' });
      else if (!resposta.ok) avisar(chip.id, { tipo: 'erro', texto: resposta.erro });
      else if (sucesso) avisar(chip.id, { tipo: 'ok', texto: sucesso });
      router.refresh();
    });
  }

  function aoCriar(estado: EstadoDoFormulario) {
    setJanela(null);
    if (!estado.chipId) return;
    if (estado.qr?.imagem) {
      setConexao({ chipId: estado.chipId, imagem: estado.qr.imagem, codigo: null, renovacoes: 0, expirou: false });
    } else {
      avisar(estado.chipId, {
        tipo: 'ok',
        texto: 'Chip cadastrado. Toque em "Gerar QR Code" para conectar.',
      });
    }
    router.refresh();
  }

  return (
    <div className="instancias">
      <div className="page-header">
        <div>
          <h1>Instâncias</h1>
          <p>Conecte, apelide e escolha o que cada chip faz — um por vez, sem mexer no outro.</p>
        </div>
      </div>

      <div className="instancias-avisos">
        {falhouAoCarregar && (
          <p className="aviso aviso--erro" role="alert">
            Não foi possível carregar os chips agora. Atualize a página em instantes.
          </p>
        )}
        {!evolutionConfigurada && (
          <p className="aviso aviso--atencao">
            A conexão com a Evolution ainda não foi configurada neste ambiente. Os chips aparecem, mas não dá para
            conectar nem adicionar.
          </p>
        )}
        {evolutionConfigurada && !temEnderecoPublico && (
          <p className="aviso aviso--atencao">
            Este ambiente não tem endereço público. O chip conecta, mas as mensagens só chegam ao painel quando ele
            estiver publicado.
          </p>
        )}
        {!podeEditar && <p className="aviso">Só o dono da conta pode adicionar, conectar ou remover chips.</p>}
      </div>

      <div className="instancias-topo">
        <p className="instancias-contagem">
          {chips.length} de {limite} {limite === 1 ? 'chip' : 'chips'} em uso
        </p>
        {podeEditar && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!podeAdicionar}
            onClick={() => setJanela({ tipo: 'novo' })}
          >
            <Icone nome="adicionar" className="icon-15" />
            Adicionar chip
          </button>
        )}
      </div>
      {podeEditar && evolutionConfigurada && chips.length >= limite && (
        <p className="instancias-limite">
          Sua conta já usa todos os chips do plano. Para conectar outro número, remova um chip ou peça um limite maior.
        </p>
      )}

      {chips.length === 0 && !falhouAoCarregar ? (
        <div className="empty-state">
          Nenhum chip por aqui ainda. Adicione o primeiro para começar a receber as conversas no painel.
        </div>
      ) : (
        chips.map((chip) => (
          <CartaoDoChip
            key={chip.id}
            chip={chip}
            podeEditar={podeEditar && evolutionConfigurada}
            conexao={conexao?.chipId === chip.id ? conexao : null}
            recado={recados[chip.id] ?? null}
            ocupado={ocupado}
            aoPedirQr={() => pedirConexao(chip)}
            aoPedirCodigo={(numero) => pedirConexao(chip, numero)}
            aoFecharConexao={() => setConexao(null)}
            aoDesconectar={() =>
              executar(`desconectar:${chip.id}`, chip, () => desconectarChip(chip.id), 'Chip desconectado.')
            }
            aoEditar={() => setJanela({ tipo: 'editar', chip })}
            aoRemover={() => setJanela({ tipo: 'remover', chip })}
          />
        ))
      )}

      {janela?.tipo === 'novo' && (
        <Dialogo titulo="Adicionar chip" aoFechar={() => setJanela(null)}>
          <FormularioDoChip aoConcluir={aoCriar} aoCancelar={() => setJanela(null)} />
        </Dialogo>
      )}
      {janela?.tipo === 'editar' && (
        <Dialogo titulo="Editar chip" aoFechar={() => setJanela(null)}>
          <FormularioDoChip
            chip={janela.chip}
            aoCancelar={() => setJanela(null)}
            aoConcluir={() => {
              setJanela(null);
              router.refresh();
            }}
          />
        </Dialogo>
      )}
      {janela?.tipo === 'remover' && (
        <Dialogo titulo="Remover chip" aoFechar={() => setJanela(null)}>
          <p className="dialogo-texto">
            O chip <strong>{janela.chip.apelido}</strong> será desconectado do WhatsApp e sairá da lista. As conversas
            e mensagens dele continuam guardadas.
          </p>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setJanela(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                const { chip } = janela;
                setJanela(null);
                if (conexao?.chipId === chip.id) setConexao(null);
                executar(`remover:${chip.id}`, chip, () => removerChip(chip.id));
              }}
            >
              Remover chip
            </button>
          </div>
        </Dialogo>
      )}
    </div>
  );
}

interface PropsDoCartao {
  chip: Chip;
  podeEditar: boolean;
  conexao: Conexao | null;
  recado: Recado | null;
  ocupado: string | null;
  aoPedirQr: () => void;
  aoPedirCodigo: (numero: string) => void;
  aoFecharConexao: () => void;
  aoDesconectar: () => void;
  aoEditar: () => void;
  aoRemover: () => void;
}

function CartaoDoChip({
  chip,
  podeEditar,
  conexao,
  recado,
  ocupado,
  aoPedirQr,
  aoPedirCodigo,
  aoFecharConexao,
  aoDesconectar,
  aoEditar,
  aoRemover,
}: PropsDoCartao) {
  const idTitulo = useId();
  const idNumero = useId();
  const [numero, setNumero] = useState('');
  const estado = descreverEstado(chip.estado);
  const conectado = chip.estado === 'connected';
  const naNuvem = chip.motor === 'evolution';
  const trabalhando = ocupado !== null && ocupado.endsWith(`:${chip.id}`);

  function enviarNumero(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    aoPedirCodigo(numero);
  }

  return (
    <article className="panel chip" aria-labelledby={idTitulo}>
      <div className="chip-cabecalho">
        <div className="chip-identidade">
          <div className="chip-titulo">
            <h2 id={idTitulo}>{chip.apelido}</h2>
            <span className={`estado estado--${estado.tom}`}>{estado.texto}</span>
          </div>
          <ul className="chip-dados">
            <li>{chip.telefone ? formatarTelefone(chip.telefone) : 'Número ainda não conectado'}</li>
            <li>{rotuloDaFuncao(chip.funcao)}</li>
            <li>
              <Icone nome={naNuvem ? 'nuvem' : 'conexoes'} className="icon-15" />
              {naNuvem ? 'Nuvem (Evolution)' : 'Motor local'}
            </li>
          </ul>
        </div>

        {podeEditar && (
          <div className="chip-acoes">
            {conectado && naNuvem && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={trabalhando} onClick={aoDesconectar}>
                <Icone nome="desligar" className="icon-15" />
                {ocupado === `desconectar:${chip.id}` ? 'Desconectando…' : 'Desconectar'}
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" disabled={trabalhando} onClick={aoEditar}>
              <Icone nome="lapis" className="icon-15" />
              Editar
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={trabalhando} onClick={aoRemover}>
              <Icone nome="lixeira" className="icon-15" />
              {ocupado === `remover:${chip.id}` ? 'Removendo…' : 'Remover'}
            </button>
          </div>
        )}
      </div>

      <p className="chip-ia">
        Atendente de IA: {chip.iaLigada ? 'ligado' : 'desligado'} neste chip.{' '}
        {!chip.iaLigada && 'Todo chip nasce assim; o botão de ligar chega junto com o atendente de IA, na próxima etapa.'}
      </p>

      {recado && (
        <p className={`aviso ${recado.tipo === 'ok' ? 'aviso--ok' : 'aviso--erro'}`} role={recado.tipo === 'ok' ? 'status' : 'alert'}>
          {recado.texto}
        </p>
      )}

      {podeEditar && naNuvem && !conectado && (
        <div className="chip-conexao">
          {conexao ? (
            <div className="chip-qr">
              {conexao.imagem && !conexao.expirou && (
                // O QR Code chega pronto da Evolution, como imagem embutida; não há o que otimizar.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={conexao.imagem} alt={`QR Code para conectar o chip ${chip.apelido}`} width={208} height={208} />
              )}
              <div>
                {conexao.expirou ? (
                  <p className="chip-conexao-dica">O QR Code venceu. Gere outro para continuar.</p>
                ) : conexao.codigo ? (
                  <>
                    <p className="chip-codigo">{formatarCodigoDePareamento(conexao.codigo)}</p>
                    <ol>
                      <li>Abra o WhatsApp no celular deste chip.</li>
                      <li>Toque em Aparelhos conectados e depois em Conectar um aparelho.</li>
                      <li>Escolha Conectar com número de telefone e digite o código acima.</li>
                    </ol>
                  </>
                ) : (
                  <ol>
                    <li>Abra o WhatsApp no celular deste chip.</li>
                    <li>Toque em Aparelhos conectados e depois em Conectar um aparelho.</li>
                    <li>Aponte a câmera para o código ao lado.</li>
                  </ol>
                )}
                {!conexao.expirou && (
                  <p className="chip-espera" role="status">
                    Aguardando a conexão…
                  </p>
                )}
                <div className="chip-conexao-acoes">
                  {conexao.expirou && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={trabalhando} onClick={aoPedirQr}>
                      <Icone nome="qrCode" className="icon-15" />
                      Gerar outro QR Code
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm" onClick={aoFecharConexao}>
                    Fechar
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="chip-conexao-acoes">
                <button type="button" className="btn btn-primary" disabled={trabalhando} onClick={aoPedirQr}>
                  <Icone nome="qrCode" className="icon-15" />
                  {ocupado === `qr:${chip.id}` ? 'Gerando…' : 'Gerar QR Code'}
                </button>
                <span className="chip-conexao-dica">ou conecte por código numérico, abaixo.</span>
              </div>

              <form className="chip-sem-camera" onSubmit={enviarNumero}>
                <label className="form-label" htmlFor={idNumero}>
                  Conectar sem câmera (código de 8 dígitos)
                </label>
                <div className="linha-de-campo">
                  <input
                    id={idNumero}
                    className="campo"
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    placeholder="Ex.: 85 99999-0000"
                    value={numero}
                    onChange={(evento) => setNumero(evento.target.value)}
                    maxLength={24}
                    required
                  />
                  <button type="submit" className="btn btn-secondary" disabled={trabalhando}>
                    {ocupado === `codigo:${chip.id}` ? 'Gerando…' : 'Gerar código'}
                  </button>
                </div>
                <p className="campo-dica">Informe o número deste chip, com DDD.</p>
              </form>
            </>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Janela por cima da tela. Fecha com Esc, no botão ou clicando fora.
 * Quem abre controla: para fechar, basta deixar de renderizar. Ao sair, a janela é fechada
 * do jeito nativo, que devolve o foco para o botão que a abriu.
 */
function Dialogo({ titulo, aoFechar, children }: { titulo: string; aoFechar: () => void; children: ReactNode }) {
  const referencia = useRef<HTMLDialogElement>(null);
  const idTitulo = useId();

  useLayoutEffect(() => {
    const dialogo = referencia.current;
    if (!dialogo) return;
    if (!dialogo.open) dialogo.showModal();
    return () => {
      if (dialogo.open) dialogo.close();
    };
  }, []);

  return (
    <dialog
      ref={referencia}
      className="dialogo"
      aria-labelledby={idTitulo}
      onClose={(evento) => {
        // O aviso de "fechou" chega com atraso. Se a janela já foi reaberta (o modo de desenvolvimento
        // do React monta, desmonta e monta de novo), o aviso é antigo e não vale.
        if (!evento.currentTarget.open) aoFechar();
      }}
      onClick={(evento) => {
        // Clique no fundo escuro (fora da caixa) fecha.
        if (evento.target === evento.currentTarget) aoFechar();
      }}
    >
      <div className="dialogo-caixa">
        <div className="dialogo-topo">
          <h2 id={idTitulo}>{titulo}</h2>
          <button type="button" className="btn btn-secondary btn-sm btn-icon-only" onClick={aoFechar}>
            <Icone nome="fechar" className="icon-15" />
            <span className="so-leitor-de-tela">Fechar</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/** Formulário de apelido e função. Sem `chip`, cria um chip novo; com `chip`, edita. */
function FormularioDoChip({
  chip,
  aoConcluir,
  aoCancelar,
}: {
  chip?: Chip;
  aoConcluir: (estado: EstadoDoFormulario) => void;
  aoCancelar: () => void;
}) {
  const idApelido = useId();
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, iniciar] = useTransition();

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    setErro(null);
    iniciar(async () => {
      const resposta = await (chip ? salvarChip : adicionarChip)({}, dados).catch(() => null);
      if (resposta?.ok) aoConcluir(resposta);
      else setErro(resposta?.erro ?? 'Não foi possível falar com o servidor. Tente de novo.');
    });
  }

  return (
    <form onSubmit={enviar}>
      {chip && <input type="hidden" name="chipId" value={chip.id} />}
      <div className="form-group">
        <label className="form-label" htmlFor={idApelido}>
          Apelido do chip
        </label>
        <input
          id={idApelido}
          name="apelido"
          className="campo"
          type="text"
          placeholder="Ex.: Comercial"
          defaultValue={chip?.apelido ?? ''}
          maxLength={60}
          autoComplete="off"
          required
        />
        <p className="campo-dica">É só para você reconhecer o chip. O cliente não vê.</p>
      </div>

      <fieldset className="opcoes">
        <legend>O que este chip faz</legend>
        {FUNCOES_DO_CHIP.map((funcao) => (
          <label key={funcao.valor} className="opcao">
            <input
              type="radio"
              name="funcao"
              value={funcao.valor}
              defaultChecked={(chip?.funcao ?? 'attendance') === funcao.valor}
            />
            <span>
              <strong>{funcao.rotulo}</strong>
              <small>{funcao.descricao}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {erro && (
        <p className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}

      <div className="dialogo-acoes" style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-secondary" onClick={aoCancelar} disabled={enviando}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={enviando}>
          {enviando ? 'Salvando…' : chip ? 'Salvar' : 'Criar e conectar'}
        </button>
      </div>
    </form>
  );
}
