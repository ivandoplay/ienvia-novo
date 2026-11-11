/**
 * Chips (instâncias): quem pode criar, renomear, conferir, trocar o segredo e remover,
 * o limite de chips por conta e os avisos de conexão que chegam da Evolution.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import {
  ATENDENTE_A,
  CHIP_A,
  CHIP_B,
  CONVERSA_A,
  DONA_A,
  DONO_B,
  INTRUSO,
  LOJA_A,
  LOJA_B,
  MASTER,
  SUSPENSO_A,
  bancoComCenario,
} from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await bancoComCenario();
});

const RESUMO = 'a'.repeat(64);
const OUTRO_RESUMO = 'b'.repeat(64);
const NOME_NA_EVOLUTION = 'ienvia-teste-0001';

/** Dentro de uma transação aberta por `comoUsuario`: faz algo como administrador do banco e volta ao usuário. */
async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await banco.db.exec('reset role');
  try {
    return await fn();
  } finally {
    await banco.db.exec('set local role authenticated');
  }
}

const definirLimite = (workspace: string, limite: number) =>
  comoAdmin(() => banco.db.exec(`update public.workspaces set max_instances = ${limite} where id = '${workspace}'`));

async function criarChip(
  workspace: string,
  { nome = 'Comercial', funcao = 'attendance', provedor = NOME_NA_EVOLUTION, resumo = RESUMO } = {},
): Promise<string> {
  const { rows } = await banco.db.query<{ r: { id: string } }>(
    'select public.create_my_evolution_instance($1,$2,$3,$4,$5) as r',
    [workspace, nome, funcao, provedor, resumo],
  );
  return rows[0]!.r.id;
}

async function lerChip(id: string) {
  const { rows } = await banco.db.query<Record<string, unknown>>(
    `select display_name, purpose, status, is_enabled, engine, connected_phone, (last_seen_at is not null) as visto
       from public.instances where id = $1`,
    [id],
  );
  return rows[0];
}

const contarAuditoria = (id: string, acao: string) =>
  comoAdmin(async () => {
    const { rows } = await banco.db.query<{ n: number }>(
      'select count(*)::int as n from private.audit_events where target_id = $1 and action = $2',
      [id, acao],
    );
    return rows[0]!.n;
  });

describe('criar chip', () => {
  test('nasce desconectado, com a IA desligada, e guarda só o resumo do segredo do aviso', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await definirLimite(LOJA_A, 3);
      const id = await criarChip(LOJA_A, { nome: '  Vendas  ', funcao: 'both' });

      expect(await lerChip(id)).toEqual({
        display_name: 'Vendas',
        purpose: 'both',
        status: 'disconnected',
        is_enabled: false,
        engine: 'evolution',
        connected_phone: null,
        visto: false,
      });

      const segredo = await comoAdmin(() =>
        banco.db.query('select token_sha256 from private.evolution_webhook_auth where instance_id = $1', [id]),
      );
      expect(segredo.rows).toEqual([{ token_sha256: RESUMO }]);
      expect(await contarAuditoria(id, 'instance_created')).toBe(1);
    });
  });

  test('respeita o limite de chips da conta; chip removido não conta', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      // A Loja A já tem 1 chip no cenário e o limite padrão é 1.
      expect(await banco.esperarErro(() => criarChip(LOJA_A))).toMatch(/instance_limit_reached/);

      await definirLimite(LOJA_A, 2);
      const id = await criarChip(LOJA_A);
      expect(await banco.esperarErro(() => criarChip(LOJA_A, { provedor: 'ienvia-teste-0002' }))).toMatch(
        /instance_limit_reached/,
      );

      await banco.db.query('select public.remove_my_instance($1,$2)', [LOJA_A, id]);
      await criarChip(LOJA_A, { provedor: 'ienvia-teste-0003' });
    });
  });

  test('o dono não consegue aumentar o próprio limite', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(
        await banco.esperarErro(() =>
          banco.db.exec(`update public.workspaces set max_instances = 50 where id = '${LOJA_A}'`),
        ),
      ).toMatch(/permission denied/);
    });
  });

  test.each([
    ['apelido vazio', { nome: '   ' }, /Invalid display name/],
    ['apelido longo demais', { nome: 'x'.repeat(61) }, /Invalid display name/],
    ['função desconhecida', { funcao: 'tudo' }, /Invalid purpose/],
    ['nome inválido na Evolution', { provedor: 'com espaço' }, /Invalid provider instance name/],
    ['resumo do segredo inválido', { resumo: 'segredo-em-texto-puro' }, /Invalid webhook token digest/],
  ])('recusa %s', async (_caso, opcoes, mensagem) => {
    await banco.comoUsuario(DONA_A, async () => {
      await definirLimite(LOJA_A, 3);
      expect(await banco.esperarErro(() => criarChip(LOJA_A, opcoes))).toMatch(mensagem);
    });
  });
});

