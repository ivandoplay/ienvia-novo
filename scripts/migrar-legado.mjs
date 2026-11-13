#!/usr/bin/env node
/**
 * Migração idempotente do Supabase antigo ("ZAP-IA Studio") para o novo ("Ienvia").
 *
 * Regras de segurança:
 *  - Nunca grava, altera ou apaga nada no banco legado (somente GET / leitura de arquivo JSON).
 *  - Por padrão roda em --dry-run (modo de ensaio): só confere e mostra o relatório.
 *  - Só escreve no banco novo quando recebe --aplicar explicitamente.
 *  - Reexecuções são idempotentes: usuários por e-mail, empresas/contatos/instâncias/conversas por UUID v5
 *    determinístico e mensagens por (workspace_id, idempotency_key).
 *
 * Uso:
 *   node scripts/migrar-legado.mjs --dry-run [--arquivo legado.json] [--incluir-campanhas] [--relatorio relatorio.json]
 *   node scripts/migrar-legado.mjs --aplicar [--arquivo legado.json] [--incluir-campanhas] [--relatorio relatorio.json]
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { montarPlanoDeMigracao } from './lib/migracao-legado.mjs';

function analisarArgs(argv) {
  const opcoes = {
    aplicar: false,
    incluirCampanhas: false,
    arquivo: null,
    relatorio: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--aplicar') opcoes.aplicar = true;
    else if (arg === '--dry-run') opcoes.aplicar = false;
    else if (arg === '--incluir-campanhas') opcoes.incluirCampanhas = true;
    else if (arg === '--arquivo' && argv[i + 1]) opcoes.arquivo = argv[++i];
    else if (arg === '--relatorio' && argv[i + 1]) opcoes.relatorio = argv[++i];
  }
  return opcoes;
}

async function lerTabelaLegadoSomenteGet(baseUrl, serviceKey, tabela) {
  const linhas = [];
  const pagina = 1000;
  let inicio = 0;

  while (true) {
    const url = `${baseUrl.replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(tabela)}?select=*`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        range: `${inicio}-${inicio + pagina - 1}`,
        prefer: 'count=exact',
      },
    });
    if (resp.status === 404) {
      return [];
    }
    if (!resp.ok) {
      const corpo = await resp.text().catch(() => '');
      throw new Error(`Falha ao ler ${tabela} no banco legado (${resp.status}): ${corpo.slice(0, 200)}`);
    }
    const lote = await resp.json();
    if (!Array.isArray(lote) || lote.length === 0) break;
    linhas.push(...lote);
    if (lote.length < pagina) break;
    inicio += pagina;
  }

  return linhas;
}

async function carregarSnapshotLegado(opcoes) {
  if (opcoes.arquivo) {
    const texto = await fs.readFile(path.resolve(opcoes.arquivo), 'utf8');
    return JSON.parse(texto);
  }

  const legadoUrl = process.env.LEGACY_SUPABASE_URL?.trim();
  const legadoKey = process.env.LEGACY_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!legadoUrl || !legadoKey) {
    throw new Error(
      'Informe --arquivo <snapshot.json> ou defina LEGACY_SUPABASE_URL e LEGACY_SUPABASE_SERVICE_ROLE_KEY (somente leitura).',
    );
  }

  const tabelas = [
    'zapia_users',
    'zapia_workspaces',
    'zapia_contacts',
    'ienvia_crm_contacts',
    'zapia_wa_slots',
    'ienvia_channels',
    'ienvia_instance_messages',
  ];
  if (opcoes.incluirCampanhas) tabelas.push('ienvia_campanha_destinatarios');

  const resultado = {};
  for (const tabela of tabelas) {
    resultado[tabela] = await lerTabelaLegadoSomenteGet(legadoUrl, legadoKey, tabela);
  }
  return resultado;
}

async function listarUsuariosExistentesPorEmail(supabaseNovo) {
  const mapa = new Map();
  let page = 1;
  while (true) {
    const { data, error } = await supabaseNovo.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Erro ao listar usuários do destino: ${error.message}`);
    const lista = data?.users ?? [];
    for (const u of lista) {
      if (u.email) mapa.set(u.email.toLowerCase(), u.id);
    }
    if (lista.length < 200) break;
    page += 1;
  }
  return mapa;
}

async function executar() {
  const opcoes = analisarArgs(process.argv.slice(2));
  const snapshot = await carregarSnapshotLegado(opcoes);
  const plano = montarPlanoDeMigracao(snapshot, { incluirCampanhas: opcoes.incluirCampanhas });

  const novoUrl = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
  const novoKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  const relatorio = {
    modo: opcoes.aplicar ? 'aplicar' : 'dry-run',
    executadoEm: new Date().toISOString(),
    origem: opcoes.arquivo ? `arquivo:${opcoes.arquivo}` : 'legacy-supabase-get-only',
    leitura: plano.resumoLeitura,
    planejado: {
      usuarios: plano.usuarios.length,
      workspaces: plano.workspaces.length,
      instanciasDesconectadas: plano.instancias.length,
      contatos: plano.contatos.length,
      conversas: plano.conversas.length,
      mensagens: plano.mensagens.length,
      campanhasHistorico: plano.campanhasHistorico.length,
    },
    resultado: {
      usuariosCriados: 0,
      usuariosExistentes: 0,
      workspacesGravados: 0,
      instanciasGravadas: 0,
      contatosGravados: 0,
      conversasGravadas: 0,
      mensagensGravadas: 0,
      campanhasGravadas: 0,
      erros: [],
    },
  };

  if (novoUrl && novoKey) {
    const supabaseNovo = createClient(novoUrl, novoKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const usuariosPorEmail = await listarUsuariosExistentesPorEmail(supabaseNovo);

    // 1) Usuários
    for (const u of plano.usuarios) {
      if (usuariosPorEmail.has(u.email)) {
        relatorio.resultado.usuariosExistentes += 1;
        continue;
      }
      if (!opcoes.aplicar) {
        relatorio.resultado.usuariosCriados += 1;
        continue;
      }
      const senhaTemp = `Migrado-${crypto.randomBytes(12).toString('hex')}`;
      const { data: criado, error } = await supabaseNovo.auth.admin.createUser({
        email: u.email,
        password: senhaTemp,
        email_confirm: true,
        user_metadata: { display_name: u.displayName, migrated_from: 'zapia_studio' },
      });
      if (error || !criado.user) {
        relatorio.resultado.erros.push(`Usuário ${u.email}: ${error?.message ?? 'erro desconhecido'}`);
        continue;
      }
      usuariosPorEmail.set(u.email, criado.user.id);
      relatorio.resultado.usuariosCriados += 1;
      await supabaseNovo.from('profiles').upsert({ id: criado.user.id, display_name: u.displayName }, { onConflict: 'id' });
    }

    if (opcoes.aplicar) {
      // 2) Workspaces + política + participações + treinamento padrão
      for (const ws of plano.workspaces) {
        const { error: errWs } = await supabaseNovo.from('workspaces').upsert(
          {
            id: ws.targetId,
            name: ws.name,
            brand_name: ws.brandName,
            brand_subtitle: ws.brandSubtitle,
            status: 'active',
            max_instances: ws.maxInstances,
          },
          { onConflict: 'id' },
        );
        if (errWs) {
          relatorio.resultado.erros.push(`Workspace ${ws.name}: ${errWs.message}`);
          continue;
        }
        relatorio.resultado.workspacesGravados += 1;

        await supabaseNovo.from('workspace_data_policies').upsert({ workspace_id: ws.targetId }, { onConflict: 'workspace_id' });

        if (ws.ownerEmail && usuariosPorEmail.has(ws.ownerEmail)) {
          await supabaseNovo.from('workspace_memberships').upsert(
            {
              workspace_id: ws.targetId,
              user_id: usuariosPorEmail.get(ws.ownerEmail),
              role: 'owner',
              status: 'active',
            },
            { onConflict: 'workspace_id,user_id' },
          );
        }

        const { data: existeAgente } = await supabaseNovo
          .from('ai_agents')
          .select('id')
          .eq('workspace_id', ws.targetId)
          .eq('is_default', true)
          .maybeSingle();

        if (!existeAgente) {
          await supabaseNovo.from('ai_agents').insert({
            workspace_id: ws.targetId,
            label: 'Principal',
            is_default: true,
            business_name: ws.treinamento.businessName,
            niche: ws.treinamento.niche,
            assistant_name: ws.treinamento.assistantName,
            company_summary: ws.treinamento.companySummary,
            commercial_terms: ws.treinamento.commercialTerms,
            golden_rules: ws.treinamento.goldenRules,
            extra_instructions: ws.treinamento.extraInstructions,
          });
        }
      }

      // 3) Instâncias (sempre desconectadas)
      if (plano.instancias.length > 0) {
        const { error } = await supabaseNovo.from('instances').upsert(
          plano.instancias.map((i) => ({
            id: i.targetId,
            workspace_id: i.workspaceId,
            channel: i.channel,
            engine: i.engine,
            display_name: i.displayName,
            connected_phone: i.connectedPhone,
            status: 'disconnected',
            is_enabled: false,
          })),
          { onConflict: 'id' },
        );
        if (error) relatorio.resultado.erros.push(`Instâncias: ${error.message}`);
        else relatorio.resultado.instanciasGravadas = plano.instancias.length;
      }

      // 4) Contatos
      for (let i = 0; i < plano.contatos.length; i += 200) {
        const lote = plano.contatos.slice(i, i + 200);
        const { error } = await supabaseNovo.from('contacts').upsert(
          lote.map((c) => ({
            id: c.targetId,
            workspace_id: c.workspaceId,
            channel: c.channel,
            external_user_id: c.externalUserId,
            phone_e164: c.phoneE164,
            email: c.email,
            display_name: c.displayName,
            company: c.company,
            city: c.city,
            notes: c.notes,
          })),
          { onConflict: 'id' },
        );
        if (error) relatorio.resultado.erros.push(`Contatos (${i}): ${error.message}`);
        else relatorio.resultado.contatosGravados += lote.length;
      }

      // 5) Conversas
      for (let i = 0; i < plano.conversas.length; i += 200) {
        const lote = plano.conversas.slice(i, i + 200);
        const { error } = await supabaseNovo.from('conversations').upsert(
          lote.map((cv) => ({
            id: cv.targetId,
            workspace_id: cv.workspaceId,
            contact_id: cv.contactId,
            instance_id: cv.instanceId,
            stage: cv.stage,
            last_message_at: cv.lastMessageAt,
            last_message_preview: cv.lastMessagePreview,
          })),
          { onConflict: 'id' },
        );
        if (error) relatorio.resultado.erros.push(`Conversas (${i}): ${error.message}`);
        else relatorio.resultado.conversasGravadas += lote.length;
      }

      // 6) Mensagens (deduplicadas por idempotency_key)
      for (let i = 0; i < plano.mensagens.length; i += 200) {
        const lote = plano.mensagens.slice(i, i + 200);
        const { error } = await supabaseNovo.from('messages').upsert(
          lote.map((m) => ({
            id: m.targetId,
            workspace_id: m.workspaceId,
            conversation_id: m.conversationId,
            instance_id: m.instanceId,
            idempotency_key: m.idempotencyKey,
            direction: m.direction,
            source_engine: m.sourceEngine,
            actor_type: m.actorType,
            status: m.status,
            body_text: m.bodyText,
            occurred_at: m.occurredAt,
          })),
          { onConflict: 'workspace_id,idempotency_key', ignoreDuplicates: true },
        );
        if (error) relatorio.resultado.erros.push(`Mensagens (${i}): ${error.message}`);
        else relatorio.resultado.mensagensGravadas += lote.length;
      }

      // 7) Campanhas históricas (opcional)
      for (const camp of plano.campanhasHistorico) {
        const { error: errCamp } = await supabaseNovo.from('campaigns').upsert(
          {
            id: camp.targetId,
            workspace_id: camp.workspaceId,
            name: camp.name,
            status: camp.status,
            text_body: camp.textBody,
          },
          { onConflict: 'id' },
        );
        if (errCamp) {
          relatorio.resultado.erros.push(`Campanha histórica ${camp.workspaceId}: ${errCamp.message}`);
          continue;
        }
        for (let i = 0; i < camp.destinatarios.length; i += 200) {
          const lote = camp.destinatarios.slice(i, i + 200);
          await supabaseNovo.from('campaign_recipients').upsert(
            lote.map((d) => ({
              id: d.targetId,
              workspace_id: d.workspaceId,
              campaign_id: d.campaignId,
              contact_id: d.contactId,
              instance_id: d.instanceId,
              status: d.status,
              idempotency_key: d.idempotencyKey,
            })),
            { onConflict: 'workspace_id,campaign_id,contact_id', ignoreDuplicates: true },
          );
        }
        relatorio.resultado.campanhasGravadas += 1;
      }
    }
  } else {
    relatorio.resultado.avisoDestino =
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não definidas; executado apenas planejamento em memória.';
  }

  if (opcoes.relatorio) {
    await fs.writeFile(path.resolve(opcoes.relatorio), JSON.stringify(relatorio, null, 2), 'utf8');
  }

  console.log(JSON.stringify(relatorio, null, 2));
  if (relatorio.resultado.erros.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executar().catch((erro) => {
    console.error('[migrar-legado] erro:', erro.message);
    process.exit(1);
  });
}
