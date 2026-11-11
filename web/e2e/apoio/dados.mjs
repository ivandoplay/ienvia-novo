/**
 * Dados de mentira usados pelos testes de ponta a ponta.
 * Nada aqui existe de verdade: são contas e números inventados só para os testes.
 */
export const SENHA_DE_TESTE = 'senha-de-teste-123';

export const WORKSPACE_LOJA = 'a0000000-0000-4000-8000-000000000001';
export const WORKSPACE_OUTRA = 'a0000000-0000-4000-8000-000000000002';

export const USUARIOS = [
  {
    id: 'b0000000-0000-4000-8000-000000000001',
    email: 'dona@zapia.local',
    nome: 'Dona Maria',
    master: false,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    email: 'master@exemplo.com',
    nome: '',
    master: true,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000003',
    email: 'novato@zapia.local',
    nome: '',
    master: false,
  },
];

export const WORKSPACES = [
  { id: WORKSPACE_LOJA, name: 'Loja da Maria', status: 'active' },
  { id: WORKSPACE_OUTRA, name: 'Outra Empresa', status: 'active' },
];

/** Quem participa de qual workspace. O "novato" não participa de nenhum. */
export const PARTICIPACOES = [
  { user_id: USUARIOS[0].id, workspace_id: WORKSPACE_LOJA, role: 'owner', status: 'active', created_at: '2026-01-01T00:00:00Z' },
  { user_id: USUARIOS[1].id, workspace_id: WORKSPACE_OUTRA, role: 'owner', status: 'active', created_at: '2026-01-02T00:00:00Z' },
];

/**
 * Mensagem "de agora": a hora é calculada cada vez que alguém pergunta, para o teste
 * valer em qualquer horário do dia (inclusive perto da meia-noite).
 */
const deAgora = (linha) => ({
  ...linha,
  get occurred_at() {
    return new Date().toISOString();
  },
});
const repetir = (quantidade, criar) => Array.from({ length: quantidade }, (_, indice) => criar(indice));

/** Linhas de cada tabela. A "Loja da Maria" tem movimento; a "Outra Empresa" está vazia. */
export function criarTabelas() {
  const daLoja = (linha) => ({ workspace_id: WORKSPACE_LOJA, ...linha });
  return {
    instances: [
      daLoja({ id: 'i1', status: 'connected', is_enabled: true }),
      daLoja({ id: 'i2', status: 'connected', is_enabled: false }),
      daLoja({ id: 'i3', status: 'disconnected', is_enabled: false }),
    ],
    conversations: [
      ...repetir(4, (n) => daLoja({ id: `c-new-${n}`, stage: 'new' })),
      ...repetir(7, (n) => daLoja({ id: `c-ai-${n}`, stage: 'ai' })),
      ...repetir(3, (n) => daLoja({ id: `c-wh-${n}`, stage: 'waiting_human' })),
      ...repetir(2, (n) => daLoja({ id: `c-h-${n}`, stage: 'human' })),
      ...repetir(1, (n) => daLoja({ id: `c-wc-${n}`, stage: 'waiting_customer' })),
      ...repetir(5, (n) => daLoja({ id: `c-r-${n}`, stage: 'resolved' })),
    ],
    campaigns: [
      daLoja({ id: 'k1', status: 'running' }),
      daLoja({ id: 'k2', status: 'draft' }),
    ],
    messages: [
      ...repetir(12, (n) => deAgora(daLoja({ id: `m-in-${n}`, direction: 'inbound', actor_type: 'contact' }))),
      ...repetir(9, (n) => deAgora(daLoja({ id: `m-ai-${n}`, direction: 'outbound', actor_type: 'ai' }))),
      // Mensagens antigas não entram na conta de "hoje".
      ...repetir(30, (n) => daLoja({ id: `m-old-${n}`, direction: 'inbound', actor_type: 'contact', occurred_at: '2020-01-01T12:00:00Z' })),
    ],
    contacts: [
      ...repetir(41, (n) => daLoja({ id: `p-${n}`, erased_at: null })),
      daLoja({ id: 'p-apagado', erased_at: '2026-01-01T00:00:00Z' }),
    ],
  };
}
