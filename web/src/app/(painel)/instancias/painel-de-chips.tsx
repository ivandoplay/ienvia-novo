'use client';

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import { Interruptor } from '@/components/ui/interruptor';
import type { ResumoDaIa } from '@/lib/atendente/painel';
import type { Chip, ExecutorResumo } from '@/lib/dados/instancias';
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
  mudarIaDoChip,
  removerChip,
  salvarChip,
  type EstadoDoFormulario,
} from './acoes';

interface Props {
  chips: Chip[];
  executores?: ExecutorResumo[];
  /** Quantos chips a conta pode ter. */
  limite: number;
  /** Só o dono da conta mexe nos chips. */
  podeEditar: boolean;
  evolutionConfigurada: boolean;
  temEnderecoPublico: boolean;
  falhouAoCarregar: boolean;
  /** Como está a IA da empresa: pausada ou não, e o que falta para ligar. `null` quando não deu para ler. */
  ia: ResumoDaIa | null;
}

/** O que está sendo mostrado para conectar um chip: a imagem do QR Code ou o código de 8 dígitos. */
interface Conexao {
  chipId: string;
  motor: Chip['motor'];
  imagem: string | null;
  codigo: string | null;
  /** Quantas vezes o QR Code já foi renovado sozinho. */
  renovacoes: number;
  expirou: boolean;
  aguardandoMotor?: boolean;
}

interface Recado {
  tipo: 'ok' | 'erro';
  texto: string;
}

type Janela = { tipo: 'novo' } | { tipo: 'editar'; chip: Chip } | { tipo: 'remover'; chip: Chip } | null;

const INTERVALO_DE_CONFERENCIA = 3_000;
const INTERVALO_LOCAL = 2_000;
const VALIDADE_DO_QR = 35_000;
const RENOVACOES_MAXIMAS = 5;

async function qrParaDataUrl(bruto: string): Promise<string | null> {
  if (bruto.startsWith('data:image/')) return bruto;
  try {
    return await QRCode.toDataURL(bruto, { width: 208, margin: 1 });
  } catch {
    return null;
  }
}

