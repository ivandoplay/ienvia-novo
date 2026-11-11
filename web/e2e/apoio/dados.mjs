/**
 * Dados de mentira usados pelos testes de ponta a ponta.
 * Nada aqui existe de verdade: são contas e números inventados só para os testes.
 */
export const SENHA_DE_TESTE = 'senha-de-teste-123';

export const WORKSPACE_LOJA = 'a0000000-0000-4000-8000-000000000001';
export const WORKSPACE_OUTRA = 'a0000000-0000-4000-8000-000000000002';
/** Empresa usada só pelos testes da tela de Instâncias (os chips dela são criados e apagados a cada teste). */
export const WORKSPACE_CHIPS = 'a0000000-0000-4000-8000-000000000003';
export const LIMITE_DE_CHIPS = 2;

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
  {
    // Para esta conta o "banco" falha ao listar as empresas (simula o banco fora do ar).
    id: 'b0000000-0000-4000-8000-000000000004',
    email: 'azarado@zapia.local',
    nome: '',
    master: false,
    bancoFalha: true,
  },
  {
    // Dona da empresa dos testes de Instâncias.
    id: 'b0000000-0000-4000-8000-000000000005',
    email: 'chips@zapia.local',
    nome: 'Dona dos Chips',
    master: false,
  },
  {
    // Atendente (não é dona) da Loja da Maria: só olha os chips.
    id: 'b0000000-0000-4000-8000-000000000006',
    email: 'atendente@zapia.local',
    nome: 'Ana Atendente',
    master: false,
  },
];

export const WORKSPACES = [
  { id: WORKSPACE_LOJA, name: 'Loja da Maria', status: 'active', max_instances: 3 },
  { id: WORKSPACE_OUTRA, name: 'Outra Empresa', status: 'active', max_instances: 1 },
  { id: WORKSPACE_CHIPS, name: 'Empresa dos Chips', status: 'active', max_instances: LIMITE_DE_CHIPS },
];

/** Quem participa de qual workspace. O "novato" não participa de nenhum. */
export const PARTICIPACOES = [
  { user_id: USUARIOS[0].id, workspace_id: WORKSPACE_LOJA, role: 'owner', status: 'active', created_at: '2026-01-01T00:00:00Z' },
  { user_id: USUARIOS[1].id, workspace_id: WORKSPACE_OUTRA, role: 'owner', status: 'active', created_at: '2026-01-02T00:00:00Z' },
  { user_id: USUARIOS[4].id, workspace_id: WORKSPACE_CHIPS, role: 'owner', status: 'active', created_at: '2026-01-03T00:00:00Z' },
  { user_id: USUARIOS[5].id, workspace_id: WORKSPACE_LOJA, role: 'operator', status: 'active', created_at: '2026-01-04T00:00:00Z' },
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
    // Os chips da Loja usam o motor local, para a tela de Instâncias não tentar conferi-los na Evolution.
    instances: [
      daLoja({ id: 'c0000000-0000-4000-8000-000000000001', display_name: 'Comercial', purpose: 'both', engine: 'baileys', status: 'connected', connected_phone: '+5585999990001', is_enabled: true, provider_instance_name: null, created_at: '2026-01-01T00:00:00Z' }),
      daLoja({ id: 'c0000000-0000-4000-8000-000000000002', display_name: 'Suporte', purpose: 'attendance', engine: 'baileys', status: 'connected', connected_phone: '+5585999990002', is_enabled: false, provider_instance_name: null, created_at: '2026-01-02T00:00:00Z' }),
      daLoja({ id: 'c0000000-0000-4000-8000-000000000003', display_name: 'Promoções', purpose: 'campaigns', engine: 'baileys', status: 'disconnected', connected_phone: null, is_enabled: false, provider_instance_name: null, created_at: '2026-01-03T00:00:00Z' }),
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
