'use server';

import { createHash, randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { explicarRecusaDoChip } from '@/lib/atendente/painel';
import { enderecoDoAviso, lerConfigEvolution } from '@/lib/env';
import {
  ErroEvolution,
  apagarInstancia,
  avisoEstaEmDia,
  configurarAviso,
  consultarAviso,
  consultarChip,
  criarInstancia,
  desconectarInstancia,
  pedirQrCode,
  type Aviso,
  type EstadoNaEvolution,
  type QrCode,
} from '@/lib/evolution/cliente';
import {
  ehFuncaoDoChip,
  ehIdentificador,
  gerarNomeNaEvolution,
  normalizarNumeroParaPareamento,
  validarApelido,
} from '@/lib/instancias/regras';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Ações da tela de Instâncias. Todas rodam no servidor, com a sessão de quem está logado:
 * o banco confere de novo se a pessoa é a dona da conta antes de aceitar qualquer mudança.
 */

export type Resultado<T = object> = ({ ok: true } & T) | { ok: false; erro: string };

export interface EstadoDoFormulario {
  ok?: boolean;
  erro?: string;
  /** Chip criado ou alterado. */
  chipId?: string;
  /** Motor escolhido na criação (`evolution` ou `baileys`). */
  motor?: 'evolution' | 'baileys';
  /** Primeiro QR Code do chip novo (quando a Evolution respondeu a tempo). */
  qr?: QrCode | null;
}

type Supabase = Awaited<ReturnType<typeof criarClienteServidor>>;

interface Contexto {
  supabase: Supabase;
  workspaceId: string;
}

interface LinhaDoChip {
  id: string;
  provider_instance_name: string | null;
  engine: string;
  status: string;
  connected_phone?: string | null;
  local_executor_id?: string | null;
  pairing_qr?: string | null;
  pairing_code?: string | null;
}

const SEM_PERMISSAO = 'Só o dono da conta pode mexer nos chips.';
const SESSAO_EXPIRADA = 'Sua sessão exprou. Entre de novo.'.replace('exprou', 'expirou');
const CHIP_NAO_ENCONTRADO = 'Este chip não existe mais. Atualize a página.';

async function abrirContexto(): Promise<Contexto | { erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { erro: SEM_PERMISSAO };
  return { supabase: await criarClienteServidor(), workspaceId: sessao.workspaceAtivo.id };
}

async function buscarChip(contexto: Contexto, chipId: unknown): Promise<LinhaDoChip | null> {
  if (!ehIdentificador(chipId)) return null;
  const { data, error } = await contexto.supabase
    .from('instances')
    .select('id, provider_instance_name, engine, status, connected_phone, local_executor_id, pairing_qr, pairing_code')
    .eq('workspace_id', contexto.workspaceId)
    .eq('id', chipId)
    .neq('status', 'revoked')
    .maybeSingle<LinhaDoChip>();
  if (error) console.error('[instâncias] não foi possível ler o chip:', error);
  return data ?? null;
}

/** Segredo novo para os avisos da Evolution. No banco fica só o resumo (SHA-256). */
function novoSegredo(): { token: string; resumo: string } {
  const token = randomBytes(32).toString('hex');
  return { token, resumo: createHash('sha256').update(token).digest('hex') };
}

function registrarErro(onde: string, erro: unknown): void {
  if (erro instanceof ErroEvolution) {
    console.error(`[instâncias] ${onde}:`, { motivo: erro.motivo, status: erro.status, mensagem: erro.message });
  } else {
    console.error(`[instâncias] ${onde}:`, erro);
  }
}

function mensagemDaEvolution(erro: unknown): string {
  if (erro instanceof ErroEvolution) {
    if (erro.motivo === 'nao_configurada') return 'A conexão com a Evolution ainda não foi configurada neste ambiente.';
    if (erro.motivo === 'incerta') return 'A Evolution demorou a responder. Espere um instante e tente de novo.';
    if (erro.motivo === 'nao_encontrada') return 'Este chip não foi encontrado na Evolution.';
    return 'A Evolution recusou o pedido. Tente de novo em instantes.';
  }
  return 'Algo deu errado do nosso lado. Tente de novo em instantes.';
}

function atualizarTelas(): void {
  revalidatePath('/instancias');
  revalidatePath('/conexoes');
  revalidatePath('/visao-geral');
}

/** Grava no banco o estado que a Evolution informou. Devolve o que ficou gravado. */
async function gravarEstado(
  contexto: Contexto,
  chipId: string,
  estado: EstadoNaEvolution,
  telefone: string | null,
): Promise<{ estado: string; telefone: string | null } | null> {
  const { data, error } = await contexto.supabase.rpc('sync_my_evolution_instance', {
    p_workspace_id: contexto.workspaceId,
    p_instance_id: chipId,
    p_provider_state: estado,
    p_connected_phone: telefone,
  });
  if (error) {
    console.error('[instâncias] não foi possível gravar o estado do chip:', error);
    return null;
  }
  const gravado = data as { status: string; connected_phone: string | null };
  return { estado: gravado.status, telefone: gravado.connected_phone };
}

async function trocarSegredo(contexto: Contexto, chipId: string): Promise<string | null> {
  const segredo = novoSegredo();
  const { error } = await contexto.supabase.rpc('rotate_my_evolution_webhook_token', {
    p_workspace_id: contexto.workspaceId,
    p_instance_id: chipId,
    p_webhook_token_sha256: segredo.resumo,
  });
  if (error) {
    console.error('[instâncias] não foi possível trocar o segredo do aviso:', error);
    return null;
  }
  return segredo.token;
}

async function garantirAviso(contexto: Contexto, chip: LinhaDoChip): Promise<void> {
  const url = enderecoDoAviso();
  if (!url || !chip.provider_instance_name) return;
  try {
    const atual = await consultarAviso(chip.provider_instance_name);
    if (avisoEstaEmDia(atual, url)) return;
    const token = await trocarSegredo(contexto, chip.id);
    if (token) await configurarAviso(chip.provider_instance_name, { url, token });
  } catch (erro) {
    registrarErro('não foi possível conferir o aviso de mensagens', erro);
  }
}

async function criarNaEvolution(contexto: Contexto, chip: LinhaDoChip, numero?: string): Promise<QrCode> {
  const url = enderecoDoAviso();
  let aviso: Aviso | null = null;
  if (url) {
    const token = await trocarSegredo(contexto, chip.id);
    if (token) aviso = { url, token };
  }
  return criarInstancia({ nome: chip.provider_instance_name!, aviso, ...(numero ? { numero } : {}) });
}

// ───────────────────────────── ações ─────────────────────────────

/** Formulário "Adicionar chip": suporta Nuvem (Evolution) ou Motor local (Baileys). */
export async function adicionarChip(_anterior: EstadoDoFormulario, dados: FormData): Promise<EstadoDoFormulario> {
  const apelido = validarApelido(String(dados.get('apelido') ?? ''));
  const funcao = dados.get('funcao');
  const motorBruto = dados.get('motor');
  const motor: 'evolution' | 'baileys' = motorBruto === 'baileys' ? 'baileys' : 'evolution';

  if (!apelido) return { erro: 'Dê um apelido ao chip (até 60 letras).' };
  if (!ehFuncaoDoChip(funcao)) return { erro: 'Escolha o que este chip vai fazer.' };

  const contexto = await abrirContexto();
  if ('erro' in contexto) return { erro: contexto.erro };

  if (motor === 'baileys') {
    const executorId = dados.get('executorId');
    if (!ehIdentificador(executorId)) {
      return { erro: 'Escolha um aparelho do Motor local (ou pareie um primeiro na aba Conexões / Motor).' };
    }
    const { data, error } = await contexto.supabase.rpc('create_my_local_instance', {
      p_workspace_id: contexto.workspaceId,
      p_display_name: apelido,
      p_purpose: funcao,
      p_executor_id: executorId,
    });
    if (error) {
      if (error.message?.includes('instance_limit_reached')) {
        return { erro: 'Sua conta já está usando todos os chips do plano. Remova um chip ou peça um limite maior.' };
      }
      if (error.code === 'P0002') {
        return { erro: 'Este aparelho local não foi encontrado ou foi revogado. Pareie outro em Conexões / Motor.' };
      }
      if (error.code === '42501') return { erro: SEM_PERMISSAO };
      console.error('[instâncias] erro ao criar chip local:', error);
      return { erro: 'Não foi possível cadastrar o chip local agora. Tente de novo em instantes.' };
    }
    const chipId = (data as { id: string }).id;
    // Já enfileira o pedido de QR Code para o motor local começar imediatamente se estiver ligado.
    await contexto.supabase.rpc('request_my_local_instance_action', {
      p_workspace_id: contexto.workspaceId,
      p_instance_id: chipId,
      p_command_type: 'connect_qr',
      p_payload: {},
    });
    atualizarTelas();
    return { ok: true, chipId, motor: 'baileys', qr: null };
  }

  if (!lerConfigEvolution()) return { erro: mensagemDaEvolution(new ErroEvolution('nao_configurada', '')) };

  const nome = gerarNomeNaEvolution(contexto.workspaceId, randomBytes(6).toString('hex'));
  const segredo = novoSegredo();
  const { data, error } = await contexto.supabase.rpc('create_my_evolution_instance', {
    p_workspace_id: contexto.workspaceId,
    p_display_name: apelido,
    p_purpose: funcao,
    p_provider_instance_name: nome,
    p_webhook_token_sha256: segredo.resumo,
  });
  if (error) {
    if (error.message?.includes('instance_limit_reached')) {
      return { erro: 'Sua conta já está usando todos os chips do plano. Remova um chip ou peça um limite maior.' };
    }
    if (error.code === '42501') return { erro: SEM_PERMISSAO };
    console.error('[instâncias] não foi possível cadastrar o chip:', error);
    return { erro: 'Não foi possível cadastrar o chip agora. Tente de novo em instantes.' };
  }
  const chipId = (data as { id: string }).id;

  const url = enderecoDoAviso();
  try {
    const qr = await criarInstancia({ nome, aviso: url ? { url, token: segredo.token } : null });
    await gravarEstado(contexto, chipId, 'connecting', null);
    atualizarTelas();
    return { ok: true, chipId, motor: 'evolution', qr };
  } catch (erro) {
    registrarErro('a Evolution não criou a instância', erro);
    if (erro instanceof ErroEvolution && erro.motivo !== 'incerta') {
      await contexto.supabase.rpc('remove_my_instance', { p_workspace_id: contexto.workspaceId, p_instance_id: chipId });
      atualizarTelas();
      return { erro: mensagemDaEvolution(erro) };
    }
    atualizarTelas();
    return { ok: true, chipId, motor: 'evolution', qr: null };
  }
}

/** Formulário "Editar chip": apelido, função e (se local) o executor associado. */
export async function salvarChip(_anterior: EstadoDoFormulario, dados: FormData): Promise<EstadoDoFormulario> {
  const chipId = dados.get('chipId');
  const apelido = validarApelido(String(dados.get('apelido') ?? ''));
  const funcao = dados.get('funcao');
  if (!ehIdentificador(chipId)) return { erro: CHIP_NAO_ENCONTRADO };
  if (!apelido) return { erro: 'Dê um apelido ao chip (até 60 letras).' };
  if (!ehFuncaoDoChip(funcao)) return { erro: 'Escolha o que este chip vai fazer.' };

  const contexto = await abrirContexto();
  if ('erro' in contexto) return { erro: contexto.erro };

  const { error } = await contexto.supabase.rpc('update_my_instance_settings', {
    p_workspace_id: contexto.workspaceId,
    p_instance_id: chipId,
    p_display_name: apelido,
    p_purpose: funcao,
  });
  if (error) {
    if (error.code === 'P0002') return { erro: CHIP_NAO_ENCONTRADO };
    if (error.code === '42501') return { erro: SEM_PERMISSAO };
    console.error('[instâncias] não foi possível salvar o chip:', error);
    return { erro: 'Não foi possível salvar agora. Tente de novo em instantes.' };
  }

  const executorId = dados.get('executorId');
  if (ehIdentificador(executorId)) {
    const { error: execErr } = await contexto.supabase.rpc('assign_my_local_instance_executor', {
      p_workspace_id: contexto.workspaceId,
      p_instance_id: chipId,
      p_executor_id: executorId,
    });
    if (execErr && execErr.code !== 'P0002') {
      console.error('[instâncias] erro ao trocar executor:', execErr);
    }
  }

  atualizarTelas();
  return { ok: true, chipId };
}

/**
 * Pede um QR Code (ou, informando o número, o código de 8 dígitos).
 * Suporta tanto chips Evolution quanto chips do Motor local (Baileys).
 */
export async function gerarQrCode(
  chipId: string,
  numeroDigitado?: string,
): Promise<Resultado<{ qr: QrCode; conectado: boolean; aguardandoMotor?: boolean; qrBruto?: string | null }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const chip = await buscarChip(contexto, chipId);
  if (!chip) return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  let numero: string | undefined;
  if (numeroDigitado !== undefined) {
    const normalizado = normalizarNumeroParaPareamento(String(numeroDigitado));
    if (!normalizado) return { ok: false, erro: 'Informe o número do chip com DDD. Exemplo: 85 99999-0000.' };
    numero = normalizado;
  }

  // Ramo do Motor local (Baileys): enfileira o comando para o computador/celular conectado responder.
  if (chip.engine === 'baileys') {
    if (chip.status === 'connected') {
      return { ok: true, conectado: true, qr: { imagem: null, codigoDePareamento: null } };
    }
    const { error } = await contexto.supabase.rpc('request_my_local_instance_action', {
      p_workspace_id: contexto.workspaceId,
      p_instance_id: chip.id,
      p_command_type: numero ? 'connect_code' : 'connect_qr',
      p_payload: numero ? { phone: numero } : {},
    });
    if (error) {
      if (error.message?.includes('instance_unavailable')) {
        return { ok: false, erro: 'Vincule um aparelho local em "Editar" ou na aba Conexões / Motor primeiro.' };
      }
      if (error.message?.includes('executor_revoked')) {
        return { ok: false, erro: 'O aparelho vinculado foi revogado. Escolha outro aparelho.' };
      }
      console.error('[instâncias] erro ao solicitar conexão local:', error);
      return { ok: false, erro: 'Não foi possível pedir conexão ao Motor local agora.' };
    }
    atualizarTelas();
    return {
      ok: true,
      conectado: false,
      aguardandoMotor: true,
      qrBruto: null,
      qr: { imagem: null, codigoDePareamento: null },
    };
  }

  if (chip.engine !== 'evolution' || !chip.provider_instance_name) return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  const nome = chip.provider_instance_name;
  try {
    let resposta: QrCode & { jaConectado?: boolean };
    if (numero) {
      let atual: { estado: EstadoNaEvolution; telefone: string | null } | null = null;
      try {
        atual = await consultarChip(nome);
      } catch (erro) {
        if (!(erro instanceof ErroEvolution) || erro.motivo !== 'nao_encontrada') throw erro;
      }

      if (atual?.estado === 'open') {
        await garantirAviso(contexto, chip);
        await gravarEstado(contexto, chip.id, 'open', atual.telefone);
        atualizarTelas();
        return { ok: true, conectado: true, qr: { imagem: null, codigoDePareamento: null } };
      }

      if (atual?.estado === 'close') {
        resposta = await pedirQrCode(nome, numero);
        if (resposta.jaConectado) {
          const chipNaEvolution = await consultarChip(nome);
          await garantirAviso(contexto, chip);
          await gravarEstado(contexto, chip.id, chipNaEvolution.estado, chipNaEvolution.telefone);
          atualizarTelas();
          return { ok: true, conectado: true, qr: { imagem: null, codigoDePareamento: null } };
        }
        if (resposta.codigoDePareamento) {
          await garantirAviso(contexto, chip);
        } else {
          await apagarInstancia(nome);
          resposta = await criarNaEvolution(contexto, chip, numero);
        }
      } else {
        if (atual) await apagarInstancia(nome);
        resposta = await criarNaEvolution(contexto, chip, numero);
      }
    } else {
      try {
        resposta = await pedirQrCode(nome);
        await garantirAviso(contexto, chip);
      } catch (erro) {
        if (!(erro instanceof ErroEvolution) || erro.motivo !== 'nao_encontrada') throw erro;
        resposta = await criarNaEvolution(contexto, chip);
      }
    }

    if (resposta.jaConectado) {
      const chipNaEvolution = await consultarChip(nome);
      await gravarEstado(contexto, chip.id, chipNaEvolution.estado, chipNaEvolution.telefone);
      atualizarTelas();
      return { ok: true, conectado: true, qr: { imagem: null, codigoDePareamento: null } };
    }
    if (numero ? !resposta.codigoDePareamento : !resposta.imagem) {
      return {
        ok: false,
        erro: numero
          ? 'A Evolution não devolveu o código de 8 dígitos. Tente de novo em instantes.'
          : 'A Evolution não devolveu o código. Tente de novo em instantes.',
      };
    }
    if (chip.status !== 'connecting') {
      await gravarEstado(contexto, chip.id, 'connecting', null);
      atualizarTelas();
    }
    return {
      ok: true,
      conectado: false,
      qr: { imagem: resposta.imagem, codigoDePareamento: resposta.codigoDePareamento },
    };
  } catch (erro) {
    registrarErro('não foi possível gerar o QR Code', erro);
    return { ok: false, erro: mensagemDaEvolution(erro) };
  }
}