export function PainelDeChips({
  chips,
  executores = [],
  limite,
  podeEditar,
  evolutionConfigurada,
  temEnderecoPublico,
  falhouAoCarregar,
  ia,
}: Props) {
  const router = useRouter();
  const [janela, setJanela] = useState<Janela>(null);
  const [conexao, setConexao] = useState<Conexao | null>(null);
  const [recados, setRecados] = useState<Record<string, Recado>>({});
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [, iniciar] = useTransition();

  const podeCriarAlgumChip = evolutionConfigurada || executores.length > 0;
  const podeAdicionar = podeEditar && podeCriarAlgumChip && chips.length < limite;
  const idsEvolution = chips
    .filter((c) => c.motor === 'evolution')
    .map((chip) => chip.id)
    .join(',');

  const avisar = (chipId: string, recado: Recado | null) =>
    setRecados((atuais) => {
      const proximos = { ...atuais };
      if (recado) proximos[chipId] = recado;
      else delete proximos[chipId];
      return proximos;
    });

  // Ao abrir a tela, confere com a Evolution como cada chip na nuvem está de verdade.
  const jaConferiu = useRef('');
  useEffect(() => {
    if (!podeEditar || !evolutionConfigurada || !idsEvolution || jaConferiu.current === idsEvolution) return;
    jaConferiu.current = idsEvolution;
    let cancelado = false;
    void (async () => {
      for (const chipId of idsEvolution.split(',')) {
        if (cancelado) return;
        await conferirChip(chipId, true).catch(() => undefined);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [idsEvolution, podeEditar, evolutionConfigurada]);

  // Enquanto um QR Code (ou código) está na tela: pergunta se já conectou e recebe QR do motor local.
  useEffect(() => {
    if (!conexao || conexao.expirou) return;
    const { chipId, motor } = conexao;
    let ativo = true;

    const conferencia = setInterval(() => {
      void conferirChip(chipId)
        .then(async (resposta) => {
          if (!ativo || !resposta.ok) return;
          if (resposta.estado === 'connected') {
            setConexao(null);
            avisar(chipId, { tipo: 'ok', texto: 'Chip conectado!' });
            router.refresh();
            return;
          }
          if (motor === 'baileys') {
            if (resposta.pairingCode) {
              setConexao((atual) =>
                atual && atual.chipId === chipId
                  ? { ...atual, imagem: null, codigo: resposta.pairingCode ?? null, aguardandoMotor: false }
                  : atual,
              );
            } else if (resposta.pairingQr) {
              const url = await qrParaDataUrl(resposta.pairingQr);
              if (ativo && url) {
                setConexao((atual) =>
                  atual && atual.chipId === chipId ? { ...atual, imagem: url, codigo: null, aguardandoMotor: false } : atual,
                );
              }
            }
          }
        })
        .catch(() => undefined);
    }, motor === 'baileys' ? INTERVALO_LOCAL : INTERVALO_DE_CONFERENCIA);

    const renovacao =
      motor === 'evolution'
        ? setTimeout(() => {
            if (!conexao.imagem) return;
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
          }, VALIDADE_DO_QR)
        : null;

    return () => {
      ativo = false;
      clearInterval(conferencia);
      if (renovacao) clearTimeout(renovacao);
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
          motor: chip.motor,
          imagem: numero === undefined ? resposta.qr.imagem : null,
          codigo: numero === undefined ? null : resposta.qr.codigoDePareamento,
          renovacoes: 0,
          expirou: false,
          aguardandoMotor: Boolean(resposta.aguardandoMotor),
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
    if (estado.motor === 'baileys') {
      setConexao({
        chipId: estado.chipId,
        motor: 'baileys',
        imagem: null,
        codigo: null,
        renovacoes: 0,
        expirou: false,
        aguardandoMotor: true,
      });
    } else if (estado.qr?.imagem) {
      setConexao({
        chipId: estado.chipId,
        motor: 'evolution',
        imagem: estado.qr.imagem,
        codigo: null,
        renovacoes: 0,
        expirou: false,
      });
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
        <Link href="/conexoes" className="btn btn-secondary">
          <Icone nome="conexoes" className="icon-15" />
          Conexões / Motor
        </Link>
      </div>

      <div className="instancias-avisos">
        {falhouAoCarregar && (
          <p className="aviso aviso--erro" role="alert">
            Não foi possível carregar os chips agora. Atualize a página em instantes.
          </p>
        )}
        {!evolutionConfigurada && (
          <p className="aviso aviso--atencao">
            A conexão com a Evolution ainda não foi configurada neste ambiente.{' '}
            {executores.length > 0
              ? 'Você pode usar normalmente seus aparelhos do Motor local (Baileys).'
              : 'Os chips na nuvem não conectam aqui — ou pareie um aparelho em Conexões / Motor.'}
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
      {podeEditar && podeCriarAlgumChip && chips.length >= limite && (
        <p className="instancias-limite">
          Sua conta já usa todos os chips do plano. Para conectar outro número, remova um chip ou peça um limite maior.
        </p>
      )}

      {chips.length === 0 && !falhouAoCarregar ? (
        <div className="empty-state">
          Nenhum chip por aqui ainda. Adicione o primeiro para começar a receber as conversas no painel.
        </div>
      ) : (
        chips.map((chip) => {
          const podeEditarChip = podeEditar && (chip.motor === 'evolution' ? evolutionConfigurada : true);
          return (
            <CartaoDoChip
              key={chip.id}
              chip={chip}
              podeEditar={podeEditarChip}
              conexao={conexao?.chipId === chip.id ? conexao : null}
              recado={recados[chip.id] ?? null}
              ocupado={ocupado}
              aoPedirQr={() => pedirConexao(chip)}
              aoPedirCodigo={(numero) => pedirConexao(chip, numero)}
              aoFecharConexao={() => setConexao(null)}
              aoDesconectar={() => {
                if (conexao?.chipId === chip.id) setConexao(null);
                executar(`desconectar:${chip.id}`, chip, () => desconectarChip(chip.id), 'Chip desconectado.');
              }}
              aoEditar={() => setJanela({ tipo: 'editar', chip })}
              aoRemover={() => setJanela({ tipo: 'remover', chip })}
              ia={ia}
              aoMudarIa={(ligar) =>
                executar(
                  `ia:${chip.id}`,
                  chip,
                  () => mudarIaDoChip(chip.id, ligar),
                  ligar ? 'IA ligada neste chip.' : 'IA desligada neste chip.',
                )
              }
            />
          );
        })
      )}

      {janela?.tipo === 'novo' && (
        <Dialogo titulo="Adicionar chip" aoFechar={() => setJanela(null)}>
          <FormularioDoChip
            executores={executores}
            evolutionConfigurada={evolutionConfigurada}
            aoConcluir={aoCriar}
            aoCancelar={() => setJanela(null)}
          />
        </Dialogo>
      )}
      {janela?.tipo === 'editar' && (
        <Dialogo titulo="Editar chip" aoFechar={() => setJanela(null)}>
          <FormularioDoChip
            chip={janela.chip}
            executores={executores}
            evolutionConfigurada={evolutionConfigurada}
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
  ia: ResumoDaIa | null;
  aoMudarIa: (ligar: boolean) => void;
}

/** O que dizer embaixo do liga/desliga da IA de um chip. */
function situacaoDaIaNoChip(chip: Chip, ia: ResumoDaIa | null): string {
  if (chip.iaLigada) {
    if (ia?.pausada) return 'Ligado, mas a IA está pausada em todos os chips. Ela volta quando a pausa for retirada, no topo do painel.';
    if (chip.estado !== 'connected') return 'Ligado. A IA começa a responder quando o chip estiver conectado.';
    return 'A IA responde as mensagens que chegam neste chip e passa a conversa para você quando precisa.';
  }
  if (ia?.falta === 'chave') return 'Desligado. Para ligar, cadastre antes a chave do provedor principal no Motor de IA.';
  if (ia?.falta === 'treinamento') return 'Desligado. Para ligar, preencha antes o Treinamento: é de lá que a IA tira o que responder.';
  return 'Desligado: as mensagens deste chip chegam na Inbox, e só a equipe responde.';
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
  ia,
  aoMudarIa,
}: PropsDoCartao) {
  const idTitulo = useId();
  const idNumero = useId();
  const [numero, setNumero] = useState('');
  const [iaPedida, setIaPedida] = useState<boolean | null>(null);
  const estado = descreverEstado(chip.estado);
  const conectado = chip.estado === 'connected';
  const naNuvem = chip.motor === 'evolution';
  const noMotorLocal = chip.motor === 'baileys';
  const podeConectar = podeEditar && (naNuvem || noMotorLocal);
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
            {noMotorLocal && (
              <li>
                <span>
                  {chip.executorNome
                    ? `${chip.executorNome} (${chip.executorOnline ? 'online' : 'offline'})`
                    : 'Sem aparelho vinculado'}
                </span>
              </li>
            )}
          </ul>
        </div>

        {podeEditar && (
          <div className="chip-acoes">
            {conectado && (naNuvem || noMotorLocal) && (
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

      <div className="chip-ia">
        {podeEditar && (naNuvem || noMotorLocal) ? (
          <>
            <Interruptor
              titulo="Atendente de IA neste chip"
              descricao={situacaoDaIaNoChip(chip, ia)}
              ligado={ocupado === `ia:${chip.id}` && iaPedida !== null ? iaPedida : chip.iaLigada}
              desativado={trabalhando}
              aoMudar={(ligar) => {
                setIaPedida(ligar);
                aoMudarIa(ligar);
              }}
            />
            {!chip.iaLigada && ia?.falta && (
              <Link href={ia.falta === 'chave' ? '/inteligencia-artificial' : '/treinamento'} className="btn btn-secondary btn-sm chip-ia-atalho">
                {ia.falta === 'chave' ? 'Abrir o Motor de IA' : 'Abrir o Treinamento'}
              </Link>
            )}
          </>
        ) : (
          <p>
            Atendente de IA: {chip.iaLigada ? 'ligado' : 'desligado'} neste chip. Só o dono da conta liga e desliga.
          </p>
        )}
      </div>

      {recado && (
        <p className={`aviso ${recado.tipo === 'ok' ? 'aviso--ok' : 'aviso--erro'}`} role={recado.tipo === 'ok' ? 'status' : 'alert'}>
          {recado.texto}
        </p>
      )}

      {podeConectar && !conectado && (
        <div className="chip-conexao">
          {conexao ? (
            <div className="chip-qr">
              {conexao.imagem && !conexao.expirou && (
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
                ) : conexao.aguardandoMotor && !conexao.imagem ? (
                  <p className="chip-conexao-dica">
                    Solicitação enviada ao aparelho <strong>{chip.executorNome ?? 'local'}</strong>. Deixe o Motor local rodando
                    para o QR Code aparecer aqui em poucos segundos.
                  </p>
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

/** Formulário de apelido, motor e função. Sem `chip`, cria um chip novo; com `chip`, edita. */
function FormularioDoChip({
  chip,
  executores,
  evolutionConfigurada,
  aoConcluir,
  aoCancelar,
}: {
  chip?: Chip;
  executores: ExecutorResumo[];
  evolutionConfigurada: boolean;
  aoConcluir: (estado: EstadoDoFormulario) => void;
  aoCancelar: () => void;
}) {
  const idApelido = useId();
  const idExecutor = useId();
  const [motor, setMotor] = useState<'evolution' | 'baileys'>(
    chip ? (chip.motor === 'baileys' ? 'baileys' : 'evolution') : evolutionConfigurada ? 'evolution' : 'baileys',
  );
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

      {!chip && (
        <fieldset className="opcoes">
          <legend>Onde este chip vai rodar</legend>
          <label className="opcao">
            <input
              type="radio"
              name="motor"
              value="evolution"
              checked={motor === 'evolution'}
              disabled={!evolutionConfigurada}
              onChange={() => setMotor('evolution')}
            />
            <span>
              <strong>Nuvem (Evolution)</strong>
              <small>{evolutionConfigurada ? 'Roda direto nos servidores configurados do painel.' : 'Evolution não configurada neste ambiente.'}</small>
            </span>
          </label>
          <label className="opcao">
            <input
              type="radio"
              name="motor"
              value="baileys"
              checked={motor === 'baileys'}
              onChange={() => setMotor('baileys')}
            />
            <span>
              <strong>Motor local (Baileys)</strong>
              <small>Roda grátis no seu próprio PC, VPS ou celular (Termux).</small>
            </span>
          </label>
        </fieldset>
      )}

      {motor === 'baileys' && (
        <div className="form-group">
          <label className="form-label" htmlFor={idExecutor}>
            Aparelho do Motor local
          </label>
          {executores.length > 0 ? (
            <select
              id={idExecutor}
              name="executorId"
              className="campo"
              defaultValue={chip?.executorId ?? executores[0]?.id ?? ''}
              required
            >
              {executores.map((exec) => (
                <option key={exec.id} value={exec.id}>
                  {exec.nome} ({exec.online ? 'online' : exec.status === 'pending_pair' ? 'aguardando pareamento' : 'offline'})
                </option>
              ))}
            </select>
          ) : (
            <p className="aviso aviso--atencao">
              Nenhum aparelho pareado ainda.{' '}
              <Link href="/conexoes" style={{ textDecoration: 'underline', fontWeight: 700 }}>
                Abra Conexões / Motor
              </Link>{' '}
              para gerar um código de pareamento.
            </p>
          )}
        </div>
      )}

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
