'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { Dialogo } from '@/components/ui/dialogo';
import { Icone } from '@/components/ui/icone';
import { Interruptor } from '@/components/ui/interruptor';
import { dataCurta } from '@/lib/inbox/regras';
import type { ModeloDisponivel } from '@/lib/ia/provedores';
import {
  ATENDENTE_DE_IA_NO_AR,
  CAMPO_DO_MODELO,
  EVENTOS_DO_ALERTA_DO_ADMIN,
  NOME_DO_PROVEDOR,
  PADRAO_DO_MOTOR,
  PROVEDORES,
  arrumarOrdem,
  conferirChave,
  doProvedor,
  situacaoDoMotor,
  whatsappSomenteDigitos,
  type ConfiguracaoDoMotor,
  type EventoDeAlertaDoAdmin,
  type MotorDeIa,
  type Provedor,
  type Reserva,
} from '@/lib/ia/regras';
import { buscarModelos, enviarDossieDeTeste, guardarChave, removerChave, salvarMotor, testarProvedor } from './acoes';

interface ChipParaTeste {
  id: string;
  apelido: string;
  telefone: string | null;
}

interface Props {
  motor: MotorDeIa | null;
  falhouAoCarregar: boolean;
  /** O servidor tem o segredo que protege as chaves? Sem ele não dá para guardar chave nenhuma. */
  cofreConfigurado: boolean;
  chipsConectados?: ChipParaTeste[];
}

interface Recado {
  tipo: 'ok' | 'erro' | 'atencao';
  texto: string;
}

type Janela = { tipo: 'chave'; provedor: Provedor } | { tipo: 'remover'; provedor: Provedor } | null;

interface SobreOProvedor {
  resumo: string;
  ondeConseguir: string;
  exemploDeModelo: string;
  /** A dica que fica embaixo do campo do modelo. */
  sobreOsModelos: string;
  /** A lista de modelos é pública (dá para ver sem chave)? */
  listaPublica: boolean;
}

const SOBRE_O_PROVEDOR: Record<Provedor, SobreOProvedor> = {
  gemini: {
    resumo: 'Entende texto, foto e áudio. O Google oferece um plano gratuito com limite de uso.',
    ondeConseguir: 'https://aistudio.google.com/apikey',
    exemploDeModelo: 'gemini-3.5-flash-lite',
    sobreOsModelos: 'Os modelos “flash-lite” são os mais rápidos e baratos, e dão conta do atendimento do dia a dia.',
    listaPublica: false,
  },
  openrouter: {
    resumo:
      'Dá acesso a centenas de modelos de várias empresas com uma chave só. Entende texto, e foto quando o modelo escolhido enxerga; não escuta áudio.',
    ondeConseguir: 'https://openrouter.ai/keys',
    exemploDeModelo: 'deepseek/deepseek-chat',
    sobreOsModelos: 'Modelos marcados como gratuitos têm limite de uso por dia e podem ficar lentos em horário de pico.',
    listaPublica: true,
  },
  nvidia: {
    resumo:
      'Gratuito, com limite de pedidos por minuto. A NVIDIA oferece este acesso para testes e pode mudar as regras sem aviso: vale ter outro provedor de reserva. Entende texto, e foto quando o modelo escolhido enxerga; não escuta áudio.',
    ondeConseguir: 'https://build.nvidia.com/settings/api-keys',
    exemploDeModelo: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    sobreOsModelos:
      'A NVIDIA troca os modelos com frequência, alguns demoram e nem todo modelo da lista está liberado para toda conta. Depois de escolher, use “Testar conexão”.',
    listaPublica: true,
  },
};

/** "a NVIDIA", "o OpenRouter", "o Google Gemini". */
const oProvedor = (provedor: Provedor) => `${provedor === 'nvidia' ? 'a' : 'o'} ${NOME_DO_PROVEDOR[provedor]}`;

/** Até 20 segundos: a espera, a resposta do provedor e o envio precisam caber num único pedido ao servidor. */
const ESPERAS = [3, 6, 10, 15, 20];
const MEMORIAS = [10, 20, 30, 40, 60];
const PAUSAS = [
  { minutos: 30, rotulo: '30 minutos' },
  { minutos: 60, rotulo: '1 hora' },
  { minutos: 120, rotulo: '2 horas' },
  { minutos: 240, rotulo: '4 horas' },
  { minutos: 720, rotulo: '12 horas' },
  { minutos: 1440, rotulo: '24 horas' },
];