/**
 * Confere estado do chip (e no Motor local devolve também QR/código publicado pelo aparelho).
 */
export async function conferirChip(
  chipId: string,
  completo = false,
): Promise<Resultado<{ estado: string; telefone: string | null; pairingQr?: string | null; pairingCode?: string | null }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const chip = await buscarChip(contexto, chipId);
  if (!chip) return { ok: false, erro: CHIP_NAO_ENCONTRADO };
  if (chip.engine === 'baileys') {
    return {
      ok: true,
      estado: chip.status,
      telefone: chip.connected_phone ?? null,
      pairingQr: chip.pairing_qr ?? null,
      pairingCode: chip.pairing_code ?? null,
    };
  }
  if (chip.engine !== 'evolution' || !chip.provider_instance_name) {
    return { ok: true, estado: chip.status, telefone: null };
  }

  try {
    let naEvolution: { estado: EstadoNaEvolution; telefone: string | null };
    try {
      naEvolution = await consultarChip(chip.provider_instance_name);
      if (completo) await garantirAviso(contexto, chip);
    } catch (erro) {
      if (!(erro instanceof ErroEvolution) || erro.motivo !== 'nao_encontrada') throw erro;
      naEvolution = { estado: 'close', telefone: null };
    }
    const gravado = await gravarEstado(contexto, chip.id, naEvolution.estado, naEvolution.telefone);
    if (!gravado) return { ok: false, erro: 'Não foi possível atualizar o chip agora.' };
    if (gravado.estado !== chip.status) atualizarTelas();
    return { ok: true, ...gravado };
  } catch (erro) {
    registrarErro('não foi possível conferir o chip', erro);
    return { ok: false, erro: mensagemDaEvolution(erro) };
  }
}

