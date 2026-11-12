'use server';

import { revalidatePath } from 'next/cache';
import { cifrar, contextoDaChaveDeIa, decifrar, finalDaChave, lerChaveDoCofre } from '@/lib/ia/cofre';
import { ErroDeIa, listarModelos, testarConexao, type ModeloDisponivel } from '@/lib/ia/provedores';
import {
  conferirChave,
  conferirConfiguracao,
  configuracaoParaOBanco,
  duracaoLegivel,
  ehNomeDeModelo,
  ehProvedor,
  explicarErroDeIa,
  lerMotor,
  type MotorDeIa,
  type Provedor,
} from '@/lib/ia/regras';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Ações da tela do Motor de IA. Todas rodam no servidor, com a sessão de quem está logado:
 * o banco confere de novo se a pessoa é a dona da conta antes de aceitar qualquer mudança.
 * A chave de um provedor só existe em texto puro aqui, no servidor, pelo tempo de cifrar ou de testar.
 */

export type Resultado<T = object> = ({ ok: true } & T) | { ok: false; erro: string };

/** O que o teste de conexão descobriu, já em palavras para a tela. */
export type Teste = { funcionou: true; texto: string } | { funcionou: false; texto: string };

type Supabase = Awaited<ReturnType<typeof criarClienteServidor>>;

interface Contexto {
  supabase: Supabase;
  workspaceId: string;
}

const SEM_PERMISSAO = 'Só o dono da conta altera o Motor de IA.';
const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';
const ALGO_DEU_ERRADO = 'Algo deu errado do nosso lado. Tente de novo em instantes.';
const SEM_COFRE =
  'Este ambiente ainda não tem o segredo que protege as chaves (IENVIA_CHAVE_DOS_SEGREDOS). Sem ele, o painel não guarda chaves de IA.';
const CHAVE_NAO_ABRE = 'Não foi possível abrir a chave guardada. Cadastre a chave de novo.';

async function abrirContexto(): Promise<Contexto | { erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { erro: SEM_PERMISSAO };
  return { supabase: await criarClienteServidor(), workspaceId: sessao.workspaceAtivo.id };
}

function mensagemDoBanco(onde: string, erro: { code?: string; message?: string }): string {
  if (erro.code === '42501') return SEM_PERMISSAO;
  console.error(`[motor de ia] ${onde}:`, { codigo: erro.code, mensagem: erro.message });
  return ALGO_DEU_ERRADO;
}

/** Faz a pergunta de teste e transforma o resultado em uma frase. A chave nunca entra no registro. */
async function fazerTeste(provedor: Provedor, chave: string, modelo: string): Promise<Teste> {
  try {
    const resposta = await testarConexao(provedor, chave, modelo);
    // A frase usa o nome que a pessoa escolheu. Alguns provedores devolvem outro nome para o mesmo modelo
    // (a NVIDIA responde "private/nvidia/..."), e mostrar esse nome só confundiria.
    return { funcionou: true, texto: `Funcionou: o modelo ${modelo} respondeu em ${duracaoLegivel(resposta.duracaoMs)}.` };
  } catch (erro) {
    if (erro instanceof ErroDeIa) {
      console.error('[motor de ia] teste de conexão:', { provedor, motivo: erro.motivo, status: erro.status, mensagem: erro.message });
      return { funcionou: false, texto: explicarErroDeIa(erro.motivo, provedor, modelo) };
    }
    console.error('[motor de ia] teste de conexão:', erro);
    return { funcionou: false, texto: ALGO_DEU_ERRADO };
  }
}

/** Lê do banco a chave guardada (cifrada) e abre com o segredo deste servidor. */
async function abrirChaveGuardada(contexto: Contexto, provedor: Provedor): Promise<{ chave: string | null } | { erro: string }> {
  const { data, error } = await contexto.supabase.rpc('read_my_ai_key_ciphertext', { p_workspace_id: contexto.workspaceId, p_provider: provedor });
  if (error) return { erro: mensagemDoBanco('ler a chave guardada', error) };
  if (typeof data !== 'string' || !data) return { chave: null };
  const cofre = lerChaveDoCofre();
  if (!cofre) return { erro: SEM_COFRE };
  const chave = decifrar(data, contextoDaChaveDeIa(contexto.workspaceId, provedor), cofre);
  return chave ? { chave } : { erro: CHAVE_NAO_ABRE };
}

