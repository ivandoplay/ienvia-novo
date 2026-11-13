import { describe, expect, test } from 'vitest';
import { montarPlanoDeMigracao } from '../../scripts/lib/migracao-legado.mjs';

describe('migração do legado ZAP-IA Studio -> Ienvia', () => {
  const legadoExemplo = {
    zapia_users: [
      { id: 'u-1', email: 'dona@empresa.com', name: 'Maria', workspace_id: 'ws-1', role: 'owner' },
      { id: 'u-2', username: 'operador', name: 'João', workspace_id: 'ws-1', role: 'operator' },
    ],
    zapia_workspaces: [
      {
        id: 'ws-1',
        name: 'Loja Central',
        data: JSON.stringify({
          max_instances: 3,
          brand_name: 'Central Zap',
          brand_subtitle: 'Vendas e Suporte',
          business_name: 'Loja Central Ltda',
          niche: 'Varejo',
          golden_rules: 'Sempre responda com educação.',
        }),
      },
    ],
    zapia_wa_slots: [
      { id: 'slot-1', workspace_id: 'ws-1', name: 'zap-principal', phone: '5586999991111', status: 'open' },
    ],
    zapia_contacts: [
      { id: 'c-1', workspace_id: 'ws-1', phone: '(86) 98888-2222', name: 'Carlos', notes: 'Cliente VIP' },
    ],
    ienvia_crm_contacts: [
      { id: 'c-crm-1', workspace_id: 'ws-1', phone: '+5586988882222', company: 'Padaria Sol', city: 'Teresina' },
    ],
    ienvia_instance_messages: [
      {
        id: 'm-1',
        workspace_id: 'ws-1',
        slot_id: 'slot-1',
        remote_jid: '5586988882222@s.whatsapp.net',
        body_text: 'Olá, quero orçamento',
        direction: 'inbound',
        occurred_at: '2026-10-01T10:00:00Z',
      },
      {
        id: 'm-2',
        workspace_id: 'ws-1',
        slot_id: 'slot-1',
        remote_jid: '5586988882222@s.whatsapp.net',
        body_text: 'Claro, qual item?',
        direction: 'outbound',
        occurred_at: '2026-10-01T10:01:00Z',
      },
    ],
    ienvia_campanha_destinatarios: [
      { workspace_id: 'ws-1', phone: '86988882222', status: 'delivered' },
    ],
  };

  test('produz o mesmo plano determinístico em execuções repetidas, com instâncias desconectadas e contatos deduplicados', () => {
    const a = montarPlanoDeMigracao(legadoExemplo);
    const b = montarPlanoDeMigracao(legadoExemplo);

    expect(a).toEqual(b);
    expect(a.usuarios).toHaveLength(2);
    expect(a.usuarios[1]?.email).toBe('operador@zapia.local');

    expect(a.workspaces).toHaveLength(1);
    expect(a.workspaces[0]).toMatchObject({
      name: 'Loja Central',
      brandName: 'Central Zap',
      brandSubtitle: 'Vendas e Suporte',
      maxInstances: 3,
      ownerEmail: 'dona@empresa.com',
    });
    expect(a.workspaces[0]?.treinamento.goldenRules).toBe('Sempre responda com educação.');

    // Instâncias sempre nascem desconectadas e com IA desligada.
    expect(a.instancias).toHaveLength(1);
    expect(a.instancias[0]).toMatchObject({
      status: 'disconnected',
      isEnabled: false,
      connectedPhone: '+5586999991111',
    });

    // Carlos aparece nas duas tabelas (zapia_contacts e ienvia_crm_contacts) -> vira 1 contato só mesclado.
    expect(a.contatos).toHaveLength(1);
    expect(a.contatos[0]).toMatchObject({
      phoneE164: '+5586988882222',
      displayName: 'Carlos',
      company: 'Padaria Sol',
      city: 'Teresina',
      notes: 'Cliente VIP',
    });

    expect(a.conversas).toHaveLength(1);
    expect(a.mensagens).toHaveLength(2);
    expect(a.mensagens[0]?.idempotencyKey).toBe('legado:m-1');
    expect(a.campanhasHistorico).toHaveLength(0);
  });

  test('inclui histórico de destinatários de campanha somente quando solicitado', () => {
    const comCampanhas = montarPlanoDeMigracao(legadoExemplo, { incluirCampanhas: true });
    expect(comCampanhas.campanhasHistorico).toHaveLength(1);
    expect(comCampanhas.campanhasHistorico[0]?.destinatarios).toHaveLength(1);
    expect(comCampanhas.campanhasHistorico[0]?.destinatarios[0]?.status).toBe('delivered');
  });
});