describe('só o dono da própria empresa mexe nos chips', () => {
  const chamadas: Array<[string, string, unknown[]]> = [
    ['criar', 'select public.create_my_evolution_instance($1,$2,$3,$4,$5)', [LOJA_A, 'Pirata', 'both', 'ienvia-pirata-01', RESUMO]],
    ['renomear', 'select public.update_my_instance_settings($1,$2,$3,$4)', [LOJA_A, CHIP_A, 'Pirata', 'both']],
    ['conferir', 'select public.sync_my_evolution_instance($1,$2,$3,$4)', [LOJA_A, CHIP_A, 'close', null]],
    ['trocar o segredo', 'select public.rotate_my_evolution_webhook_token($1,$2,$3)', [LOJA_A, CHIP_A, OUTRO_RESUMO]],
    ['remover', 'select public.remove_my_instance($1,$2)', [LOJA_A, CHIP_A]],
  ];
  const intrometidos: Array<[string, string]> = [
    ['a atendente da própria loja', ATENDENTE_A],
    ['o dono de outra loja', DONO_B],
    ['quem não participa de nenhuma empresa', INTRUSO],
    ['o funcionário suspenso', SUSPENSO_A],
    ['o administrador da plataforma', MASTER],
  ];

  test.each(intrometidos)('%s não consegue criar, renomear, conferir, trocar o segredo nem remover', async (_quem, usuario) => {
    await banco.comoUsuario(usuario, async () => {
      for (const [, sql, parametros] of chamadas) {
        expect(await banco.esperarErro(() => banco.db.query(sql, parametros))).toMatch(/Workspace owner required/);
      }
    });
  });

  test('visitante sem login não executa nenhuma das funções', async () => {
    await banco.comoAnonimo(async () => {
      for (const [, sql, parametros] of chamadas) {
        expect(await banco.esperarErro(() => banco.db.query(sql, parametros))).toMatch(/permission denied/);
      }
    });
  });

  test('a dona da Loja A não alcança o chip da Loja B nem usando a própria empresa como endereço', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      for (const [, sql, parametros] of chamadas.slice(1)) {
        const comChipAlheio = parametros.map((valor) => (valor === CHIP_A ? CHIP_B : valor));
        expect(await banco.esperarErro(() => banco.db.query(sql, comChipAlheio))).toMatch(/Instance not found/);
      }
    });
    await banco.comoUsuario(DONO_B, async () => {
      expect(await lerChip(CHIP_B)).toMatchObject({ display_name: 'Chip da Loja B', status: 'disconnected' });
    });
  });

  test('as funções antigas de cadastro, que não respeitavam o limite, não existem mais', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(
        await banco.esperarErro(() =>
          banco.db.query('select public.register_my_evolution_instance($1::uuid,$2::text,$3::text,$4::text)', [
            LOJA_A,
            'Antigo',
            'ienvia-antigo-01',
            RESUMO,
          ]),
        ),
      ).toMatch(/does not exist/);
    });
  });
});

describe('apelido, função e estado', () => {
  test('a dona muda o apelido e a função do chip', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await banco.db.query('select public.update_my_instance_settings($1,$2,$3,$4)', [LOJA_A, CHIP_A, ' Suporte ', 'campaigns']);
      expect(await lerChip(CHIP_A)).toMatchObject({ display_name: 'Suporte', purpose: 'campaigns' });
      expect(
        await banco.esperarErro(() =>
          banco.db.query('select public.update_my_instance_settings($1,$2,$3,$4)', [LOJA_A, CHIP_A, 'Suporte', 'tudo']),
        ),
      ).toMatch(/Invalid purpose/);
    });
  });

  test('conferir grava o estado, o número e só registra auditoria quando o estado muda', async () => {
    const conferir = (estado: string, telefone: string | null = null) =>
      banco.db.query('select public.sync_my_evolution_instance($1,$2,$3,$4)', [LOJA_A, CHIP_A, estado, telefone]);

    await banco.comoUsuario(DONA_A, async () => {
      // No cenário o chip da Loja A começa "connected".
      await conferir('close');
      await conferir('close');
      expect(await lerChip(CHIP_A)).toMatchObject({ status: 'disconnected', connected_phone: null });
      expect(await contarAuditoria(CHIP_A, 'instance_status_changed')).toBe(1);

      await conferir('open', '+5586988887777');
      expect(await lerChip(CHIP_A)).toMatchObject({ status: 'connected', connected_phone: '+5586988887777', visto: true });

      await conferir('connecting');
      expect(await lerChip(CHIP_A)).toMatchObject({ status: 'connecting', connected_phone: '+5586988887777' });
      expect(await contarAuditoria(CHIP_A, 'instance_status_changed')).toBe(3);

      expect(await banco.esperarErro(() => conferir('voando'))).toMatch(/Unsupported provider state/);
      expect(await banco.esperarErro(() => conferir('open', '86988887777'))).toMatch(/Invalid connected phone/);
    });
  });

  test('conferir só vale para chip da Evolution (o motor local terá o seu próprio caminho)', async () => {
    await banco.comoUsuario(DONO_B, async () => {
      expect(
        await banco.esperarErro(() =>
          banco.db.query('select public.sync_my_evolution_instance($1,$2,$3,$4)', [LOJA_B, CHIP_B, 'open', null]),
        ),
      ).toMatch(/Instance not found/);
    });
  });

  test('trocar o segredo substitui o resumo guardado', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await definirLimite(LOJA_A, 2);
      const id = await criarChip(LOJA_A);
      await banco.db.query('select public.rotate_my_evolution_webhook_token($1,$2,$3)', [LOJA_A, id, OUTRO_RESUMO]);
      const { rows } = await comoAdmin(() =>
        banco.db.query('select token_sha256 from private.evolution_webhook_auth where instance_id = $1', [id]),
      );
      expect(rows).toEqual([{ token_sha256: OUTRO_RESUMO }]);
    });
  });
});

