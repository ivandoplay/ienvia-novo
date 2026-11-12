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
}

const SEM_PERMISSAO = 'Só o dono da conta pode mexer nos chips.';
const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';
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
    .select('id, provider_instance_name, engine, status')
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
  // A chave da Evolution e os segredos dos avisos nunca entram aqui.
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

/**
 * Troca o segredo do aviso: primeiro no banco, depois na Evolution. Nessa ordem, se a segunda
 * parte falhar, a próxima conferência percebe (o endereço não bate) e refaz as duas.
 */
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

/** Garante que a Evolution avisa ESTE painel (o endereço muda entre a prévia e a publicação). */
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

/** Cria a instância na Evolution para um chip que já existe no banco (com segredo novo). */
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

/** Formulário "Adicionar chip": cadastra o chip, cria a instância na Evolution e devolve o QR Code. */
export async function adicionarChip(_anterior: EstadoDoFormulario, dados: FormData): Promise<EstadoDoFormulario> {
  const apelido = validarApelido(String(dados.get('apelido') ?? ''));
  const funcao = dados.get('funcao');
  if (!apelido) return { erro: 'Dê um apelido ao chip (até 60 letras).' };
  if (!ehFuncaoDoChip(funcao)) return { erro: 'Escolha o que este chip vai fazer.' };
  if (!lerConfigEvolution()) return { erro: mensagemDaEvolution(new ErroEvolution('nao_configurada', '')) };

  const contexto = await abrirContexto();
  if ('erro' in contexto) return { erro: contexto.erro };

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
    return { ok: true, chipId, qr };
  } catch (erro) {
    registrarErro('a Evolution não criou a instância', erro);
    if (erro instanceof ErroEvolution && erro.motivo !== 'incerta') {
      // A Evolution disse "não": desfaz o cadastro para não sobrar um chip fantasma na lista.
      await contexto.supabase.rpc('remove_my_instance', { p_workspace_id: contexto.workspaceId, p_instance_id: chipId });
      atualizarTelas();
      return { erro: mensagemDaEvolution(erro) };
    }
    // Sem resposta: o chip fica cadastrado, desconectado. "Gerar QR Code" termina o serviço.
    atualizarTelas();
    return { ok: true, chipId, qr: null };
  }
}

/** Formulário "Editar chip": apelido e função. */
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
  atualizarTelas();
  return { ok: true, chipId };
}

/**
 * Pede um QR Code (ou, informando o número, o código de 8 dígitos).
 * Se o chip existe aqui mas não na Evolution, cria lá primeiro.
 */
export async function gerarQrCode(
  chipId: string,
  numeroDigitado?: string,
): Promise<Resultado<{ qr: QrCode; conectado: boolean }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const chip = await buscarChip(contexto, chipId);
  if (!chip || chip.engine !== 'evolution' || !chip.provider_instance_name) return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  let numero: string | undefined;
  if (numeroDigitado !== undefined) {
    const normalizado = normalizarNumeroParaPareamento(String(numeroDigitado));
    if (!normalizado) return { ok: false, erro: 'Informe o número do chip com DDD. Exemplo: 85 99999-0000.' };
    numero = normalizado;
  }

  const nome = chip.provider_instance_name;
  try {
    let resposta: QrCode & { jaConectado?: boolean };
    if (numero) {
      // Na Evolution 2.3.7, GET /instance/connect só gera código de 8 dígitos quando a instância está
      // fechada ("close"): se já estiver em "connecting" (por exemplo, criada antes para QR Code ou
      // com um código que venceu), ela devolve o estado anterior sem código novo.
      // Conferimos primeiro para nunca apagar um chip já conectado; não estando "open", recriamos lá
      // (ou pedimos direto se estiver "close") para garantir um código de 8 dígitos novo e válido.
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
          // O connect com instância "close" na 2.3.7 espera só 2 s; se o código não saiu a tempo, recriar dá 5 s.
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
 * Pergunta à Evolution como o chip está e grava no banco.
 * Com `completo`, também confere se os avisos de mensagem apontam para este painel.
 */
export async function conferirChip(
  chipId: string,
  completo = false,
): Promise<Resultado<{ estado: string; telefone: string | null }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const chip = await buscarChip(contexto, chipId);
  if (!chip) return { ok: false, erro: CHIP_NAO_ENCONTRADO };
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
  if (!chip || chip.engine !== 'evolution' || !chip.provider_instance_name) return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  try {
    await desconectarInstancia(chip.provider_instance_name);
  } catch (erro) {
    if (erro instanceof ErroEvolution && erro.motivo === 'recusada') {
      // Na Evolution 2.3.7, DELETE /logout devolve 400 quando o chip já caiu para "close".
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

/** Remove o chip: apaga a instância na Evolution e tira o chip da lista. O histórico de conversas fica. */
export async function removerChip(chipId: string): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const chip = await buscarChip(contexto, chipId);
  if (!chip) return { ok: false, erro: CHIP_NAO_ENCONTRADO };

  if (chip.engine === 'evolution' && chip.provider_instance_name) {
    try {
      // Sair do WhatsApp antes de apagar evita deixar um "aparelho conectado" perdido no celular.
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

/**
 * Liga ou desliga a IA num chip (só o dono). Para ligar, o banco exige a chave do provedor principal
 * e uma base de treinamento; sem isso a IA não teria como responder, e a tela explica o que falta.
 */
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
  // A IA ligada ou desligada aparece nas Instâncias, no topo do painel, na Visão geral e na Inbox.
  revalidatePath('/', 'layout');
  return { ok: true };
}