/** Garante que o valor gravado aparece na lista, mesmo que não seja uma das opções prontas. */
const comValorAtual = (opcoes: number[], atual: number) => (opcoes.includes(atual) ? opcoes : [...opcoes, atual].sort((a, b) => a - b));

function rotuloDaCriatividade(valor: number): string {
  if (valor <= 0.2) return 'bem fiel ao treinamento';
  if (valor <= 0.5) return 'equilibrada';
  if (valor <= 0.75) return 'mais solta';
  return 'bem criativa (pode inventar)';
}

const iguais = (a: ConfiguracaoDoMotor, b: ConfiguracaoDoMotor) => JSON.stringify(a) === JSON.stringify(b);

export function PainelDoMotor({ motor: motorInicial, falhouAoCarregar, cofreConfigurado, chipsConectados = [] }: Props) {
  const [motor, setMotor] = useState<MotorDeIa | null>(motorInicial);
  const [rascunho, setRascunho] = useState<ConfiguracaoDoMotor>(motorInicial?.configuracao ?? PADRAO_DO_MOTOR);
  const [recado, setRecado] = useState<Recado | null>(null);
  const [recadoDossie, setRecadoDossie] = useState<Recado | null>(null);
  const [chipTesteId, setChipTesteId] = useState<string>(chipsConectados[0]?.id ?? '');
  const [recadosDoProvedor, setRecadosDoProvedor] = useState<Partial<Record<Provedor, Recado>>>({});
  const [modelos, setModelos] = useState<Partial<Record<Provedor, ModeloDisponivel[]>>>({});
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [janela, setJanela] = useState<Janela>(null);
  const idCriatividade = useId();

  if (!motor) {
    return (
      <div className="motor">
        <Cabecalho />
        <p className="aviso aviso--erro" role="alert">
          {falhouAoCarregar
            ? 'Não foi possível carregar o Motor de IA agora. Atualize a página em instantes.'
            : 'O Motor de IA não está disponível para esta conta.'}
        </p>
      </div>
    );
  }

  const podeEditar = motor.podeEditar;
  const mudou = !iguais(rascunho, motor.configuracao);
  const situacao = situacaoDoMotor({ configuracao: rascunho, chaves: motor.chaves });
  const mudar = (mudancas: Partial<ConfiguracaoDoMotor>) => {
    setRascunho((atual) => ({ ...atual, ...mudancas }));
    setRecado(null);
  };
  const avisarProvedor = (provedor: Provedor, novo: Recado | null) =>
    setRecadosDoProvedor((atuais) => {
      const proximos = { ...atuais };
      if (novo) proximos[provedor] = novo;
      else delete proximos[provedor];
      return proximos;
    });
  const modeloDe = (provedor: Provedor) => rascunho[CAMPO_DO_MODELO[provedor]];
  const mudarModelo = (provedor: Provedor, modelo: string) => mudar({ [CAMPO_DO_MODELO[provedor]]: modelo });
  /** Muda a ordem de uso sem deixar ninguém repetido (quem sobe de posto sai do posto antigo). */
  const mudarOrdem = (mudancas: Partial<Pick<ConfiguracaoDoMotor, 'provedor' | 'reserva' | 'segundaReserva'>>) =>
    mudar(arrumarOrdem({ provedor: rascunho.provedor, reserva: rascunho.reserva, segundaReserva: rascunho.segundaReserva, ...mudancas }));
  const reservasPossiveis = PROVEDORES.filter((provedor) => provedor !== rascunho.provedor);
  const segundasPossiveis = reservasPossiveis.filter((provedor) => provedor !== rascunho.reserva);

  /** Depois de uma ação que devolve o Motor atualizado: fica com as chaves novas sem perder o que está sendo editado. */
  const receberMotor = (novo: MotorDeIa, manterRascunho: boolean) => {
    setMotor(novo);
    if (!manterRascunho) setRascunho(novo.configuracao);
  };

  async function salvar(evento: FormEvent) {
    evento.preventDefault();
    if (ocupado) return;
    setOcupado('salvar');
    setRecado(null);
    const resposta = await salvarMotor(rascunho);
    setOcupado(null);
    if (!resposta.ok) return setRecado({ tipo: 'erro', texto: resposta.erro });
    receberMotor(resposta.motor, false);
    setRecado({ tipo: 'ok', texto: 'Alterações salvas.' });
  }

  async function testar(provedor: Provedor) {
    if (ocupado) return;
    setOcupado(`testar:${provedor}`);
    avisarProvedor(provedor, null);
    const resposta = await testarProvedor(provedor, modeloDe(provedor).trim());
    setOcupado(null);
    if (!resposta.ok) return avisarProvedor(provedor, { tipo: 'erro', texto: resposta.erro });
    avisarProvedor(provedor, { tipo: resposta.teste.funcionou ? 'ok' : 'erro', texto: resposta.teste.texto });
  }

  async function verModelos(provedor: Provedor) {
    if (ocupado) return;
    setOcupado(`modelos:${provedor}`);
    avisarProvedor(provedor, null);
    const resposta = await buscarModelos(provedor);
    setOcupado(null);
    if (!resposta.ok) return avisarProvedor(provedor, { tipo: 'erro', texto: resposta.erro });
    setModelos((atuais) => ({ ...atuais, [provedor]: resposta.modelos }));
    if (resposta.modelos.length === 0) avisarProvedor(provedor, { tipo: 'atencao', texto: 'O provedor não devolveu nenhum modelo de conversa para esta chave.' });
  }

  async function remover(provedor: Provedor) {
    setJanela(null);
    setOcupado(`remover:${provedor}`);
    const resposta = await removerChave(provedor);
    setOcupado(null);
    if (!resposta.ok) return avisarProvedor(provedor, { tipo: 'erro', texto: resposta.erro });
    receberMotor(resposta.motor, true);
    setModelos((atuais) => ({ ...atuais, [provedor]: undefined }));
    avisarProvedor(provedor, { tipo: 'ok', texto: 'Chave removida.' });
  }

  function alternarEventoDossie(evento: EventoDeAlertaDoAdmin) {
    const atuais = rascunho.alertaAdminEventos;
    const proximos = atuais.includes(evento) ? atuais.filter((e) => e !== evento) : [...atuais, evento];
    mudar({ alertaAdminEventos: proximos });
  }

  async function dispararTesteDossie() {
    if (ocupado) return;
    setOcupado('dossie-teste');
    setRecadoDossie(null);
    const resposta = await enviarDossieDeTeste(rascunho.alertaAdminWhatsapp, chipTesteId || undefined);
    setOcupado(null);
    if (!resposta.ok) return setRecadoDossie({ tipo: 'erro', texto: resposta.erro });
    setRecadoDossie({ tipo: 'ok', texto: resposta.mensagem });
  }

  return (
    <div className="motor">
      <Cabecalho>
        <span className={situacao.pronta ? 'estado estado--ok' : 'estado estado--atencao'}>
          {situacao.pronta ? 'Pronto para responder' : 'Falta a chave'}
        </span>
      </Cabecalho>

      <div className="motor-avisos">
        {!ATENDENTE_DE_IA_NO_AR && (
          <p className="aviso aviso--atencao">
            <strong>A IA ainda não responde no WhatsApp.</strong> Esta tela já guarda e testa as suas chaves e ajustes, mas a parte que
            lê as mensagens dos clientes e responde sozinha ainda está sendo reconstruída. Nada do que está aqui envia mensagens por
            enquanto.
          </p>
        )}
        {ATENDENTE_DE_IA_NO_AR && (
          <p className="aviso">
            O que está aqui vale para as conversas dos chips que estão com a IA ligada. Para ligar ou desligar a IA em um chip, use a aba{' '}
            <Link href="/instancias">Instâncias</Link>.
          </p>
        )}
        {!podeEditar && <p className="aviso">Só o dono da conta altera o Motor de IA. Você pode ver como ele está configurado.</p>}
        {podeEditar && !cofreConfigurado && (
          <p className="aviso aviso--erro" role="alert">
            Este ambiente ainda não tem o segredo que protege as chaves, por isso não é possível cadastrar nem testar chaves aqui. Isso
            se resolve na configuração do servidor, não nesta tela.
          </p>
        )}
        {situacao.faltas.map((falta) => (
          <p key={falta} className="aviso aviso--atencao">
            {falta}
          </p>
        ))}
      </div>

      <section className="panel" aria-labelledby="motor-chaves">
        <h2 id="motor-chaves" className="panel-title">
          Chaves e modelos
        </h2>
        <p className="panel-desc">
          Cada conta usa as suas próprias chaves, e o gasto com a IA é cobrado direto na sua conta do provedor. A chave fica guardada
          cifrada: depois de cadastrada, ninguém consegue vê-la inteira de novo, nem aqui no painel.
        </p>
        <div className="motor-provedores">
          {PROVEDORES.map((provedor) => (
            <CartaoDoProvedor
              key={provedor}
              provedor={provedor}
              chave={motor.chaves[provedor]}
              modelo={modeloDe(provedor)}
              modelos={modelos[provedor] ?? null}
              recado={recadosDoProvedor[provedor] ?? null}
              podeEditar={podeEditar}
              podeGuardarChave={podeEditar && cofreConfigurado}
              ocupado={ocupado}
              aoMudarModelo={(modelo) => mudarModelo(provedor, modelo)}
              aoCadastrar={() => setJanela({ tipo: 'chave', provedor })}
              aoRemover={() => setJanela({ tipo: 'remover', provedor })}
              aoTestar={() => void testar(provedor)}
              aoVerModelos={() => void verModelos(provedor)}
            />
          ))}
        </div>
      </section>

      <form onSubmit={(evento) => void salvar(evento)} noValidate>
        <section className="panel" aria-labelledby="motor-rota">
          <h2 id="motor-rota" className="panel-title">
            Qual provedor responde
          </h2>
          <p className="panel-desc">
            O provedor principal responde tudo. Se ele falhar numa mensagem, a reserva assume aquela resposta; se a reserva também
            falhar, entra a segunda reserva.
          </p>
          <div className="motor-grade">
            <div className="form-group">
              <label className="form-label" htmlFor="motor-principal">
                Provedor principal
              </label>
              <select
                id="motor-principal"
                className="campo"
                disabled={!podeEditar}
                value={rascunho.provedor}
                onChange={(evento) => mudarOrdem({ provedor: evento.target.value as Provedor })}
              >
                {PROVEDORES.map((provedor) => (
                  <option key={provedor} value={provedor}>
                    {NOME_DO_PROVEDOR[provedor]}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="motor-reserva">
                Se o principal falhar
              </label>
              <select
                id="motor-reserva"
                className="campo"
                disabled={!podeEditar}
                value={rascunho.reserva}
                onChange={(evento) => mudarOrdem({ reserva: evento.target.value as Reserva })}
              >
                <option value="none">Sem reserva: a IA não responde aquela mensagem</option>
                {reservasPossiveis.map((provedor) => (
                  <option key={provedor} value={provedor}>
                    Usar {oProvedor(provedor)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="motor-segunda-reserva">
                Se a reserva também falhar
              </label>
              <select
                id="motor-segunda-reserva"
                className="campo"
                disabled={!podeEditar || rascunho.reserva === 'none'}
                value={rascunho.segundaReserva}
                onChange={(evento) => mudarOrdem({ segundaReserva: evento.target.value as Reserva })}
              >
                <option value="none">{rascunho.reserva === 'none' ? 'Escolha a reserva primeiro' : 'Sem segunda reserva'}</option>
                {rascunho.reserva !== 'none' &&
                  segundasPossiveis.map((provedor) => (
                    <option key={provedor} value={provedor}>
                      Usar {oProvedor(provedor)}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <p className="campo-dica">
            Quando nenhum provedor consegue responder, a IA fica em silêncio naquela mensagem. Ela nunca inventa uma resposta por conta
            própria nem repete o envio sozinha.
          </p>
          <p className="campo-dica">
            {situacao.escutaAudio
              ? 'Mensagens de voz: só o Google Gemini escuta áudio, então os áudios dos clientes vão sempre para ele.'
              : 'Mensagens de voz: só o Google Gemini escuta áudio. Sem ele na ordem acima (e com a chave cadastrada), a IA não entende os áudios dos clientes.'}
          </p>
        </section>

        <section className="panel" aria-labelledby="motor-comportamento">
          <h2 id="motor-comportamento" className="panel-title">
            Comportamento nas conversas
          </h2>
          <div className="motor-interruptores">
            <Interruptor
              titulo="Mostrar “digitando…” antes de responder"
              descricao="O cliente vê o aviso de digitando por alguns segundos, como numa conversa entre pessoas."
              ligado={rascunho.simularDigitando}
              desativado={!podeEditar}
              aoMudar={(simularDigitando) => mudar({ simularDigitando })}
            />
            <Interruptor
              titulo="Dividir respostas longas em mensagens menores"
              descricao="Em vez de um bloco grande de texto, a resposta chega em até três mensagens curtas."
              ligado={rascunho.dividirMensagensLongas}
              desativado={!podeEditar}
              aoMudar={(dividirMensagensLongas) => mudar({ dividirMensagensLongas })}
            />
            <Interruptor
              titulo="Parar a IA quando uma pessoa responder"
              descricao="Se você ou alguém da equipe responder o cliente, pelo painel ou pelo celular, a IA para naquela conversa."
              ligado={rascunho.pausarQuandoHumanoResponde}
              desativado={!podeEditar}
              aoMudar={(pausarQuandoHumanoResponde) => mudar({ pausarQuandoHumanoResponde })}
            />
          </div>

          <div className="motor-grade">
            <div className="form-group">
              <label className="form-label" htmlFor="motor-pausa">
                Depois que uma pessoa responde, a IA volta em
              </label>
              <select
                id="motor-pausa"
                className="campo"
                disabled={!podeEditar || !rascunho.pausarQuandoHumanoResponde}
                value={rascunho.minutosDePausa}
                onChange={(evento) => mudar({ minutosDePausa: Number(evento.target.value) })}
              >
                {(PAUSAS.some((pausa) => pausa.minutos === rascunho.minutosDePausa)
                  ? PAUSAS
                  : [...PAUSAS, { minutos: rascunho.minutosDePausa, rotulo: `${rascunho.minutosDePausa} minutos` }]
                ).map((pausa) => (
                  <option key={pausa.minutos} value={pausa.minutos}>
                    {pausa.rotulo}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="motor-espera">
                Esperar o cliente terminar de escrever
              </label>
              <select
                id="motor-espera"
                className="campo"
                disabled={!podeEditar}
                value={rascunho.esperaEmSegundos}
                onChange={(evento) => mudar({ esperaEmSegundos: Number(evento.target.value) })}
              >
                {comValorAtual(ESPERAS, rascunho.esperaEmSegundos).map((segundos) => (
                  <option key={segundos} value={segundos}>
                    {segundos} segundos
                  </option>
                ))}
              </select>
              <p className="campo-dica">Quem manda várias mensagens seguidas recebe uma resposta só, para todas.</p>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="motor-memoria">
                Quanto da conversa a IA relê
              </label>
              <select
                id="motor-memoria"
                className="campo"
                disabled={!podeEditar}
                value={rascunho.memoria}
                onChange={(evento) => mudar({ memoria: Number(evento.target.value) })}
              >
                {comValorAtual(MEMORIAS, rascunho.memoria).map((quantidade) => (
                  <option key={quantidade} value={quantidade}>
                    As últimas {quantidade} mensagens
                  </option>
                ))}
              </select>
              <p className="campo-dica">Mais mensagens dão mais contexto, e cada resposta custa um pouco mais.</p>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={idCriatividade}>
                Criatividade: {rotuloDaCriatividade(rascunho.criatividade)}
              </label>
              <input
                id={idCriatividade}
                className="motor-regua"
                type="range"
                min={0}
                max={1}
                step={0.05}
                disabled={!podeEditar}
                value={rascunho.criatividade}
                aria-valuetext={rotuloDaCriatividade(rascunho.criatividade)}
                onChange={(evento) => mudar({ criatividade: Number(evento.target.value) })}
              />
              <p className="campo-dica">Para atendimento e vendas, o melhor é ficar perto do começo da régua.</p>
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="motor-alertas">
          <h2 id="motor-alertas" className="panel-title">
            Dossiê no WhatsApp do administrador
          </h2>
          <p className="panel-desc">
            Sempre que a conversa entrar em modo manual, o sistema envia pelo próprio chip do atendimento um resumo completo com o
            motivo, dados do cliente, cenário e próxima jogada sugerida.
          </p>

          <div className="motor-interruptores">
            <Interruptor
              titulo="Enviar dossiê completo quando a IA repassar ou parar"
              descricao="Avisa o administrador no WhatsApp cadastrado usando o mesmo chip da conversa."
              ligado={rascunho.alertaAdminAtivo}
              desativado={!podeEditar}
              aoMudar={(alertaAdminAtivo) => mudar({ alertaAdminAtivo })}
            />
            <Interruptor
              titulo="Incluir as últimas mensagens do cliente no dossiê"
              descricao="Mostra até 4 mensagens recentes do contato para você entender o contexto sem abrir o painel."
              ligado={rascunho.alertaAdminIncluirMensagens}
              desativado={!podeEditar || !rascunho.alertaAdminAtivo}
              aoMudar={(alertaAdminIncluirMensagens) => mudar({ alertaAdminIncluirMensagens })}
            />
          </div>

          <div className="motor-grade">
            <div className="form-group">
              <label className="form-label" htmlFor="motor-admin-whatsapp">
                WhatsApp administrativo (DDI + DDD + número)
              </label>
              <input
                id="motor-admin-whatsapp"
                className="campo"
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                maxLength={20}
                disabled={!podeEditar}
                placeholder="5586999999999"
                value={rascunho.alertaAdminWhatsapp}
                onChange={(evento) => mudar({ alertaAdminWhatsapp: whatsappSomenteDigitos(evento.target.value) })}
              />
              <p className="campo-dica">Somente números com DDI e DDD (exemplo no Brasil: 5586981303979). O aviso não polui a Inbox.</p>
            </div>

            {podeEditar && chipsConectados.length > 0 && (
              <div className="form-group">
                <label className="form-label" htmlFor="motor-admin-chip-teste">
                  Chip para enviar dossiê de teste
                </label>
                <div className="linha-de-campo">
                  <select
                    id="motor-admin-chip-teste"
                    className="campo"
                    disabled={ocupado !== null}
                    value={chipTesteId}
                    onChange={(evento) => setChipTesteId(evento.target.value)}
                  >
                    {chipsConectados.map((chip) => (
                      <option key={chip.id} value={chip.id}>
                        {chip.apelido}
                        {chip.telefone ? ` (${chip.telefone})` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={ocupado !== null || !rascunho.alertaAdminWhatsapp}
                    onClick={() => void dispararTesteDossie()}
                  >
                    {ocupado === 'dossie-teste' ? 'Enviando teste…' : 'Enviar dossiê de teste'}
                  </button>
                </div>
                <p className="campo-dica">Dispara uma simulação completa para você conferir o formato na hora no celular.</p>
              </div>
            )}
          </div>

          {podeEditar && chipsConectados.length === 0 && (
            <div className="motor-dossie-teste-sem-chip">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={ocupado !== null || !rascunho.alertaAdminWhatsapp}
                onClick={() => void dispararTesteDossie()}
              >
                {ocupado === 'dossie-teste' ? 'Enviando teste…' : 'Enviar dossiê de teste'}
              </button>
            </div>
          )}

          {recadoDossie && (
            <p className={`aviso aviso--${recadoDossie.tipo}`} role="status">
              {recadoDossie.texto}
            </p>
          )}

          <fieldset className="motor-eventos-dossie" disabled={!podeEditar || !rascunho.alertaAdminAtivo}>
            <legend className="form-label">Quando disparar o dossiê</legend>
            <div className="motor-eventos-grade">
              {EVENTOS_DO_ALERTA_DO_ADMIN.map((item) => {
                const marcado = rascunho.alertaAdminEventos.includes(item.valor);
                return (
                  <label key={item.valor} className="motor-evento-item">
                    <input
                      type="checkbox"
                      checked={marcado}
                      onChange={() => alternarEventoDossie(item.valor)}
                    />
                    <span>
                      <strong>{item.rotulo}</strong>
                      <small>{item.descricao}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </section>

        {podeEditar && (
          <div className="motor-rodape">
            <div className="motor-rodape-recado" role="status">
              {recado ? (
                <span className={`motor-recado motor-recado--${recado.tipo}`}>{recado.texto}</span>
              ) : mudou ? (
                <span className="motor-recado motor-recado--atencao">Há alterações que ainda não foram salvas.</span>
              ) : null}
            </div>
            <div className="motor-rodape-acoes">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!mudou || ocupado !== null}
                onClick={() => {
                  setRascunho(motor.configuracao);
                  setRecado(null);
                }}
              >
                Desfazer
              </button>
              <button type="submit" className="btn btn-primary" disabled={!mudou || ocupado !== null}>
                {ocupado === 'salvar' ? 'Salvando…' : 'Salvar alterações'}
              </button>
            </div>
          </div>
        )}
      </form>

      {janela?.tipo === 'chave' && (
        <Dialogo titulo={`Chave ${doProvedor(janela.provedor)}`} aoFechar={() => setJanela(null)}>
          <FormularioDaChave
            provedor={janela.provedor}
            jaTemChave={motor.chaves[janela.provedor].cadastrada}
            modelo={modeloDe(janela.provedor).trim()}
            aoCancelar={() => setJanela(null)}
            aoConcluir={(novo, novoRecado) => {
              receberMotor(novo, true);
              avisarProvedor(janela.provedor, novoRecado);
              setJanela(null);
            }}
          />
        </Dialogo>
      )}
      {janela?.tipo === 'remover' && (
        <Dialogo titulo="Remover chave" aoFechar={() => setJanela(null)}>
          <p className="dialogo-texto">
            A chave {janela.provedor === 'nvidia' ? 'da' : 'do'} <strong>{NOME_DO_PROVEDOR[janela.provedor]}</strong> será apagada daqui. A IA deixa de usar este provedor até
            você cadastrar outra chave. A chave continua existindo na sua conta do provedor: para cancelar de vez, apague lá também.
          </p>
          <div className="dialogo-acoes">
            <button type="button" className="btn btn-secondary" onClick={() => setJanela(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void remover(janela.provedor)}>
              Remover chave
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
        <h1>Motor de IA</h1>
        <p>Escolha qual inteligência responde os seus clientes, cadastre as suas chaves e ajuste o jeito de ela conversar.</p>
      </div>
      {children}
    </div>
  );
}

interface PropsDoCartao {
  provedor: Provedor;
  chave: MotorDeIa['chaves'][Provedor];
  modelo: string;
  modelos: ModeloDisponivel[] | null;
  recado: Recado | null;
  podeEditar: boolean;
  podeGuardarChave: boolean;
  ocupado: string | null;
  aoMudarModelo: (modelo: string) => void;
  aoCadastrar: () => void;
  aoRemover: () => void;
  aoTestar: () => void;
  aoVerModelos: () => void;
}

function CartaoDoProvedor(props: PropsDoCartao) {
  const { provedor, chave, modelo, modelos, recado, podeEditar, podeGuardarChave, ocupado } = props;
  const nome = NOME_DO_PROVEDOR[provedor];
  const de = doProvedor(provedor);
  const sobre = SOBRE_O_PROVEDOR[provedor];
  const idModelo = `motor-modelo-${provedor}`;
  const idLista = `motor-lista-${provedor}`;
  const parado = ocupado !== null;
  // No OpenRouter e na NVIDIA a lista de modelos é pública; no Gemini depende da chave.
  const podeListar = podeEditar && (sobre.listaPublica || (chave.cadastrada && podeGuardarChave));
  const gratuitos = modelos?.filter((item) => item.gratuito) ?? [];
  const outros = modelos?.filter((item) => !item.gratuito) ?? [];

  return (
    <article className="motor-provedor" aria-label={nome}>
      <div className="motor-provedor-topo">
        <h3>{nome}</h3>
        <span className={chave.cadastrada ? 'estado estado--ok' : 'estado'}>{chave.cadastrada ? 'Chave cadastrada' : 'Sem chave'}</span>
      </div>
      <p className="motor-provedor-resumo">{sobre.resumo}</p>

      <p className="motor-provedor-chave">
        <Icone nome="chave" className="icon-15" />
        {chave.cadastrada ? (
          <span>
            {chave.final ? (
              <>
                Termina em <code>…{chave.final}</code>
              </>
            ) : (
              'Guardada e protegida'
            )}
            {chave.atualizadaEm ? ` · cadastrada em ${dataCurta(chave.atualizadaEm)}` : ''}
          </span>
        ) : (
          <span>
            Nenhuma chave cadastrada.{' '}
            <a href={sobre.ondeConseguir} target="_blank" rel="noreferrer">
              Criar uma chave no site {de}
            </a>
          </span>
        )}
      </p>

      {podeEditar && (
        <div className="motor-provedor-acoes">
          <button type="button" className="btn btn-secondary btn-sm" disabled={parado || !podeGuardarChave} onClick={props.aoCadastrar}>
            {chave.cadastrada ? 'Trocar chave' : 'Cadastrar chave'}
            <span className="so-leitor-de-tela"> {de}</span>
          </button>
          {chave.cadastrada && (
            <>
              <button type="button" className="btn btn-secondary btn-sm" disabled={parado || !podeGuardarChave} onClick={props.aoTestar}>
                {ocupado === `testar:${provedor}` ? 'Testando…' : 'Testar conexão'}
                <span className="so-leitor-de-tela"> {de}</span>
              </button>
              <button type="button" className="btn btn-danger btn-sm" disabled={parado} onClick={props.aoRemover}>
                {ocupado === `remover:${provedor}` ? 'Removendo…' : 'Remover chave'}
                <span className="so-leitor-de-tela"> {de}</span>
              </button>
            </>
          )}
        </div>
      )}

      <div className="form-group motor-provedor-modelo">
        <label className="form-label" htmlFor={idModelo}>
          Modelo {de}
        </label>
        <div className="linha-de-campo">
          <input
            id={idModelo}
            className="campo"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={120}
            disabled={!podeEditar}
            placeholder={sobre.exemploDeModelo}
            value={modelo}
            onChange={(evento) => props.aoMudarModelo(evento.target.value)}
          />
          {podeListar && (
            <button type="button" className="btn btn-secondary" disabled={parado} onClick={props.aoVerModelos}>
              {ocupado === `modelos:${provedor}` ? 'Buscando…' : 'Ver modelos'}
              <span className="so-leitor-de-tela"> {de}</span>
            </button>
          )}
        </div>
        {modelos && modelos.length > 0 && (
          <>
            <label className="so-leitor-de-tela" htmlFor={idLista}>
              Modelos disponíveis: {nome}
            </label>
            <select
              id={idLista}
              className="campo motor-provedor-lista"
              value={modelos.some((item) => item.id === modelo) ? modelo : ''}
              onChange={(evento) => {
                if (evento.target.value) props.aoMudarModelo(evento.target.value);
              }}
            >
              <option value="">Escolher da lista ({modelos.length} modelos)</option>
              {gratuitos.length > 0 ? (
                <>
                  <optgroup label="Gratuitos">
                    {gratuitos.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.nome}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Pagos">
                    {outros.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.nome}
                      </option>
                    ))}
                  </optgroup>
                </>
              ) : (
                outros.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.nome}
                  </option>
                ))
              )}
            </select>
          </>
        )}
        <p className="campo-dica">{sobre.sobreOsModelos}</p>
      </div>

      <div role="status">{recado && <p className={`aviso aviso--${recado.tipo}`}>{recado.texto}</p>}</div>
    </article>
  );
}

function FormularioDaChave({
  provedor,
  jaTemChave,
  modelo,
  aoCancelar,
  aoConcluir,
}: {
  provedor: Provedor;
  jaTemChave: boolean;
  modelo: string;
  aoCancelar: () => void;
  aoConcluir: (motor: MotorDeIa, recado: Recado) => void;
}) {
  const [chave, setChave] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const de = doProvedor(provedor);
  const sobre = SOBRE_O_PROVEDOR[provedor];

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (enviando) return;
    const problema = conferirChave(provedor, chave);
    if (problema) return setErro(problema);
    setEnviando(true);
    setErro(null);
    const resposta = await guardarChave(provedor, chave, modelo);
    setEnviando(false);
    if (!resposta.ok) return setErro(resposta.erro);
    // A chave sai da memória da tela assim que foi entregue ao servidor.
    setChave('');
    const { teste } = resposta;
    if (!teste) return aoConcluir(resposta.motor, { tipo: 'ok', texto: 'Chave guardada.' });
    aoConcluir(
      resposta.motor,
      teste.funcionou
        ? { tipo: 'ok', texto: `Chave guardada. ${teste.texto}` }
        : { tipo: 'atencao', texto: `A chave foi guardada, mas o teste não passou. ${teste.texto}` },
    );
  }

  return (
    <form onSubmit={(evento) => void enviar(evento)} noValidate>
      <p className="dialogo-texto">
        {jaTemChave ? 'A chave nova substitui a que está guardada. ' : ''}
        Cole aqui a chave criada na sua conta {de}. Ela é guardada cifrada e testada na hora.{' '}
        <a href={sobre.ondeConseguir} target="_blank" rel="noreferrer">
          Abrir o site {de} para criar uma chave
        </a>
      </p>
      <div className="form-group">
        <label className="form-label" htmlFor="motor-chave-nova">
          Chave {de}
        </label>
        <input
          id="motor-chave-nova"
          className="campo"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={400}
          value={chave}
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? 'motor-chave-erro' : undefined}
          onChange={(evento) => {
            setChave(evento.target.value);
            setErro(null);
          }}
        />
      </div>
      {erro && (
        <p id="motor-chave-erro" className="aviso aviso--erro" role="alert">
          {erro}
        </p>
      )}
      <div className="dialogo-acoes">
        <button type="button" className="btn btn-secondary" onClick={aoCancelar} disabled={enviando}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={enviando}>
          {enviando ? 'Guardando e testando…' : 'Guardar chave'}
        </button>
      </div>
    </form>
  );
}
