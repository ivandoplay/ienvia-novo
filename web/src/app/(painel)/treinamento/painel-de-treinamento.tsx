'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { CampoDeTexto } from '@/components/ui/campo-de-texto';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import { Interruptor } from '@/components/ui/interruptor';
import { ATENDENTE_DE_IA_NO_AR } from '@/lib/ia/regras';
import {
  BASE_EM_BRANCO,
  EXTENSOES_DE_CONHECIMENTO,
  LIMITES_DO_TREINAMENTO,
  MODELOS_PRONTOS,
  TONS,
  aplicarModelo,
  camposDaBase,
  conferirArquivo,
  conferirBase,
  conferirRotulo,
  type BaseDeTreinamento,
  type CamposDaBase,
  type ListaDeBases,
  type ModeloPronto,
  type PerguntaSobreRobo,
  type Tom,
} from '@/lib/ia/treinamento';
import { dataCurta } from '@/lib/inbox/regras';
import { anexarArquivo, apagarArquivo, apagarBase, criarBase, definirBaseDoChip, salvarBase, tornarPadrao, verInstrucoes } from './acoes';

interface Props {
  lista: ListaDeBases | null;
  base: BaseDeTreinamento | null;
  falhouAoCarregar: boolean;
}

interface Recado {
  tipo: 'ok' | 'erro' | 'atencao';
  texto: string;
}

type Aba = 'identidade' | 'regras' | 'perguntas' | 'arquivos';

type Janela =
  | null
  | { tipo: 'modelos'; paraBaseNova: boolean }
  | { tipo: 'aplicar-modelo'; modelo: ModeloPronto }
  | { tipo: 'nova-base' }
  | { tipo: 'apagar-base' }
  | { tipo: 'apagar-arquivo'; id: string; titulo: string }
  | { tipo: 'instrucoes'; texto: string; letras: number };

const milhar = (valor: number) => valor.toLocaleString('pt-BR');
const iguais = (a: CamposDaBase, b: CamposDaBase) => JSON.stringify(a) === JSON.stringify(b);

