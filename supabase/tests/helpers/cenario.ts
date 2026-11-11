/**
 * Cenário usado pelos testes de banco: duas empresas (workspaces) que não se conhecem.
 *
 *   Loja A: dona (owner) + atendente (operator) + ex-funcionário (suspenso)
 *   Loja B: dono (owner)
 *   intruso: tem login, mas não participa de nenhuma empresa
 *   master: administrador da plataforma, também sem empresa
 *
 * Cada loja tem 1 chip, 1 contato, 1 conversa, 1 mensagem e 1 campanha.
 */
import { bancoDaRodada, type BancoDeTeste } from './banco';

export const LOJA_A = '11111111-1111-4111-8111-111111111111';
export const LOJA_B = '22222222-2222-4222-8222-222222222222';

export const DONA_A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const ATENDENTE_A = 'aaaaaaaa-0000-4000-8000-000000000002';
export const SUSPENSO_A = 'aaaaaaaa-0000-4000-8000-000000000003';
export const DONO_B = 'bbbbbbbb-0000-4000-8000-000000000001';
export const INTRUSO = 'cccccccc-0000-4000-8000-000000000001';
export const MASTER = 'dddddddd-0000-4000-8000-000000000001';

export const CHIP_A = '11111111-0000-4000-8000-0000000000a1';
export const CHIP_B = '22222222-0000-4000-8000-0000000000b1';
export const CONTATO_A = '11111111-0000-4000-8000-0000000000a2';
export const CONTATO_B = '22222222-0000-4000-8000-0000000000b2';
export const CONVERSA_A = '11111111-0000-4000-8000-0000000000a3';
export const CONVERSA_B = '22222222-0000-4000-8000-0000000000b3';

/** Tabelas que guardam dados de uma empresa. Todas têm 1 linha de cada loja no cenário. */
export const TABELAS_DA_EMPRESA = ['instances', 'contacts', 'conversations', 'messages', 'campaigns'] as const;

let cenarioCarregado: Promise<void> | undefined;

/** O banco da rodada, já com as duas lojas dentro (o cenário é carregado uma vez só). */
export async function bancoComCenario(): Promise<BancoDeTeste> {
  const banco = await bancoDaRodada();
  cenarioCarregado ??= montarCenario(banco);
  await cenarioCarregado;
  return banco;
}

export async function montarCenario(banco: BancoDeTeste): Promise<void> {
  // Roda como administrador do banco (fora de qualquer papel), igual a uma carga inicial.
  await banco.db.exec(`
    insert into auth.users (id, email) values
      ('${DONA_A}', 'dona-a@teste.local'),
      ('${ATENDENTE_A}', 'atendente-a@teste.local'),
      ('${SUSPENSO_A}', 'suspenso-a@teste.local'),
      ('${DONO_B}', 'dono-b@teste.local'),
      ('${INTRUSO}', 'intruso@teste.local'),
      ('${MASTER}', 'master@teste.local');

    insert into public.workspaces (id, name) values
      ('${LOJA_A}', 'Loja A'),
      ('${LOJA_B}', 'Loja B');

    insert into public.workspace_data_policies (workspace_id) values ('${LOJA_A}'), ('${LOJA_B}');

    insert into public.workspace_memberships (workspace_id, user_id, role, status) values
      ('${LOJA_A}', '${DONA_A}', 'owner', 'active'),
      ('${LOJA_A}', '${ATENDENTE_A}', 'operator', 'active'),
      ('${LOJA_A}', '${SUSPENSO_A}', 'operator', 'suspended'),
      ('${LOJA_B}', '${DONO_B}', 'owner', 'active');

    insert into private.platform_admins (user_id) values ('${MASTER}');

    insert into public.instances (id, workspace_id, channel, engine, display_name, status, is_enabled) values
      ('${CHIP_A}', '${LOJA_A}', 'whatsapp', 'evolution', 'Chip da Loja A', 'connected', true),
      ('${CHIP_B}', '${LOJA_B}', 'whatsapp', 'baileys', 'Chip da Loja B', 'disconnected', false);

    insert into public.contacts (id, workspace_id, instance_id, channel, external_user_id, display_name, phone_e164) values
      ('${CONTATO_A}', '${LOJA_A}', '${CHIP_A}', 'whatsapp', '5586900000001@s.whatsapp.net', 'Cliente da A', '+5586900000001'),
      ('${CONTATO_B}', '${LOJA_B}', '${CHIP_B}', 'whatsapp', '5586900000002@s.whatsapp.net', 'Cliente da B', '+5586900000002');

    insert into public.conversations (id, workspace_id, contact_id, instance_id, stage, unread_count) values
      ('${CONVERSA_A}', '${LOJA_A}', '${CONTATO_A}', '${CHIP_A}', 'waiting_human', 2),
      ('${CONVERSA_B}', '${LOJA_B}', '${CONTATO_B}', '${CHIP_B}', 'new', 1);

    insert into public.messages (workspace_id, conversation_id, instance_id, direction, source_engine, actor_type, status, body_text, occurred_at) values
      ('${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'inbound', 'evolution', 'contact', 'received', 'Oi, tem pizza?', now()),
      ('${LOJA_B}', '${CONVERSA_B}', '${CHIP_B}', 'inbound', 'baileys', 'contact', 'received', 'Qual o horário?', now());

    insert into public.campaigns (workspace_id, name, status, text_body) values
      ('${LOJA_A}', 'Promoção da A', 'running', 'Olá!'),
      ('${LOJA_B}', 'Promoção da B', 'draft', 'Olá!');
  `);
}