/** Desconecta o WhatsApp do chip. O chip continua na lista, pronto para um novo QR Code. */
export async function desconectarChip(chipId: string): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const chip = await buscarChip(contexto, chipId);
  if (!chip) return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  if (chip.engine === 'baileys') {
    const { error } = await contexto.supabase.rpc('request_my_local_instance_action', {
      p_workspace_id: contexto.workspaceId,
      p_instance_id: chip.id,
      p_command_type: 'disconnect',
      p_payload: {},
    });
    if (error) {
      console.error('[instâncias] erro ao desconectar chip local:', error);
      return { ok: false, erro: 'Não foi possível enviar ordem de desconexão.' };
    }
    atualizarTelas();
    return { ok: true };
  }

  if (chip.engine !== 'evolution' || !chip.provider_instance_name) return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  try {
    await desconectarInstancia(chip.provider_instance_name);
  } catch (erro) {
    if (erro instanceof ErroEvolution && erro.motivo === 'recusada') {
      const atual = await consultarChip(chip.provider_instance_name).catch(() => null);
      if (atual?.estado === 'close') {
        await gravarEstado(contexto, chip.id, 'close', null);
        atualizarTelas();
        return { ok: true };
      }
    }
    if (!(erro instanceof ErroEvolution) || erro.motivo !== 'nao_encontrada') {
      registrarErro('não foi possível desconectar o chip', erro);
      return { ok: false, erro: mensagemDaEvolution(erro) };
    }
  }
  await gravarEstado(contexto, chip.id, 'close', null);
  atualizarTelas();
  return { ok: true };
}

