/** Pequenas funções de texto usadas em várias telas. Código puro, fácil de testar. */

/** "Bom dia", "Boa tarde" ou "Boa noite", conforme a hora (0–23). */
export function saudacao(hora: number): string {
  if (hora >= 5 && hora < 12) return 'Bom dia';
  if (hora >= 12 && hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** Relógio "14:05". */
export function horaMinuto(data: Date): string {
  return `${String(data.getHours()).padStart(2, '0')}:${String(data.getMinutes()).padStart(2, '0')}`;
}

/** Escolhe singular ou plural: plural(1, 'conversa', 'conversas') → "1 conversa". */
export function plural(quantidade: number, singular: string, pluralDaPalavra: string): string {
  return `${quantidade} ${quantidade === 1 ? singular : pluralDaPalavra}`;
}

/** Texto da pílula de conexão no topo do painel. */
export function resumoDeConexao(conectadas: number, total: number): { texto: string; conectado: boolean } {
  if (total === 0) return { texto: 'Nenhum chip', conectado: false };
  if (conectadas === 0) return { texto: 'Desconectado', conectado: false };
  if (conectadas === total) {
    // Curto de propósito: no celular a pílula divide a barra com título, busca e avatar.
    // A bolinha verde já diz que está conectado, então o texto só informa quantos chips são.
    return { texto: total === 1 ? 'Conectado' : `${total} chips`, conectado: true };
  }
  // Mesma razão: "1 de 2 conectados" chegava cortado como "1 de ..." no celular.
  return { texto: `${conectadas}/${total} chips`, conectado: true };
}