describe('remover chip', () => {
  test('o chip sai da lista, o histórico fica e os avisos antigos deixam de ser aceitos', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await banco.db.query('select public.rotate_my_evolution_webhook_token($1,$2,$3)', [LOJA_A, CHIP_A, RESUMO]);
      await comoAdmin(() =>
        banco.db.exec(`update public.instances set provider_instance_name = '${NOME_NA_EVOLUTION}' where id = '${CHIP_A}'`),
      );

      await banco.db.query('select public.remove_my_instance($1,$2)', [LOJA_A, CHIP_A]);

      expect(await lerChip(CHIP_A)).toMatchObject({ status: 'revoked', is_enabled: false });
      const conversas = await banco.db.query('select id from public.conversations where id = $1', [CONVERSA_A]);
      expect(conversas.rows).toHaveLength(1);

      const aviso = await comoAdmin(() =>
        banco.db.query<{ r: { result: string } }>(
          `select public.ingest_evolution_text($1,$2,'evento-1','MESSAGES_UPSERT','5586900000009@s.whatsapp.net','Fulano','oi',now(),false) as r`,
          [NOME_NA_EVOLUTION, RESUMO],
        ),
      );
      expect(aviso.rows[0]!.r.result).toBe('unauthorized');

      for (const sql of [
        'select public.remove_my_instance($1,$2)',
        `select public.update_my_instance_settings($1,$2,'Novo nome','both')`,
        `select public.sync_my_evolution_instance($1,$2,'open',null)`,
      ]) {
        expect(await banco.esperarErro(() => banco.db.query(sql, [LOJA_A, CHIP_A]))).toMatch(/Instance not found/);
      }
    });
  });
});

describe('aviso de conexão vindo da Evolution', () => {
  const avisar = (nome: string, resumo: string, estado: string, telefone: string | null) =>
    banco.db.query<{ r: { result: string; status?: string } }>(
      'select public.apply_evolution_connection_update($1,$2,$3,$4) as r',
      [nome, resumo, estado, telefone],
    );

  test('o servidor atualiza o chip certo; segredo errado e estado desconhecido não mudam nada', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      await definirLimite(LOJA_A, 2);
      const id = await criarChip(LOJA_A);

      const resultados = await comoAdmin(async () => ({
        segredoErrado: (await avisar(NOME_NA_EVOLUTION, OUTRO_RESUMO, 'open', null)).rows[0]!.r,
        chipInexistente: (await avisar('ienvia-nao-existe', RESUMO, 'open', null)).rows[0]!.r,
        estadoEstranho: (await avisar(NOME_NA_EVOLUTION, RESUMO, 'voando', null)).rows[0]!.r,
        conectou: (await avisar(NOME_NA_EVOLUTION, RESUMO, 'open', '+5585999990000')).rows[0]!.r,
      }));

      expect(resultados.segredoErrado).toEqual({ result: 'unauthorized' });
      expect(resultados.chipInexistente).toEqual({ result: 'unauthorized' });
      expect(resultados.estadoEstranho).toEqual({ result: 'ignored' });
      expect(resultados.conectou).toMatchObject({ result: 'applied', status: 'connected', instance_id: id });
      expect(await lerChip(id)).toMatchObject({ status: 'connected', connected_phone: '+5585999990000', visto: true });
      expect(await contarAuditoria(id, 'instance_status_changed')).toBe(1);
    });
  });

  test('só o servidor chama: usuário logado e visitante são barrados', async () => {
    await banco.comoUsuario(DONA_A, async () => {
      expect(await banco.esperarErro(() => avisar(NOME_NA_EVOLUTION, RESUMO, 'open', null))).toMatch(/permission denied/);
    });
    await banco.comoAnonimo(async () => {
      expect(await banco.esperarErro(() => avisar(NOME_NA_EVOLUTION, RESUMO, 'open', null))).toMatch(/permission denied/);
    });
    await banco.comoServico(async () => {
      expect((await avisar('ienvia-nao-existe', RESUMO, 'open', null)).rows[0]!.r).toEqual({ result: 'unauthorized' });
    });
  });
});