/** Remove o chip: apaga a instância na Evolution (ou desconecta no local) e tira o chip da lista. */
export async function removerChip(chipId: string): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const chip = await buscarChip(contexto, chipId);
  if (!chip) return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  if (chip.engine === 'baileys') {
    await contexto.supabase.rpc('request_my_local_instance_action', {
      p_workspace_id: contexto.workspaceId,
      p_instance_id: chip.id,
      p_command_type: 'clear_session',
      p_payload: {},
    });
  } else if (chip.engine === 'evolution' && chip.provider_instance_name) {
    try {
      await desconectarInstancia(chip.provider_instance_name).catch((erro: unknown) => {
        if (erro instanceof ErroEvolution && erro.motivo === 'incerta') throw erro;
      });
      await apagarInstancia(chip.provider_instance_name);
    } catch (erro) {
      registrarErro('não foi possível apagar a instância na Evolution', erro);
      return { ok: false, erro: mensagemDaEvolution(erro) };
    }
  }

  const { error } = await contexto.supabase.rpc('remove_my_instance', {
    p_workspace_id: contexto.workspaceId,
    p_instance_id: chip.id,
  });
  if (error) {
    console.error('[instâncias] não foi possível remover o chip:', error);
    return { ok: false, erro: 'Não foi possível remover o chip agora. Tente de novo em instantes.' };
  }
  atualizarTelas();
  return { ok: true };
}

export async function mudarIaDoChip(chipId: string, ligar: boolean): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(chipId) || typeof ligar !== 'boolean') return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  const { error } = await contexto.supabase.rpc('set_my_instance_ai', {
    p_workspace_id: contexto.workspaceId,
    p_instance_id: chipId,
    p_enabled: ligar,
  });
  if (error) {
    const explicacao = explicarRecusaDoChip(error.message);
    if (!explicacao) console.error('[instâncias] não foi possível mudar a IA do chip:', { codigo: error.code, mensagem: error.message });
    return { ok: false, erro: explicacao ?? 'Algo deu errado do nosso lado. Tente de novo em instantes.' };
  }
  revalidatePath('/', 'layout');
  return { ok: true };
}
