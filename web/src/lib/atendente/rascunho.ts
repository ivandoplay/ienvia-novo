/**
 * "Rascunho da IA": a IA escreve, com as palavras dela, a resposta que ela daria nesta conversa.
 *
 * Nada é enviado ao cliente. O texto aparece no painel para a pessoa revisar; ela pode jogar o
 * rascunho no campo com "Usar no campo" e editar antes de enviar.
 *
 * O cérebro é o mesmo do atendente e do Simulador: a base de treinamento da empresa, o motor de IA
 * (ordem dos provedores, modelos e criatividade) e as mesmas instruções — só que aqui a última fala
 * do cliente é a última mensagem recebida na conversa, e a resposta não vira mensagem.
 */
import 'server-only';

import { lerBasesDeTreinamento, lerBaseDeTreinamento } from '@/lib/dados/treinamento';
import type { ConversaAberta } from '@/lib/dados/inbox';
import { carregarRecursosDaInbox } from '@/lib/dados/recursos';
import { lerMotorDeIa } from '@/lib/dados/ia';
import { montarInstrucoes } from '@/lib/ia/instrucoes';
import { ErroDeIa, gerarResposta, type Fala, type RespostaDeIa } from '@/lib/ia/provedores';
import { explicarErroDeIa, modeloDoProvedor, ordemDeUso, type Provedor } from '@/lib/ia/regras';

/** Quantas mensagens anteriores entram como contexto (as mais recentes). */
const FALAS_DE_CONTEXTO = 20;

export type ResultadoDoRascunho = { ok: true; texto: string; provedor: Provedor; modelo: string } | { ok: false; erro: string };

export interface PedidoDeRascunho {
  workspaceId: string;
  conversa: ConversaAberta;
  /** As chaves já decifradas, por provedor (lidas por quem chamou, que sabe onde estão). */
  chaves: Partial<Record<Provedor, string>>;
}

/** As falas da conversa no formato do provedor: sempre começando pelo cliente. */
export function falasParaRascunho(conversa: Pick<ConversaAberta, 'mensagens'>): Fala[] {
  const falas: Fala[] = [];
  for (const mensagem of conversa.mensagens.slice(-FALAS_DE_CONTEXTO)) {
    const texto = mensagem.texto.trim();
    if (!texto) continue;
    falas.push({ de: mensagem.recebida ? 'cliente' : 'atendente', texto });
  }
  // O provedor exige que a última fala seja do cliente: sem isso não há o que responder.
  while (falas.length > 0 && falas[falas.length - 1]!.de !== 'cliente') falas.pop();
  return falas;
}

export async function rascunharResposta({ workspaceId, conversa, chaves }: PedidoDeRascunho): Promise<ResultadoDoRascunho> {
  const falas = falasParaRascunho(conversa);
  if (falas.length === 0) {
    return { ok: false, erro: 'A última palavra é da sua equipe. Espere o cliente responder para a IA rascunhar.' };
  }

  const [bases, motor, recursos] = await Promise.all([
    lerBasesDeTreinamento(workspaceId),
    lerMotorDeIa(workspaceId),
    carregarRecursosDaInbox(workspaceId),
  ]);

  if (!motor.motor) return { ok: false, erro: 'Não foi possível ler as configurações do Motor de IA.' };
  const configuracao = motor.motor.configuracao;
  const ordem = ordemDeUso(configuracao).filter((provedor) => Boolean(chaves[provedor]));
  if (ordem.length === 0) {
    return { ok: false, erro: 'Configure uma chave de IA no Motor de IA para a IA rascunhar.' };
  }

  const lista = bases.lista?.bases ?? [];
  const baseEscolhida = lista.find((base) => base.padrao) ?? lista[0] ?? null;
  if (!baseEscolhida) return { ok: false, erro: 'Crie uma base no Treinamento para a IA conhecer a empresa.' };

  const leitura = await lerBaseDeTreinamento(workspaceId, baseEscolhida.id, true);
  if (!leitura.base) return { ok: false, erro: 'Não foi possível carregar a base de treinamento.' };

  const ultimaDoCliente = [...falas].reverse().find((fala) => fala.de === 'cliente')?.texto ?? '';
  const instrucoes = montarInstrucoes(leitura.base, {
    agora: new Date(),
    nomeDoContato: conversa.contato.nome,
    mensagemAtual: ultimaDoCliente,
    historicoRecente: falas.filter((fala) => fala.de === 'cliente').map((fala) => fala.texto).slice(-5),
    temAudio: false,
    temFoto: false,
    recursos: {
      pix: recursos.pix,
      catalogo: recursos.catalogo,
      audios: recursos.audios,
      audiosJaEnviados: [],
      clienteRecusouAudio: false,
    },
  });

  let ultimoErro = '';
  for (const provedor of ordem) {
    const modelo = modeloDoProvedor(configuracao, provedor);
    try {
      const resposta: RespostaDeIa = await gerarResposta({
        provedor,
        chave: chaves[provedor]!,
        modelo,
        sistema: instrucoes,
        conversa: falas,
        temperatura: configuracao.criatividade,
        tempoLimiteMs: 30_000,
      });
      const texto = resposta.texto.trim();
      if (!texto) {
        ultimoErro = 'A IA não escreveu nada desta vez.';
        continue;
      }
      // Nada disto é registrado como atendimento: o rascunho não sai do painel.
      return { ok: true, texto, provedor, modelo };
    } catch (erro) {
      const motivo = erro instanceof ErroDeIa ? erro.motivo : 'recusada';
      ultimoErro = explicarErroDeIa(motivo, provedor, modelo);
    }
  }
  return { ok: false, erro: ultimoErro || 'Nenhum provedor de IA conseguiu rascunhar agora.' };
}