/** Grava o provedor, os modelos e o comportamento. */
export async function salvarMotor(entrada: unknown): Promise<Resultado<{ motor: MotorDeIa }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const conferido = conferirConfiguracao(entrada);
  if (!conferido.ok) return { ok: false, erro: conferido.erro };

  const { data, error } = await contexto.supabase.rpc('save_my_ai_settings', {
    p_workspace_id: contexto.workspaceId,
    p_settings: configuracaoParaOBanco(conferido.configuracao),
  });
  if (error) return { ok: false, erro: mensagemDoBanco('gravar as configurações', error) };
  revalidatePath('/inteligencia-artificial');
  return { ok: true, motor: lerMotor(data) };
}

/**
 * Guarda a chave de um provedor (cifrada) e já faz um teste de conexão com ela.
 * A chave fica guardada mesmo que o teste falhe: o problema pode ser passageiro, e a tela avisa.
 */
export async function guardarChave(provedor: unknown, chave: unknown, modelo: unknown): Promise<Resultado<{ motor: MotorDeIa; teste: Teste | null }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehProvedor(provedor)) return { ok: false, erro: ALGO_DEU_ERRADO };
  const problema = conferirChave(provedor, chave);
  if (problema) return { ok: false, erro: problema };
  const cofre = lerChaveDoCofre();
  if (!cofre) return { ok: false, erro: SEM_COFRE };

  const limpa = String(chave).trim();
  const { data, error } = await contexto.supabase.rpc('save_my_ai_key', {
    p_workspace_id: contexto.workspaceId,
    p_provider: provedor,
    p_ciphertext: cifrar(limpa, contextoDaChaveDeIa(contexto.workspaceId, provedor), cofre),
    p_key_hint: finalDaChave(limpa),
  });
  if (error) return { ok: false, erro: mensagemDoBanco('guardar a chave', error) };
  revalidatePath('/inteligencia-artificial');

  const teste = ehNomeDeModelo(modelo) ? await fazerTeste(provedor, limpa, modelo) : null;
  return { ok: true, motor: lerMotor(data), teste };
}

/** Apaga a chave de um provedor. */
export async function removerChave(provedor: unknown): Promise<Resultado<{ motor: MotorDeIa }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehProvedor(provedor)) return { ok: false, erro: ALGO_DEU_ERRADO };

  const { data, error } = await contexto.supabase.rpc('delete_my_ai_key', { p_workspace_id: contexto.workspaceId, p_provider: provedor });
  if (error) return { ok: false, erro: mensagemDoBanco('remover a chave', error) };
  revalidatePath('/inteligencia-artificial');
  return { ok: true, motor: lerMotor(data) };
}

/** Testa a chave que já está guardada, com o modelo que está escrito na tela (mesmo que ainda não salvo). */
export async function testarProvedor(provedor: unknown, modelo: unknown): Promise<Resultado<{ teste: Teste }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehProvedor(provedor)) return { ok: false, erro: ALGO_DEU_ERRADO };
  if (!ehNomeDeModelo(modelo)) return { ok: false, erro: 'Escreva o nome do modelo antes de testar.' };

  const guardada = await abrirChaveGuardada(contexto, provedor);
  if ('erro' in guardada) return { ok: false, erro: guardada.erro };
  if (!guardada.chave) return { ok: false, erro: 'Cadastre a chave deste provedor antes de testar.' };
  return { ok: true, teste: await fazerTeste(provedor, guardada.chave, modelo) };
}

/** Os modelos de conversa de um provedor. No Gemini depende da chave guardada; no OpenRouter e na NVIDIA a lista é pública. */
export async function buscarModelos(provedor: unknown): Promise<Resultado<{ modelos: ModeloDisponivel[] }>> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehProvedor(provedor)) return { ok: false, erro: ALGO_DEU_ERRADO };

  // No OpenRouter dá para listar mesmo sem chave (ou com uma chave que não abre). Na NVIDIA a chave nem é usada.
  const guardada = provedor === 'nvidia' ? { chave: null } : await abrirChaveGuardada(contexto, provedor);
  const chave = 'chave' in guardada ? guardada.chave : null;
  if (provedor === 'gemini') {
    if ('erro' in guardada) return { ok: false, erro: guardada.erro };
    if (!chave) return { ok: false, erro: 'Cadastre a chave do Google Gemini para ver os modelos disponíveis.' };
  }
  try {
    return { ok: true, modelos: await listarModelos(provedor, chave) };
  } catch (erro) {
    if (erro instanceof ErroDeIa) {
      console.error('[motor de ia] lista de modelos:', { provedor, motivo: erro.motivo, status: erro.status, mensagem: erro.message });
      return { ok: false, erro: explicarErroDeIa(erro.motivo, provedor) };
    }
    console.error('[motor de ia] lista de modelos:', erro);
    return { ok: false, erro: ALGO_DEU_ERRADO };
  }
}
