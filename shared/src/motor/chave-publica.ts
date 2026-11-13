/**
 * Chave pública Ed25519 usada para conferir que um pacote de atualização do Motor Ienvia
 * foi realmente publicado pelo servidor oficial (assinado com a chave privada fora do código).
 */
export const CHAVE_PUBLICA_ATUALIZACAO_MOTOR = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAz+WOa2HOC9iTkyfQ2YNh6u6M1E3307/Sc9DMBQnx170=',
  '-----END PUBLIC KEY-----',
].join('\n');
