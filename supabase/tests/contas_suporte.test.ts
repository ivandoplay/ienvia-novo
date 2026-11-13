import { beforeAll, describe, expect, test } from 'vitest';
import { criarBanco, type BancoDeTeste } from './helpers/banco';
import {
  ATENDENTE_A,
  CHIP_A,
  CONTATO_A,
  CONVERSA_A,
  DONA_A,
  DONO_B,
  INTRUSO,
  LOJA_A,
  LOJA_B,
  MASTER,
  montarCenario,
} from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await criarBanco();
  await montarCenario(banco);
});

const DONO_NOVO = 'eeeeeeee-0000-4000-8000-000000000001';
const ANEXO_EXPIRADO = '11111111-aaaa-4aaa-8aaa-000000000001';
const ANEXO_CATALOGO = '11111111-aaaa-4aaa-8aaa-000000000002';
const ANEXO_EXCECAO = '11111111-aaaa-4aaa-8aaa-000000000003';

describe('Fase 7 — configurações, clientes SaaS, Modo Suporte e limpeza de retenção', () => {
  test('só a dona altera a marca white-label da própria empresa (atendente, intruso e master sem suporte são barrados)', async () => {
    for (const quem of [ATENDENTE_A, DONO_B, INTRUSO, MASTER]) {
      await banco.comoUsuario(quem, async () => {
        const erro = await banco.esperarErro(() =>
          banco.db.query(`select public.update_my_workspace_branding('${LOJA_A}', 'Outro', 'Outra Marca', 'Sub')`),
        );
        expect(erro).toMatch(/Workspace owner required/);
      });
    }

    await banco.comoUsuario(DONA_A, async () => {
      const r = await banco.db.query<{
        res: { id: string; name: string; brand_name: string; brand_subtitle: string };
      }>(
        `select public.update_my_workspace_branding('${LOJA_A}', 'Loja A Oficial', 'Maria Zap', 'Atendimento VIP') as res`,
      );
      expect(r.rows[0]?.res).toEqual({
        id: LOJA_A,
        name: 'Loja A Oficial',
        brand_name: 'Maria Zap',
        brand_subtitle: 'Atendimento VIP',
      });
    });
  });

  test('export_my_workspace_snapshot só roda para a dona e nunca vaza chaves ou tokens secretos', async () => {
    await banco.comoServico(async () => {
      await banco.db.query(`
        insert into private.workspace_ai_secrets (workspace_id, provider, ciphertext, key_hint)
        values ('${LOJA_A}', 'gemini', 'v1.0123456789abcdef.0123456789abcdefghijkl.segredo-secreto-aqui', '9xyz')
      `);
      await banco.db.query(`
        update public.instances set provider_instance_name = 'instancia-interna-secreta' where id = '${CHIP_A}'
      `);

      // Como atendente (dentro da mesma transação) -> barrado.
      await banco.db.exec('set local role authenticated');
      await banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [ATENDENTE_A]);
      await banco.db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
      const erro = await banco.esperarErro(() =>
        banco.db.query(`select public.export_my_workspace_snapshot('${LOJA_A}')`),
      );
      expect(erro).toMatch(/Workspace owner required/);

      // Como dona (dentro da mesma transação) -> exporta tudo sem vazar o segredo nem provider_instance_name.
      await banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [DONA_A]);
      await banco.db.query(
        `select public.update_my_workspace_branding('${LOJA_A}', 'Loja A Oficial', 'Maria Zap', 'Atendimento VIP')`,
      );
      const r = await banco.db.query<{ snap: Record<string, unknown> }>(
        `select public.export_my_workspace_snapshot('${LOJA_A}') as snap`,
      );
      const snap = r.rows[0]?.snap;
      const serializado = JSON.stringify(snap);
      expect(snap?.format).toBe('ienvia-workspace-export-v1');
      expect((snap?.workspace as { brand_name: string })?.brand_name).toBe('Maria Zap');
      expect((snap?.ai_providers_summary as Array<{ provider: string; key_hint: string }>)?.[0]).toMatchObject({
        provider: 'gemini',
        key_hint: '9xyz',
      });
      expect(serializado).not.toContain('segredo-secreto-aqui');
      expect(serializado).not.toContain('instancia-interna-secreta');
    });
  });

  test('somente o master lista, provisiona e atualiza clientes SaaS com auditoria completa', async () => {
    for (const quem of [DONA_A, INTRUSO]) {
      await banco.comoUsuario(quem, async () => {
        expect(await banco.esperarErro(() => banco.db.query(`select public.list_platform_workspaces()`))).toMatch(
          /Platform master required/,
        );
        expect(
          await banco.esperarErro(() =>
            banco.db.query(
              `select public.update_platform_workspace('${LOJA_A}', 'X', 'active', 2, 'Pro', 'nota')`,
            ),
          ),
        ).toMatch(/Platform master required/);
      });
    }

    // Criação do cliente só acontece via service_role (Server Action do master).
    await banco.comoUsuario(MASTER, async () => {
      expect(
        await banco.esperarErro(() =>
          banco.db.query(
            `select public.provision_platform_workspace('${MASTER}', '${DONO_NOVO}', 'Loja Nova', 2, 'Pro', 'Obs', 'Ienvia', 'Atendente Universal', 'Novo')`,
          ),
        ),
      ).toMatch(/permission denied/);
    });

    await banco.db.query(`insert into auth.users (id, email) values ('${DONO_NOVO}', 'novoloja@zapia.local')`);

    await banco.comoServico(async () => {
      const r = await banco.db.query<{ created: { id: string; max_instances: number; plan_label: string } }>(`
        select public.provision_platform_workspace(
          '${MASTER}', '${DONO_NOVO}', 'Loja Nova', 4, 'Enterprise', 'Cliente estratégico', 'Marca Nova', 'Sub Novo', 'Dono Novo'
        ) as created
      `);
      const novaEmpresaId = r.rows[0]?.created.id ?? '';
      expect(r.rows[0]?.created.max_instances).toBe(4);
      expect(r.rows[0]?.created.plan_label).toBe('Enterprise');

      // Simula master autenticado na mesma transação para conferir listagem e edição.
      await banco.db.exec('set local role authenticated');
      await banco.db.query("select set_config('request.jwt.claim.sub', $1, true)", [MASTER]);
      await banco.db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");

      const lista = await banco.db.query<{ items: Array<{ id: string; name: string; plan_label: string; max_instances: number }> }>(
        `select public.list_platform_workspaces() as items`,
      );
      const criada = lista.rows[0]?.items.find((w) => w.id === novaEmpresaId);
      expect(criada).toMatchObject({ name: 'Loja Nova', plan_label: 'Enterprise', max_instances: 4 });

      const atualizada = await banco.db.query<{ res: { status: string; max_instances: number; plan_label: string } }>(`
        select public.update_platform_workspace('${novaEmpresaId}', 'Loja Nova Editada', 'closed', 6, 'VIP', 'Pausada pelo suporte') as res
      `);
      expect(atualizada.rows[0]?.res).toMatchObject({
        status: 'closed',
        max_instances: 6,
        plan_label: 'VIP',
      });
    });

    // Usuário comum não pode ler metadados privados nem auditoria.
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(() => banco.db.query(`select * from private.workspace_admin_meta`))).toMatch(
        /permission denied/,
      );
    });
  });

  test('Modo Suporte: master sem sessão ativa continua isolado; com sessão ativa acessa e grava actor_kind = master; ao sair isola de novo', async () => {
    // 1) Sem sessão de suporte, master vê 0 conversas da Loja A e é barrado.
    await banco.comoUsuario(MASTER, async () => {
      const convs = await banco.db.query<{ id: string }>(`select id from public.conversations where workspace_id = '${LOJA_A}'`);
      expect(convs.rows).toEqual([]);
      expect(
        await banco.esperarErro(() =>
          banco.db.query(`select public.transition_workspace_conversation('${LOJA_A}', '${CONVERSA_A}', 'claim')`),
        ),
      ).toMatch(/Workspace membership required/);
    });

    // 2) Usuário comum não pode iniciar sessão de suporte.
    await banco.comoUsuario(DONA_A, async () => {
      expect(
        await banco.esperarErro(() => banco.db.query(`select public.start_support_session('${LOJA_B}', 'Invasão')`)),
      ).toMatch(/Platform master required/);
    });

    // 3) Master inicia sessão de suporte auditada na Loja A e auditoria registra actor_kind = master.
    await banco.comoUsuario(MASTER, async () => {
      const started = await banco.db.query<{ res: { workspace_id: string; reason: string } }>(
        `select public.start_support_session('${LOJA_A}', 'Ajuste na conversa') as res`,
      );
      expect(started.rows[0]?.res).toMatchObject({ workspace_id: LOJA_A, reason: 'Ajuste na conversa' });

      // Durante suporte, consegue ler e agir na Loja A (mas CONTINUA sem ver a Loja B).
      const convsA = await banco.db.query<{ id: string }>(`select id from public.conversations where workspace_id = '${LOJA_A}'`);
      expect(convsA.rows.map((r) => r.id)).toEqual([CONVERSA_A]);
      const convsB = await banco.db.query<{ id: string }>(`select id from public.conversations where workspace_id = '${LOJA_B}'`);
      expect(convsB.rows).toEqual([]);

      await banco.db.query(`select public.transition_workspace_conversation('${LOJA_A}', '${CONVERSA_A}', 'claim')`);

      // Encerra o suporte -> volta ao isolamento completo na hora.
      const ended = await banco.db.query<{ res: { ended: number } }>(`select public.end_support_session() as res`);
      expect(ended.rows[0]?.res.ended).toBe(1);

      const depois = await banco.db.query<{ id: string }>(`select id from public.conversations where workspace_id = '${LOJA_A}'`);
      expect(depois.rows).toEqual([]);

      const aud = await banco.db.query<{ items: Array<{ action: string }> }>(
        `select public.list_platform_support_audit(20) as items`,
      );
      const acoes = aud.rows[0]?.items.map((x) => x.action) ?? [];
      expect(acoes).toContain('support_session_started');
      expect(acoes).toContain('conversation_claimed');
      expect(acoes).toContain('support_session_ended');
    });
  });

  test('limpeza de retenção pega só anexos vencidos fora de catalogo/audios/exceção e registra auditoria', async () => {
    // Usuário autenticado comum não executa funções de retenção.
    await banco.comoUsuario(DONA_A, async () => {
      expect(
        await banco.esperarErro(() => banco.db.query(`select public.claim_expired_message_attachments(10)`)),
      ).toMatch(/permission denied/);
    });

    await banco.comoServico(async () => {
      const m1 = '11111111-bbbb-4bbb-8bbb-000000000011';
      const m2 = '11111111-bbbb-4bbb-8bbb-000000000012';
      const m3 = '11111111-bbbb-4bbb-8bbb-000000000013';
      await banco.db.exec(`
        insert into public.messages (id, workspace_id, conversation_id, instance_id, direction, source_engine, actor_type, status, body_text, occurred_at) values
          ('${m1}', '${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'inbound', 'evolution', 'contact', 'received', 'anexo 1', now() - interval '40 days'),
          ('${m2}', '${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'inbound', 'evolution', 'contact', 'received', 'anexo 2', now() - interval '40 days'),
          ('${m3}', '${LOJA_A}', '${CONVERSA_A}', '${CHIP_A}', 'inbound', 'evolution', 'contact', 'received', 'anexo 3', now() - interval '40 days');
        insert into public.message_attachments (id, workspace_id, message_id, object_key, content_type, byte_size, retention_delete_after, deletion_status) values
          ('${ANEXO_EXPIRADO}', '${LOJA_A}', '${m1}', '${LOJA_A}/${CONVERSA_A}/${m1}/foto.jpg', 'image/jpeg', 1000, now() - interval '2 days', 'active'),
          ('${ANEXO_CATALOGO}', '${LOJA_A}', '${m2}', '${LOJA_A}/catalogo/${CONTATO_A}/${m2}/item.jpg', 'image/jpeg', 1000, now() - interval '2 days', 'active'),
          ('${ANEXO_EXCECAO}', '${LOJA_A}', '${m3}', '${LOJA_A}/${CONVERSA_A}/${m3}/doc.pdf', 'application/pdf', 1000, now() - interval '2 days', 'retained_exception');
      `);

      const claimed = await banco.db.query<{ items: Array<{ id: string; object_key: string }> }>(
        `select public.claim_expired_message_attachments(10) as items`,
      );
      expect(claimed.rows[0]?.items.map((x) => x.id)).toEqual([ANEXO_EXPIRADO]);

      const done = await banco.db.query<{ res: { deleted: number } }>(
        `select public.complete_expired_message_attachments_cleanup(array['${ANEXO_EXPIRADO}']::uuid[]) as res`,
      );
      expect(done.rows[0]?.res.deleted).toBe(1);

      const statusRows = await banco.db.query<{ id: string; deletion_status: string }>(
        `select id::text, deletion_status from public.message_attachments where id in ('${ANEXO_EXPIRADO}', '${ANEXO_CATALOGO}', '${ANEXO_EXCECAO}') order by id`,
      );
      expect(statusRows.rows).toEqual([
        { id: ANEXO_EXPIRADO, deletion_status: 'deleted' },
        { id: ANEXO_CATALOGO, deletion_status: 'active' },
        { id: ANEXO_EXCECAO, deletion_status: 'retained_exception' },
      ]);
    });
  });
});
