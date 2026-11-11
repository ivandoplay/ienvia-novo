/**
 * Regras dos chips (instâncias) que não dependem de banco nem de rede.
 * Ficam aqui para a tela, as ações do servidor e os testes usarem as mesmas.
 */

export const FUNCOES_DO_CHIP = [
  { valor: 'attendance', rotulo: 'Atendimento', descricao: 'Conversa com os clientes (você e a IA).' },
  { valor: 'campaigns', rotulo: 'Campanhas', descricao: 'Só para disparos em lote.' },
  { valor: 'both', rotulo: 'Atendimento e campanhas', descricao: 'Faz as duas coisas.' },
] as const;

export type FuncaoDoChip = (typeof FUNCOES_DO_CHIP)[number]['valor'];

export function ehFuncaoDoChip(valor: unknown): valor is FuncaoDoChip {
  return FUNCOES_DO_CHIP.some((funcao) => funcao.valor === valor);
}

export function rotuloDaFuncao(valor: string): string {
  return FUNCOES_DO_CHIP.find((funcao) => funcao.valor === valor)?.rotulo ?? 'Atendimento';
}

/** Estados que o banco guarda para um chip (o "revoked" é chip removido e nunca aparece na tela). */
export type EstadoDoChip = 'disconnected' | 'connecting' | 'connected' | 'paused' | 'error';

export type TomDoEstado = 'ok' | 'atencao' | 'neutro' | 'erro';

export function descreverEstado(estado: string): { texto: string; tom: TomDoEstado } {
  switch (estado) {
    case 'connected':
      return { texto: 'Conectado', tom: 'ok' };
    case 'connecting':
      return { texto: 'Aguardando conexão', tom: 'atencao' };
    case 'paused':
      return { texto: 'Pausado', tom: 'atencao' };
    case 'error':
      return { texto: 'Com erro', tom: 'erro' };
    default:
      return { texto: 'Desconectado', tom: 'neutro' };
  }
}

const APELIDO_MAXIMO = 60;

/** Apelido limpo, ou `null` quando está vazio ou longo demais. */
export function validarApelido(texto: string): string | null {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length >= 1 && limpo.length <= APELIDO_MAXIMO ? limpo : null;
}

/**
 * Nome do chip dentro da Evolution. Começa com "ienvia-" e com o começo do código da empresa,
 * para dar para reconhecer de quem é cada chip no servidor.
 */
export function gerarNomeNaEvolution(workspaceId: string, aleatorio: string): string {
  const empresa = workspaceId.replace(/[^a-f0-9]/gi, '').slice(0, 8).toLowerCase();
  const sufixo = aleatorio.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase();
  return `ienvia-${empresa}-${sufixo}`;
}

/** "5585999990000:12@s.whatsapp.net" → "+5585999990000". Devolve `null` se não for um número de pessoa. */
export function telefoneDoJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const encontrado = /^([1-9][0-9]{5,19})(?::[0-9]+)?@s\.whatsapp\.net$/.exec(jid.trim());
  return encontrado ? `+${encontrado[1]}` : null;
}

/** "+5585999990000" → "+55 (85) 99999-0000". Números de fora do Brasil ficam como vieram. */
export function formatarTelefone(e164: string | null | undefined): string {
  if (!e164) return '';
  const brasil = /^\+55([1-9][0-9])([0-9]{4,5})([0-9]{4})$/.exec(e164);
  return brasil ? `+55 (${brasil[1]}) ${brasil[2]}-${brasil[3]}` : e164;
}

/**
 * Número digitado para conectar por código → só dígitos, com o código do país.
 * Aceita "(85) 99999-0000" (assume Brasil) e "5585999990000". Devolve `null` se não der um número válido.
 */
export function normalizarNumeroParaPareamento(texto: string): string | null {
  const digitos = texto.replace(/\D/g, '').replace(/^0+/, '');
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  if (digitos.length >= 12 && digitos.length <= 15) return digitos;
  return null;
}

/** "ABCD1234" → "ABCD-1234", que é como o WhatsApp mostra o código de 8 dígitos. */
export function formatarCodigoDePareamento(codigo: string): string {
  const limpo = codigo.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return limpo.length === 8 ? `${limpo.slice(0, 4)}-${limpo.slice(4)}` : limpo;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ehIdentificador(valor: unknown): valor is string {
  return typeof valor === 'string' && UUID.test(valor);
}