export function PainelDeTreinamento({ lista: listaInicial, base: baseInicial, falhouAoCarregar }: Props) {
  const router = useRouter();
  const [lista, setLista] = useState<ListaDeBases | null>(listaInicial);
  const [base, setBase] = useState<BaseDeTreinamento | null>(baseInicial);
  const [rascunho, setRascunho] = useState<CamposDaBase>(baseInicial ? camposDaBase(baseInicial) : BASE_EM_BRANCO);
  const [aba, setAba] = useState<Aba>('identidade');
  const [recado, setRecado] = useState<Recado | null>(null);
  const [recadoDasBases, setRecadoDasBases] = useState<Recado | null>(null);
  const [recadoDosArquivos, setRecadoDosArquivos] = useState<Recado | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [janela, setJanela] = useState<Janela>(null);
  /** A base mudou em outro lugar depois que esta tela abriu: salvar daqui apagaria a mudança mais nova. */
  const [desatualizada, setDesatualizada] = useState(false);
  const campoDoArquivo = useRef<HTMLInputElement>(null);

  if (!lista) {
    return (
      <div className="treino">
        <Cabecalho />
        <p className="aviso aviso--erro" role="alert">
          {falhouAoCarregar ? 'Não foi possível carregar o treinamento agora. Atualize a página em instantes.' : 'O treinamento não está disponível para esta conta.'}
        </p>
      </div>
    );
  }

  const podeEditar = lista.podeEditar;
  const parado = ocupado !== null;

  /** Cria uma base (em branco ou a partir de um modelo) e abre a tela nela. */
  async function criar(rotulo: string, modelo: ModeloPronto | null): Promise<string | null> {
    setOcupado('criar');
    const resposta = await criarBase(rotulo, modelo?.id ?? null);
    setOcupado(null);
    if (!resposta.ok) return resposta.erro;
    setJanela(null);
    router.push(`/treinamento?base=${resposta.base.id}`);
    router.refresh();
    return null;
  }

  // ----- a conta ainda não tem nenhuma base -----
  if (!base) {
    return (
      <div className="treino">
        <Cabecalho />
        <Avisos podeEditar={podeEditar} />
        {falhouAoCarregar ? (
          <p className="aviso aviso--erro" role="alert">
            Não foi possível abrir esta base de treinamento agora. Atualize a página em instantes.
          </p>
        ) : (
          <section className="panel treino-comeco" aria-labelledby="treino-comeco">
            <h2 id="treino-comeco" className="panel-title">
              Comece o treinamento
            </h2>
            {podeEditar ? (
              <>
                <p className="panel-desc">
                  O treinamento é o que a IA sabe sobre o seu negócio: quem ela é, o que pode e o que não pode dizer, as respostas das
                  dúvidas de todo dia. Comece com um modelo do seu ramo e ajuste, ou comece em branco.
                </p>
                <div className="treino-comeco-acoes">
                  <button type="button" className="btn btn-primary" disabled={parado} onClick={() => setJanela({ tipo: 'modelos', paraBaseNova: true })}>
                    Começar com um modelo pronto
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={parado}
                    onClick={async () => {
                      const erro = await criar('Principal', null);
                      if (erro) setRecado({ tipo: 'erro', texto: erro });
                    }}
                  >
                    {ocupado === 'criar' ? 'Criando…' : 'Começar em branco'}
                  </button>
                </div>
                <div role="status">{recado && <p className={`aviso aviso--${recado.tipo}`}>{recado.texto}</p>}</div>
              </>
            ) : (
              <p className="panel-desc">O dono da conta ainda não começou o treinamento. Quando ele preencher, você verá aqui.</p>
            )}
          </section>
        )}
        {janela?.tipo === 'modelos' && (
          <JanelaDeModelos
            titulo="Começar com um modelo pronto"
            explicacao="Escolha o ramo mais parecido com o seu. O modelo já vem com identidade, regras e perguntas frequentes de exemplo: depois é só trocar pelos seus dados."
            ocupado={parado}
            aoFechar={() => setJanela(null)}
            aoEscolher={async (modelo) => {
              const erro = await criar('Principal', modelo);
              if (erro) {
                setJanela(null);
                setRecado({ tipo: 'erro', texto: erro });
              }
            }}
          />
        )}
      </div>
    );
  }

  // ----- com uma base aberta -----
  const gravado = camposDaBase(base);
  const mudou = !iguais(rascunho, gravado);
  const mudar = (mudancas: Partial<CamposDaBase>) => {
    setRascunho((atual) => ({ ...atual, ...mudancas }));
    setRecado(null);
  };
  const perguntasPreenchidas = rascunho.perguntas.filter((item) => item.pergunta.trim() || item.resposta.trim()).length;
  const letrasDosArquivos = base.arquivos.reduce((total, arquivo) => total + arquivo.letras, 0);
  const todosOsChips = lista.bases.flatMap((item) => item.chips.map((chip) => ({ ...chip, baseId: item.id, naPadrao: item.padrao })));

  async function salvar(evento: FormEvent) {
    evento.preventDefault();
    if (parado || !base) return;
    const conferida = conferirBase(rascunho);
    if (!conferida.ok) {
      setAba(conferida.aba);
      return setRecado({ tipo: 'erro', texto: conferida.erro });
    }
    setOcupado('salvar');
    setRecado(null);
    const resposta = await salvarBase(base.id, rascunho, base.revisao);
    setOcupado(null);
    if (!resposta.ok) {
      if (resposta.aba) setAba(resposta.aba);
      if (resposta.desatualizada) setDesatualizada(true);
      return setRecado({ tipo: 'erro', texto: resposta.erro });
    }
    setBase(resposta.base);
    setRascunho(camposDaBase(resposta.base));
    if (resposta.lista) setLista(resposta.lista);
    setRecado({ tipo: 'ok', texto: 'Treinamento salvo.' });
  }

  async function mostrarInstrucoes() {
    if (parado || !base) return;
    setOcupado('instrucoes');
    const resposta = await verInstrucoes(base.id);
    setOcupado(null);
    if (!resposta.ok) return setRecado({ tipo: 'erro', texto: resposta.erro });
    setJanela({ tipo: 'instrucoes', texto: resposta.instrucoes, letras: resposta.letras });
  }

  async function mudarPadrao() {
    if (parado || !base) return;
    setOcupado('padrao');
    setRecadoDasBases(null);
    const resposta = await tornarPadrao(base.id);
    setOcupado(null);
    if (!resposta.ok) return setRecadoDasBases({ tipo: 'erro', texto: resposta.erro });
    setLista(resposta.lista);
    setBase({ ...base, padrao: true });
    setRecadoDasBases({ tipo: 'ok', texto: `"${base.rotulo}" agora é a base padrão.` });
  }

  async function apagarEsta() {
    if (!base) return;
    setJanela(null);
    setOcupado('apagar-base');
    const resposta = await apagarBase(base.id);
    setOcupado(null);
    if (!resposta.ok) return setRecadoDasBases({ tipo: 'erro', texto: resposta.erro });
    router.push('/treinamento');
    router.refresh();
  }

  async function mudarBaseDoChip(chipId: string, baseId: string, ehAPadrao: boolean) {
    if (parado) return;
    setOcupado(`chip:${chipId}`);
    setRecadoDasBases(null);
    // Escolher a base padrão é o mesmo que "sem base própria": o chip acompanha a padrão, qualquer que ela seja.
    const resposta = await definirBaseDoChip(chipId, ehAPadrao ? null : baseId);
    setOcupado(null);
    if (!resposta.ok) return setRecadoDasBases({ tipo: 'erro', texto: resposta.erro });
    setLista(resposta.lista);
    setRecadoDasBases({ tipo: 'ok', texto: 'Base do chip alterada.' });
  }

  /**
   * Depois de anexar ou apagar um arquivo, a tela aproveita SÓ a lista de arquivos que o servidor devolveu.
   * Os campos, as perguntas e a revisão continuam sendo os que esta tela abriu: se a base mudou em outro
   * lugar nesse meio-tempo, quem tem de perceber é o "Salvar" (que confere a revisão), e não esta troca.
   */
  function aproveitarArquivos(nova: BaseDeTreinamento) {
    setBase((atual) => (atual && atual.id === nova.id ? { ...atual, arquivos: nova.arquivos, atualizadaEm: nova.atualizadaEm } : nova));
  }

  async function anexar() {
    const entrada = campoDoArquivo.current;
    const arquivo = entrada?.files?.[0];
    if (parado || !base) return;
    if (!arquivo) return setRecadoDosArquivos({ tipo: 'erro', texto: 'Escolha um arquivo primeiro.' });
    setRecadoDosArquivos(null);
    // Confere aqui antes de enviar, para a resposta ser imediata; o servidor confere de novo.
    if (arquivo.size <= 500_000) {
      const conferido = conferirArquivo(arquivo.name, new Uint8Array(await arquivo.arrayBuffer()));
      if (!conferido.ok) return setRecadoDosArquivos({ tipo: 'erro', texto: conferido.erro });
    }
    setOcupado('anexar');
    const formulario = new FormData();
    formulario.set('arquivo', arquivo);
    const resposta = await anexarArquivo(base.id, formulario);
    setOcupado(null);
    if (!resposta.ok) return setRecadoDosArquivos({ tipo: 'erro', texto: resposta.erro });
    aproveitarArquivos(resposta.base);
    if (resposta.lista) setLista(resposta.lista);
    if (entrada) entrada.value = '';
    setRecadoDosArquivos({ tipo: 'ok', texto: `Arquivo "${arquivo.name}" anexado.` });
  }

  async function removerArquivo(id: string, titulo: string) {
    setJanela(null);
    setOcupado(`arquivo:${id}`);
    setRecadoDosArquivos(null);
    const resposta = await apagarArquivo(id);
    setOcupado(null);
    if (!resposta.ok) return setRecadoDosArquivos({ tipo: 'erro', texto: resposta.erro });
    aproveitarArquivos(resposta.base);
    if (resposta.lista) setLista(resposta.lista);
    setRecadoDosArquivos({ tipo: 'ok', texto: `Arquivo "${titulo}" apagado.` });
  }

  const ABAS: Array<{ id: Aba; rotulo: string }> = [
    { id: 'identidade', rotulo: 'Identidade' },
    { id: 'regras', rotulo: 'Regras' },
    { id: 'perguntas', rotulo: `Perguntas frequentes${perguntasPreenchidas ? ` (${perguntasPreenchidas})` : ''}` },
    { id: 'arquivos', rotulo: `Arquivos${base.arquivos.length ? ` (${base.arquivos.length})` : ''}` },
  ];

  return (
    <div className="treino">
      <Cabecalho>
        <span className="estado estado--ok">{lista.bases.length === 1 ? '1 base de treinamento' : `${lista.bases.length} bases de treinamento`}</span>
      </Cabecalho>
      <Avisos podeEditar={podeEditar} />

      <section className="panel" aria-labelledby="treino-bases">
        <h2 id="treino-bases" className="panel-title">
          Bases de treinamento
        </h2>
        <p className="panel-desc">
          Uma base é um treinamento completo. A maioria das contas usa uma só. Se você tem chips com papéis diferentes (vendas e
          suporte, por exemplo), crie uma base para cada um. A base <strong>padrão</strong> vale para todo chip que não tem base própria.
        </p>
        <nav className="treino-bases" aria-label="Bases de treinamento">
          {lista.bases.map((item) => {
            const conteudo = (
              <>
                <strong>{item.rotulo}</strong>
                {item.padrao && <span className="treino-base-padrao">padrão</span>}
                <small>
                  {item.perguntas === 1 ? '1 pergunta' : `${item.perguntas} perguntas`} · {item.arquivos === 1 ? '1 arquivo' : `${item.arquivos} arquivos`}
                </small>
              </>
            );
            if (item.id === base.id) {
              return (
                <span key={item.id} className="treino-base treino-base--aberta" aria-current="page">
                  {conteudo}
                </span>
              );
            }
            // Com alterações por salvar, trocar de base jogaria fora o que foi digitado.
            return mudou ? (
              <span key={item.id} className="treino-base treino-base--travada" aria-disabled="true">
                {conteudo}
              </span>
            ) : (
              <Link key={item.id} href={`/treinamento?base=${item.id}`} className="treino-base">
                {conteudo}
              </Link>
            );
          })}
          {podeEditar && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={parado || mudou || lista.bases.length >= LIMITES_DO_TREINAMENTO.bases} onClick={() => setJanela({ tipo: 'nova-base' })}>
              Nova base
            </button>
          )}
        </nav>
        {mudou && lista.bases.length > 1 && <p className="campo-dica">Salve ou desfaça as alterações para abrir outra base.</p>}

        {podeEditar && !base.padrao && (
          <div className="treino-base-acoes">
            <button type="button" className="btn btn-secondary btn-sm" disabled={parado} onClick={() => void mudarPadrao()}>
              {ocupado === 'padrao' ? 'Alterando…' : `Tornar "${base.rotulo}" a base padrão`}
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={parado} onClick={() => setJanela({ tipo: 'apagar-base' })}>
              {ocupado === 'apagar-base' ? 'Apagando…' : 'Apagar esta base'}
            </button>
          </div>
        )}

        {todosOsChips.length > 0 && lista.bases.length > 1 && (
          <div className="treino-chips">
            <h3>Qual base cada chip usa</h3>
            <ul>
              {todosOsChips.map((chip) => (
                <li key={chip.id}>
                  <label htmlFor={`treino-chip-${chip.id}`}>{chip.nome}</label>
                  <select
                    id={`treino-chip-${chip.id}`}
                    className="campo"
                    disabled={!podeEditar || parado}
                    value={chip.baseId}
                    onChange={(evento) => {
                      const escolhida = lista.bases.find((item) => item.id === evento.target.value);
                      if (escolhida) void mudarBaseDoChip(chip.id, escolhida.id, escolhida.padrao);
                    }}
                  >
                    {lista.bases.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.rotulo}
                        {item.padrao ? ' (padrão)' : ''}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div role="status">{recadoDasBases && <p className={`aviso aviso--${recadoDasBases.tipo}`}>{recadoDasBases.texto}</p>}</div>
      </section>

      <div className="treino-ferramentas">
        {podeEditar && (
          <button type="button" className="btn btn-secondary" disabled={parado} onClick={() => setJanela({ tipo: 'modelos', paraBaseNova: false })}>
            Começar com um modelo pronto…
          </button>
        )}
        <button type="button" className="btn btn-secondary" disabled={parado || mudou} onClick={() => void mostrarInstrucoes()}>
          {ocupado === 'instrucoes' ? 'Montando…' : 'Ver instruções geradas'}
        </button>
        {mudou && <span className="campo-dica">Salve para ver as instruções com as alterações.</span>}
      </div>

      <form onSubmit={(evento) => void salvar(evento)} noValidate>
        <div className="subabas" role="tablist" aria-label="Partes do treinamento">
          {ABAS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`treino-aba-${item.id}`}
              aria-selected={aba === item.id}
              aria-controls={`treino-painel-${item.id}`}
              className={aba === item.id ? 'subaba subaba--ativa' : 'subaba'}
              onClick={() => setAba(item.id)}
            >
              {item.rotulo}
            </button>
          ))}
        </div>

        <section className="panel" role="tabpanel" id="treino-painel-identidade" aria-labelledby="treino-aba-identidade" hidden={aba !== 'identidade'}>
          <h2 className="panel-title">Identidade de atendimento</h2>
          <div className="lista-de-interruptores">
            <Interruptor
              titulo="Atuação individual, em 1ª pessoa (sem empresa e sem equipe)"
              descricao="Ligue quando o WhatsApp é seu, pessoalmente (consultor, corretor, médico, especialista). O atendimento fala sempre como “eu / meu trabalho”, sem citar empresa nem equipe e sem dizer que vai passar para outra pessoa."
              ligado={rascunho.primeiraPessoa}
              desativado={!podeEditar}
              aoMudar={(primeiraPessoa) => mudar({ primeiraPessoa })}
            />
          </div>
          <div className="grade-de-campos">
            <CampoDeTexto
              rotulo={rascunho.primeiraPessoa ? 'Seu nome profissional' : 'Nome da empresa ou do profissional'}
              valor={rascunho.nomeDoNegocio}
              limite={LIMITES_DO_TREINAMENTO.nomeDoNegocio}
              exemplo="Ex.: Flor de Sal Moda"
              desativado={!podeEditar}
              aoMudar={(nomeDoNegocio) => mudar({ nomeDoNegocio })}
            />
            <CampoDeTexto
              rotulo={rascunho.primeiraPessoa ? 'Como você assina as mensagens' : 'Nome de quem atende no WhatsApp'}
              valor={rascunho.nomeDoAtendente}
              limite={LIMITES_DO_TREINAMENTO.nomeDoAtendente}
              exemplo="Ex.: Clara"
              desativado={!podeEditar}
              aoMudar={(nomeDoAtendente) => mudar({ nomeDoAtendente })}
            />
            <CampoDeTexto
              rotulo="Nicho ou área de atuação"
              valor={rascunho.nicho}
              limite={LIMITES_DO_TREINAMENTO.nicho}
              exemplo="Ex.: Moda feminina"
              desativado={!podeEditar}
              aoMudar={(nicho) => mudar({ nicho })}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="treino-tom">
              Tom de voz nas conversas
            </label>
            <select id="treino-tom" className="campo" disabled={!podeEditar} value={rascunho.tom} onChange={(evento) => mudar({ tom: evento.target.value as Tom })}>
              {TONS.map((tom) => (
                <option key={tom.valor} value={tom.valor}>
                  {tom.rotulo}
                </option>
              ))}
            </select>
          </div>
          <CampoDeTexto
            rotulo="Sobre o trabalho e diferenciais"
            valor={rascunho.resumo}
            limite={LIMITES_DO_TREINAMENTO.resumo}
            exemplo="Descreva o que você vende ou como trabalha, a região e os principais diferenciais."
            linhas={4}
            desativado={!podeEditar}
            aoMudar={(resumo) => mudar({ resumo })}
          />
          <CampoDeTexto
            rotulo="Pagamentos, entrega, endereço e horários"
            valor={rascunho.condicoes}
            limite={LIMITES_DO_TREINAMENTO.condicoes}
            exemplo="Condições comerciais, horários de funcionamento e políticas."
            linhas={4}
            desativado={!podeEditar}
            aoMudar={(condicoes) => mudar({ condicoes })}
          />
          <CampoDeTexto
            rotulo="Nome desta base de treinamento"
            valor={rascunho.rotulo}
            limite={LIMITES_DO_TREINAMENTO.rotulo}
            exemplo="Ex.: Principal"
            dica="Só aparece aqui no painel, para você reconhecer a base. O cliente não vê."
            desativado={!podeEditar}
            aoMudar={(rotulo) => mudar({ rotulo })}
          />
        </section>

        <section className="panel" role="tabpanel" id="treino-painel-regras" aria-labelledby="treino-aba-regras" hidden={aba !== 'regras'}>
          <h2 className="panel-title">Regras de atendimento e blindagem</h2>
          <CampoDeTexto
            rotulo="Regras de ouro (o que fazer e o que nunca inventar)"
            valor={rascunho.regras}
            limite={LIMITES_DO_TREINAMENTO.regras}
            exemplo="- Nunca invente preços fora da tabela…"
            linhas={8}
            desativado={!podeEditar}
            aoMudar={(regras) => mudar({ regras })}
          />
          <CampoDeTexto
            rotulo="Instruções extras e observações finais"
            valor={rascunho.instrucoesExtras}
            limite={LIMITES_DO_TREINAMENTO.instrucoesExtras}
            exemplo="Instruções complementares de postura."
            linhas={3}
            desativado={!podeEditar}
            aoMudar={(instrucoesExtras) => mudar({ instrucoesExtras })}
          />
          <div className="lista-de-interruptores">
            <Interruptor
              titulo="Blindagem contra tentativas de manipular a IA"
              descricao="Reforça nas instruções que a IA não revela as regras internas nem obedece a quem tenta mudar o papel dela ou forçar descontos (“o administrador autorizou”)."
              ligado={rascunho.blindagem}
              desativado={!podeEditar}
              aoMudar={(blindagem) => mudar({ blindagem })}
            />
            <Interruptor
              titulo="Trava permanente depois de passar para uma pessoa"
              descricao="Depois que a IA passa a conversa para você (ou entra em pausa silenciosa), um “ok” do contato não reabre o atendimento automático: a IA só volta quando você mandar."
              ligado={rascunho.travaAteRetomar}
              desativado={!podeEditar}
              aoMudar={(travaAteRetomar) => mudar({ travaAteRetomar })}
            />
          </div>
          <fieldset className="opcoes" disabled={!podeEditar}>
            <legend>Quando o contato perguntar se está falando com um robô</legend>
            {(
              [
                ['handoff', 'Passar a conversa para uma pessoa', 'A IA não responde a pergunta: avisa você, e você assume a conversa.'],
                ['disclose', 'Dizer que é a assistente virtual', 'A IA conta, em uma frase, que é a assistente virtual do negócio, e continua ajudando.'],
              ] as Array<[PerguntaSobreRobo, string, string]>
            ).map(([valor, titulo, explicacao]) => (
              <label key={valor} className="opcao">
                <input type="radio" name="pergunta-sobre-robo" checked={rascunho.perguntaSobreRobo === valor} onChange={() => mudar({ perguntaSobreRobo: valor })} />
                <span>
                  <strong>{titulo}</strong>
                  <small>{explicacao}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="campo-dica">Em nenhuma das duas opções a IA afirma ser uma pessoa: quando perguntam, ela não mente.</p>
        </section>

        <section className="panel" role="tabpanel" id="treino-painel-perguntas" aria-labelledby="treino-aba-perguntas" hidden={aba !== 'perguntas'}>
          <h2 className="panel-title">Perguntas frequentes</h2>
          <p className="panel-desc">Cadastre as respostas exatas das dúvidas que os seus clientes fazem todo dia. A IA usa estas respostas antes de qualquer outra coisa.</p>
          {podeEditar && (
            <p className="campo-dica treino-dica-da-inbox">
              Dá para guardar uma resposta sem sair da conversa: na <Link href="/inbox">Inbox</Link>, use “Corrigir resposta” numa resposta da IA ou “Ensinar à IA” numa
              resposta sua. O que for guardado aparece aqui, no topo da lista.
            </p>
          )}
          {rascunho.perguntas.length === 0 && <p className="treino-vazio">Nenhuma pergunta cadastrada ainda.</p>}
          <ol className="treino-perguntas">
            {rascunho.perguntas.map((item, indice) => (
              <li key={indice}>
                <div className="treino-pergunta-campos">
                  <CampoDeTexto
                    rotulo={`Pergunta ${indice + 1}`}
                    valor={item.pergunta}
                    limite={LIMITES_DO_TREINAMENTO.pergunta}
                    exemplo="Ex.: Vocês entregam?"
                    desativado={!podeEditar}
                    aoMudar={(pergunta) => mudar({ perguntas: rascunho.perguntas.map((outra, posicao) => (posicao === indice ? { ...outra, pergunta } : outra)) })}
                  />
                  <CampoDeTexto
                    rotulo={`Resposta ${indice + 1}`}
                    valor={item.resposta}
                    limite={LIMITES_DO_TREINAMENTO.resposta}
                    exemplo="Ex.: Sim, entregamos na cidade toda."
                    linhas={2}
                    desativado={!podeEditar}
                    aoMudar={(resposta) => mudar({ perguntas: rascunho.perguntas.map((outra, posicao) => (posicao === indice ? { ...outra, resposta } : outra)) })}
                  />
                  {item.origem === 'correction' && <p className="campo-dica treino-pergunta-origem">Veio de uma resposta ensinada pela Inbox.</p>}
                </div>
                {podeEditar && (
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => mudar({ perguntas: rascunho.perguntas.filter((_, posicao) => posicao !== indice) })}>
                    Remover<span className="so-leitor-de-tela"> a pergunta {indice + 1}</span>
                  </button>
                )}
              </li>
            ))}
          </ol>
          {podeEditar && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={rascunho.perguntas.length >= LIMITES_DO_TREINAMENTO.perguntasPorBase}
              onClick={() => mudar({ perguntas: [...rascunho.perguntas, { pergunta: '', resposta: '', origem: 'manual' }] })}
            >
              Adicionar pergunta
            </button>
          )}
          <p className="campo-dica">
            {rascunho.perguntas.length} de {LIMITES_DO_TREINAMENTO.perguntasPorBase} perguntas.
          </p>
        </section>

        {podeEditar && aba !== 'arquivos' && (
          <div className="barra-de-salvar">
            <div className="barra-de-salvar-recado" role="status">
              {recado ? (
                <span className={`recado--${recado.tipo}`}>{recado.texto}</span>
              ) : desatualizada ? (
                <span className="recado--erro">Esta base foi alterada em outro lugar. Recarregue a página antes de salvar.</span>
              ) : mudou ? (
                <span className="recado--atencao">Há alterações que ainda não foram salvas.</span>
              ) : null}
            </div>
            <div className="barra-de-salvar-acoes">
              {desatualizada ? (
                // Salvar daqui apagaria o que mudou em outro lugar: o caminho é recarregar e refazer.
                <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                  Recarregar a página
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!mudou || parado}
                    onClick={() => {
                      setRascunho(gravado);
                      setRecado(null);
                    }}
                  >
                    Desfazer
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={!mudou || parado}>
                    {ocupado === 'salvar' ? 'Salvando…' : 'Salvar treinamento'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </form>

      <section className="panel" role="tabpanel" id="treino-painel-arquivos" aria-labelledby="treino-aba-arquivos" hidden={aba !== 'arquivos'}>
        <h2 className="panel-title">Arquivos de conhecimento</h2>
        <p className="panel-desc">
          Tabelas de preços, manuais ou políticas em texto ({EXTENSOES_DE_CONHECIMENTO.join(', ')}) para a IA consultar durante o atendimento. A IA
          lê o arquivo inteiro a cada resposta: por isso só cabe texto, e um arquivo grande demais é recusado em vez de entrar cortado.
        </p>
        {podeEditar && (
          <div className="treino-anexar">
            <label className="form-label" htmlFor="treino-arquivo">
              Arquivo para anexar
            </label>
            <div className="linha-de-campo">
              <input
                ref={campoDoArquivo}
                id="treino-arquivo"
                className="campo"
                type="file"
                accept=".txt,.csv,.md,.json,text/plain,text/csv,text/markdown,application/json"
                disabled={parado || base.arquivos.length >= LIMITES_DO_TREINAMENTO.arquivosPorBase}
                onChange={() => setRecadoDosArquivos(null)}
              />
              <button type="button" className="btn btn-secondary" disabled={parado || base.arquivos.length >= LIMITES_DO_TREINAMENTO.arquivosPorBase} onClick={() => void anexar()}>
                {ocupado === 'anexar' ? 'Anexando…' : 'Anexar arquivo'}
              </button>
            </div>
            <p className="campo-dica">O arquivo é guardado na hora (não depende do botão “Salvar treinamento”).</p>
          </div>
        )}
        <div role="status">{recadoDosArquivos && <p className={`aviso aviso--${recadoDosArquivos.tipo}`}>{recadoDosArquivos.texto}</p>}</div>

        {base.arquivos.length === 0 ? (
          <p className="treino-vazio">Nenhum arquivo anexado.</p>
        ) : (
          <ul className="treino-arquivos" aria-label="Arquivos anexados">
            {base.arquivos.map((arquivo) => (
              <li key={arquivo.id}>
                <Icone nome="lista" className="icon-15" />
                <span className="treino-arquivo-nome">{arquivo.titulo}</span>
                <small>
                  {milhar(arquivo.letras)} caracteres{arquivo.criadoEm ? ` · ${dataCurta(arquivo.criadoEm)}` : ''}
                </small>
                {podeEditar && (
                  <button type="button" className="btn btn-danger btn-sm" disabled={parado} onClick={() => setJanela({ tipo: 'apagar-arquivo', id: arquivo.id, titulo: arquivo.titulo })}>
                    {ocupado === `arquivo:${arquivo.id}` ? 'Apagando…' : 'Apagar'}
                    <span className="so-leitor-de-tela"> o arquivo {arquivo.titulo}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="campo-dica">
          {base.arquivos.length} de {LIMITES_DO_TREINAMENTO.arquivosPorBase} arquivos · {milhar(letrasDosArquivos)} de {milhar(LIMITES_DO_TREINAMENTO.letrasPorBase)}{' '}
          caracteres nesta base.
        </p>
      </section>

      <section className="panel treino-falta" aria-labelledby="treino-falta">
        <h2 id="treino-falta" className="panel-title">
          Ainda em reconstrução nesta aba
        </h2>
        <p className="panel-desc">
          Mensagens prontas (as antigas M01–M13), Estúdio de Skills, “Cérebro completo” e “Pacote Turbo” existem no sistema antigo e ainda não foram
          refeitos aqui. Eles não aparecem nesta tela para não parecer que funcionam.
        </p>
      </section>

      {janela?.tipo === 'modelos' && (
        <JanelaDeModelos
          titulo="Começar com um modelo pronto"
          explicacao={`O modelo troca os textos da base "${base.rotulo}" (identidade, regras e perguntas frequentes). Os arquivos anexados continuam. Nada é gravado até você clicar em "Salvar treinamento".`}
          ocupado={parado}
          aoFechar={() => setJanela(null)}
          aoEscolher={(modelo) => setJanela({ tipo: 'aplicar-modelo', modelo })}
        />
      )}
      {janela?.tipo === 'aplicar-modelo' && (
        <Dialogo titulo="Usar este modelo?" aoFechar={() => setJanela(null)}>
          <p className="dialogo-texto">
            O modelo <strong>{janela.modelo.nome}</strong> vai substituir os textos que estão na tela (identidade, regras e perguntas frequentes) da base{' '}
            <strong>{base.rotulo}</strong>. Você ainda poderá conferir e desfazer antes de salvar.
          </p>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setJanela(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setRascunho((atual) => aplicarModelo(atual, janela.modelo));
                setAba('identidade');
                setRecado({ tipo: 'atencao', texto: `Modelo "${janela.modelo.nome}" aplicado na tela. Confira e salve.` });
                setJanela(null);
              }}
            >
              Usar o modelo
            </button>
          </div>
        </Dialogo>
      )}
      {janela?.tipo === 'nova-base' && (
        <Dialogo titulo="Nova base de treinamento" aoFechar={() => setJanela(null)}>
          <FormularioDeNovaBase ocupado={parado} aoCancelar={() => setJanela(null)} aoCriar={(rotulo) => criar(rotulo, null)} />
        </Dialogo>
      )}
      {janela?.tipo === 'apagar-base' && (
        <Dialogo titulo="Apagar base de treinamento" aoFechar={() => setJanela(null)}>
          <p className="dialogo-texto">
            A base <strong>{base.rotulo}</strong> será apagada, com as perguntas frequentes e os arquivos dela. Os chips que usam esta base passam a usar a
            base padrão. Isto não pode ser desfeito.
          </p>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setJanela(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void apagarEsta()}>
              Apagar a base
            </button>
          </div>
        </Dialogo>
      )}
      {janela?.tipo === 'apagar-arquivo' && (
        <Dialogo titulo="Apagar arquivo" aoFechar={() => setJanela(null)}>
          <p className="dialogo-texto">
            O arquivo <strong>{janela.titulo}</strong> será apagado desta base, e a IA deixa de consultá-lo. O arquivo original no seu computador não é afetado.
          </p>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setJanela(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void removerArquivo(janela.id, janela.titulo)}>
              Apagar o arquivo
            </button>
          </div>
        </Dialogo>
      )}
      {janela?.tipo === 'instrucoes' && (
        <Dialogo titulo="Instruções geradas" aoFechar={() => setJanela(null)} largo>
          <p className="dialogo-texto">
            É este o texto que a IA recebe a cada conversa com a base <strong>{base.rotulo}</strong>, do jeito que ela está gravada (a data e o nome do contato
            mudam a cada conversa). São {milhar(janela.letras)} caracteres.
          </p>
          <pre className="treino-instrucoes" tabIndex={0} aria-label="Texto das instruções">
            {janela.texto}
          </pre>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setJanela(null)}>
              Fechar
            </button>
          </div>
        </Dialogo>
      )}
    </div>
  );
}

function Cabecalho({ children }: { children?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>Treinamento</h1>
        <p>Ensine o atendente: quem ele é, o que pode e o que não pode dizer, as respostas das dúvidas de todo dia e os arquivos de consulta.</p>
      </div>
      {children}
    </div>
  );
}

function Avisos({ podeEditar }: { podeEditar: boolean }) {
  return (
    <div className="pilha-de-avisos">
      {!ATENDENTE_DE_IA_NO_AR && (
        <p className="aviso aviso--atencao">
          <strong>A IA ainda não responde no WhatsApp.</strong> O treinamento que você fizer aqui fica guardado e já pode ser conferido em “Ver instruções
          geradas”, mas a parte que lê as mensagens dos clientes e responde sozinha ainda está sendo reconstruída.
        </p>
      )}
      {ATENDENTE_DE_IA_NO_AR && (
        <p className="aviso">
          A IA usa este treinamento nas conversas dos chips que estão com ela ligada (aba <Link href="/instancias">Instâncias</Link>). O que você salvar
          aqui já vale na próxima resposta.
        </p>
      )}
      {!podeEditar && <p className="aviso">Só o dono da conta altera o treinamento. Você pode ver como ele está.</p>}
    </div>
  );
}

function JanelaDeModelos({
  titulo,
  explicacao,
  ocupado,
  aoFechar,
  aoEscolher,
}: {
  titulo: string;
  explicacao: string;
  ocupado: boolean;
  aoFechar: () => void;
  aoEscolher: (modelo: ModeloPronto) => void;
}) {
  return (
    <Dialogo titulo={titulo} aoFechar={aoFechar} largo>
      <p className="dialogo-texto">{explicacao}</p>
      <ul className="treino-modelos">
        {MODELOS_PRONTOS.map((modelo) => (
          <li key={modelo.id}>
            <button type="button" className="treino-modelo" disabled={ocupado} onClick={() => aoEscolher(modelo)}>
              <span className="treino-modelo-icone" aria-hidden="true">
                {modelo.icone}
              </span>
              <span>
                <strong>{modelo.nome}</strong>
                <small>{modelo.descricao}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="dialogo-acoes">
        <button type="button" className="btn btn-secondary" onClick={aoFechar}>
          Cancelar
        </button>
      </div>
    </Dialogo>
  );
}

function FormularioDeNovaBase({ ocupado, aoCancelar, aoCriar }: { ocupado: boolean; aoCancelar: () => void; aoCriar: (rotulo: string) => Promise<string | null> }) {
  const [rotulo, setRotulo] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (ocupado) return;
    const conferido = conferirRotulo(rotulo);
    if (!conferido.ok) return setErro(conferido.erro);
    setErro(null);
    const problema = await aoCriar(conferido.rotulo);
    if (problema) setErro(problema);
  }

  return (
    <form onSubmit={(evento) => void enviar(evento)} noValidate>
      <p className="dialogo-texto">A base nova começa em branco. Depois de criada, escolha quais chips usam esta base.</p>
      <div className="form-group">
        <label className="form-label" htmlFor="treino-nova-base">
          Nome da base
        </label>
        <input
          id="treino-nova-base"
          className="campo"
          type="text"
          maxLength={LIMITES_DO_TREINAMENTO.rotulo}
          placeholder="Ex.: Suporte"
          value={rotulo}
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? 'treino-nova-base-erro' : undefined}
          onChange={(evento) => {
            setRotulo(evento.target.value);
            setErro(null);
          }}
        />
      </div>
      {erro && (
        <p id="treino-nova-base-erro" className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}
      <div className="dialogo-acoes">
        <button type="button" className="btn btn-secondary" onClick={aoCancelar} disabled={ocupado}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={ocupado}>
          {ocupado ? 'Criando…' : 'Criar base'}
        </button>
      </div>
    </form>
  );
}
