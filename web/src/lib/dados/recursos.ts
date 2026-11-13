import 'server-only';

import { lerConfiguracaoPix, type ConfiguracaoPix } from '@ienvia/shared/recursos-pix';
import { type AudioEstrategico, type ItemDoCatalogo } from '@ienvia/shared/recursos';
import { normalizarSessaoSimulador, type SessaoSimulador } from '@ienvia/shared/simulador';
import { lerMotorDeIa } from '@/lib/dados/ia';
import { lerBasesDeTreinamento } from '@/lib/dados/treinamento';
import { modeloDoProvedor, NOME_DO_PROVEDOR, ordemDeUso, type Provedor } from '@/lib/ia/regras';
import { mapearAudiosEstrategicos, mapearCatalogo } from '@/lib/recursos/mapeamento';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export interface DadosDoCatalogo {
  pix: ConfiguracaoPix;
  itens: ItemDoCatalogo[];
  erroLeitura?: string;
}

export interface DadosDosAudios {
  audios: AudioEstrategico[];
  erroLeitura?: string;
}

export interface DadosDoSimulador {
  sessao: SessaoSimulador;
  bases: Array<{ id: string; rotulo: string; padrao: boolean }>;
  motorConfigurado: boolean;
  provedorPrincipal: Provedor;
  nomeProvedorPrincipal: string;
  modeloPrincipal: string;
  catalogo: ItemDoCatalogo[];
  audios: AudioEstrategico[];
  pix: ConfiguracaoPix;
  erroLeitura?: string;
}

export interface RecursosParaInbox {
  pix: ConfiguracaoPix;
  catalogo: ItemDoCatalogo[];
  audios: AudioEstrategico[];
}

export async function carregarDadosCatalogo(workspaceId: string): Promise<DadosDoCatalogo> {
  const supabase = await criarClienteServidor();
  const [resPix, resCatalogo] = await Promise.all([
    supabase.rpc('read_my_pix_settings', { p_workspace_id: workspaceId }),
    supabase.rpc('list_my_catalog_items', { p_workspace_id: workspaceId }),
  ]);

  const erro = resPix.error || resCatalogo.error;
  if (erro) {
    console.error('[catalogo] erro ao ler dados:', erro);
  }

  return {
    pix: lerConfiguracaoPix(resPix.data),
    itens: mapearCatalogo(resCatalogo.data),
    erroLeitura: erro ? 'Não foi possível carregar todos os dados do catálogo agora.' : undefined,
  };
}

export async function carregarDadosAudios(workspaceId: string): Promise<DadosDosAudios> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('list_my_voice_library', { p_workspace_id: workspaceId });
  if (error) {
    console.error('[audios] erro ao listar biblioteca de áudios:', error);
    return { audios: [], erroLeitura: 'Não foi possível carregar a biblioteca de áudios agora.' };
  }
  return { audios: mapearAudiosEstrategicos(data) };
}

export async function carregarDadosSimulador(workspaceId: string): Promise<DadosDoSimulador> {
  const supabase = await criarClienteServidor();
  const [resSessao, resBases, resMotor, resCatalogo, resAudios, resPix] = await Promise.all([
    supabase.rpc('read_my_simulator_session', { p_workspace_id: workspaceId }),
    lerBasesDeTreinamento(workspaceId),
    lerMotorDeIa(workspaceId),
    supabase.rpc('list_my_catalog_items', { p_workspace_id: workspaceId }),
    supabase.rpc('list_my_voice_library', { p_workspace_id: workspaceId }),
    supabase.rpc('read_my_pix_settings', { p_workspace_id: workspaceId }),
  ]);

  const motor = resMotor.motor;
  const chavesConfiguradas = motor
    ? ordemDeUso(motor.configuracao).filter((p) => motor.chaves[p].cadastrada)
    : [];
  const provedorPrincipal: Provedor = chavesConfiguradas[0] ?? motor?.configuracao.provedor ?? 'nvidia';
  const modeloPrincipal = motor ? modeloDoProvedor(motor.configuracao, provedorPrincipal) : '';

  const sessaoBruta =
    resSessao.data && typeof resSessao.data === 'object' && !Array.isArray(resSessao.data)
      ? (resSessao.data as Record<string, unknown>)
      : {};

  const erro = resSessao.error || resCatalogo.error || resAudios.error || resPix.error || resBases.falhou || resMotor.falhou;

  return {
    sessao: normalizarSessaoSimulador({
      agentId: typeof sessaoBruta.agent_id === 'string' ? sessaoBruta.agent_id : null,
      history: sessaoBruta.history,
      updatedAt: typeof sessaoBruta.updated_at === 'string' ? sessaoBruta.updated_at : null,
    }),
    bases: (resBases.lista?.bases ?? []).map((b) => ({ id: b.id, rotulo: b.rotulo, padrao: b.padrao })),
    motorConfigurado: chavesConfiguradas.length > 0 && Boolean(resBases.lista?.bases.length),
    provedorPrincipal,
    nomeProvedorPrincipal: NOME_DO_PROVEDOR[provedorPrincipal],
    modeloPrincipal,
    catalogo: mapearCatalogo(resCatalogo.data),
    audios: mapearAudiosEstrategicos(resAudios.data),
    pix: lerConfiguracaoPix(resPix.data),
    erroLeitura: erro ? 'Alguns dados do simulador falharam ao carregar. Recarregue se notar algo faltando.' : undefined,
  };
}

export async function carregarRecursosDaInbox(workspaceId: string): Promise<RecursosParaInbox> {
  const supabase = await criarClienteServidor();
  const [resPix, resCatalogo, resAudios] = await Promise.all([
    supabase.rpc('read_my_pix_settings', { p_workspace_id: workspaceId }),
    supabase.rpc('list_my_catalog_items', { p_workspace_id: workspaceId }),
    supabase.rpc('list_my_voice_library', { p_workspace_id: workspaceId }),
  ]);

  return {
    pix: lerConfiguracaoPix(resPix.data),
    catalogo: mapearCatalogo(resCatalogo.data).filter((item) => item.active !== false),
    audios: mapearAudiosEstrategicos(resAudios.data),
  };
}
