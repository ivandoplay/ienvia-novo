export interface PlanoDeMigracao {
  usuarios: Array<{
    legacyId: string;
    email: string;
    displayName: string;
    role: 'owner' | 'operator';
    isMaster: boolean;
    legacyWorkspaceId: string | null;
  }>;
  workspaces: Array<{
    legacyId: string;
    targetId: string;
    name: string;
    brandName: string;
    brandSubtitle: string;
    maxInstances: number;
    ownerEmail: string | null;
    treinamento: {
      businessName: string;
      niche: string;
      assistantName: string;
      companySummary: string;
      commercialTerms: string;
      goldenRules: string;
      extraInstructions: string;
    };
  }>;
  instancias: Array<{
    legacyId: string;
    targetId: string;
    workspaceId: string;
    displayName: string;
    connectedPhone: string | null;
    status: 'disconnected';
    isEnabled: false;
    channel: 'whatsapp';
    engine: 'evolution';
  }>;
  contatos: Array<{
    legacyId: string;
    targetId: string;
    workspaceId: string;
    channel: 'whatsapp' | 'manual';
    externalUserId: string | null;
    phoneE164: string | null;
    email: string | null;
    displayName: string;
    company: string;
    city: string;
    notes: string;
  }>;
  conversas: Array<{
    targetId: string;
    workspaceId: string;
    contactId: string;
    instanceId: string;
    stage: string;
    lastMessageAt: string | null;
    lastMessagePreview: string | null;
  }>;
  mensagens: Array<{
    targetId: string;
    workspaceId: string;
    conversationId: string;
    instanceId: string;
    idempotencyKey: string;
    direction: 'inbound' | 'outbound';
    sourceEngine: 'evolution';
    actorType: 'contact' | 'human';
    status: 'received' | 'sent';
    bodyText: string;
    occurredAt: string;
  }>;
  campanhasHistorico: Array<{
    targetId: string;
    workspaceId: string;
    name: string;
    status: 'completed';
    textBody: string;
    destinatarios: Array<{
      targetId: string;
      workspaceId: string;
      campaignId: string;
      contactId: string;
      instanceId: string;
      status: string;
      idempotencyKey: string;
    }>;
  }>;
  resumoLeitura: {
    usuariosLidos: number;
    workspacesLidos: number;
    contatosLidos: number;
    contatosIgnorados: number;
    slotsLidos: number;
    mensagensLidas: number;
    mensagensIgnoradas: number;
    destinatariosLidos: number;
    campanhasIncluidas: boolean;
  };
}

export function montarPlanoDeMigracao(
  legado: Record<string, unknown>,
  opcoes?: { dominioPadrao?: string; incluirCampanhas?: boolean },
): PlanoDeMigracao;
