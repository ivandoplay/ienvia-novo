'use server';

import { revalidatePath } from 'next/cache';
import { montarInstrucoes } from '@/lib/ia/instrucoes';
import {
  BASE_EM_BRANCO,
  MODELOS_PRONTOS,
  aplicarModelo,
  conferirArquivo,
  conferirBase,
  conferirRotulo,
  explicarErroDoTreinamento,
  lerBase,
  lerListaDeBases,
  type BaseDeTreinamento,
  type ListaDeBases,
} from '@/lib/ia/treinamento';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Ações da tela de Treinamento. Todas rodam no servidor, com a sessão de quem está logado:
 * o banco confere de novo se a pessoa é a dona da conta antes de aceitar qualquer mudança.
 */

export type Resultado<T = object> = ({ ok: true } & T) | { ok: false; erro: string; aba?: 'identidade' | 'regras' | 'perguntas' };

type Supabase = Awaited<ReturnType<typeof criarClienteServidor>>;

interface Contexto {
  supabase: Supabase;
  workspaceId: string;
}

const SEM_PERMISSAO = 'Só o dono da conta altera o treinamento.';
const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';
const ALGO_DEU_ERRADO = 'Algo deu errado do nosso lado. Tente de novo em instantes.';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ehId = (valor: unknown): valor is string => typeof valor === 'string' && ID.test(valor);

async function abrirContexto(apenasDono = true): Promise<Contexto | { erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { erro: SESSAO_EXPIRADA };
  if (apenasDono && sessao.workspaceAtivo.papel !== 'owner') return { erro: SEM_PERMISSAO };
  return { supabase: await criarClienteServidor(), workspaceId: sessao.workspaceAtivo.id };
}

function mensagemDoBanco(onde: string, erro: { code?: string; message?: string }): string {
  if (erro.code === '42501') return SEM_PERMISSAO;
  const conhecido = explicarErroDoTreinamento(erro.message);
  if (conhecido) return conhecido;
  console.error(`[treinamento] ${onde}:`, { codigo: erro.code, mensagem: erro.message });
  return ALGO_DEU_ERRADO;
}

async function lerLista(contexto: Contexto): Promise<ListaDeBases | null> {
  const { data, error } = await contexto.supabase.rpc('read_my_ai_agents', { p_workspace_id: contexto.workspaceId });
  if (error) {
    console.error('[treinamento] não foi possível reler as bases:', { codigo: error.code, mensagem: error.message });
    return null;
  }
  return lerListaDeBases(data);
}

type ComBase = Resultado<{ base: BaseDeTreinamento; lista: ListaDeBases | null }>;

async function devolverBase(contexto: Contexto, dados: unknown): Promise<ComBase> {
  const base = lerBase(dados);
  if (!base) return { ok: false, erro: ALGO_DEU_ERRADO };
  revalidatePath('/treinamento');
  return { ok: true, base, lista: await lerLista(contexto) };
}

/** Grava os campos de uma base (identidade, regras e perguntas frequentes). */
export async function salvarBase(baseId: unknown, campos: unknown): Promise<ComBase> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehId(baseId)) return { ok: false, erro: ALGO_DEU_ERRADO };
  const conferida = conferirBase(campos);
  if (!conferida.ok) return { ok: false, erro: conferida.erro, aba: conferida.aba };

  const { data, error } = await contexto.supabase.rpc('save_my_ai_agent', { p_workspace_id: contexto.workspaceId, p_agent_id: baseId, p_data: conferida.paraOBanco });
  if (error) return { ok: false, erro: mensagemDoBanco('gravar a base', error) };
  return devolverBase(contexto, data);
}

/**
 * Cria uma base nova. A primeira da empresa nasce como a padrão. Com um modelo pronto, já vem preenchida.
 */
export async function criarBase(rotulo: unknown, modeloId: unknown = null): Promise<ComBase> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const nome = conferirRotulo(rotulo);
  if (!nome.ok) return { ok: false, erro: nome.erro };
  const modelo = modeloId === null ? null : MODELOS_PRONTOS.find((item) => item.id === modeloId);
  if (modelo === undefined) return { ok: false, erro: 'Este modelo não existe mais. Atualize a página.' };

  const campos = modelo ? aplicarModelo({ ...BASE_EM_BRANCO, rotulo: nome.rotulo }, modelo) : { ...BASE_EM_BRANCO, rotulo: nome.rotulo };
  const conferida = conferirBase(campos);
  if (!conferida.ok) return { ok: false, erro: conferida.erro };

  const { data, error } = await contexto.supabase.rpc('save_my_ai_agent', { p_workspace_id: contexto.workspaceId, p_agent_id: null, p_data: conferida.paraOBanco });
  if (error) return { ok: false, erro: mensagemDoBanco('criar a base', error) };
  return devolverBase(contexto, data);
}

type ComLista = Resultado<{ lista: ListaDeBases }>;

function devolverLista(dados: unknown): ComLista {
  revalidatePath('/treinamento');
  return { ok: true, lista: lerListaDeBases(dados) };
}

/** Escolhe a base padrão: a que vale para todo chip sem base própria. */
export async function tornarPadrao(baseId: unknown): Promise<ComLista> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehId(baseId)) return { ok: false, erro: ALGO_DEU_ERRADO };
  const { data, error } = await contexto.supabase.rpc('set_my_default_ai_agent', { p_workspace_id: contexto.workspaceId, p_agent_id: baseId });
  if (error) return { ok: false, erro: mensagemDoBanco('escolher a base padrão', error) };
  return devolverLista(data);
}

/** Apaga uma base (nunca a padrão). Os chips que a usavam voltam para a padrão. */
export async function apagarBase(baseId: unknown): Promise<ComLista> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehId(baseId)) return { ok: false, erro: ALGO_DEU_ERRADO };
  const { data, error } = await contexto.supabase.rpc('delete_my_ai_agent', { p_workspace_id: contexto.workspaceId, p_agent_id: baseId });
  if (error) return { ok: false, erro: mensagemDoBanco('apagar a base', error) };
  return devolverLista(data);
}

/** Escolhe qual base um chip usa. Sem base (`null`), o chip usa a padrão. */
export async function definirBaseDoChip(chipId: unknown, baseId: unknown): Promise<ComLista> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehId(chipId) || (baseId !== null && !ehId(baseId))) return { ok: false, erro: ALGO_DEU_ERRADO };
  const { data, error } = await contexto.supabase.rpc('set_my_instance_ai_agent', { p_workspace_id: contexto.workspaceId, p_instance_id: chipId, p_agent_id: baseId });
  if (error) return { ok: false, erro: mensagemDoBanco('escolher a base do chip', error) };
  return devolverLista(data);
}

/**
 * Anexa um arquivo de conhecimento. O arquivo chega inteiro (como veio do computador da pessoa) e é
 * conferido aqui de novo: só texto de verdade entra, e nunca cortado.
 */
export async function anexarArquivo(baseId: unknown, formulario: FormData): Promise<ComBase> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehId(baseId)) return { ok: false, erro: ALGO_DEU_ERRADO };
  const arquivo = formulario.get('arquivo');
  if (!(arquivo instanceof File)) return { ok: false, erro: 'Escolha um arquivo.' };
  // Antes de ler: um arquivo enorme nem é carregado na memória do servidor.
  if (arquivo.size > 500_000) return { ok: false, erro: 'O arquivo é grande demais. Cabem até 30.000 caracteres por arquivo; divida em arquivos menores.' };

  const conferido = conferirArquivo(arquivo.name, new Uint8Array(await arquivo.arrayBuffer()));
  if (!conferido.ok) return { ok: false, erro: conferido.erro };

  const { data, error } = await contexto.supabase.rpc('add_my_ai_agent_document', {
    p_workspace_id: contexto.workspaceId,
    p_agent_id: baseId,
    p_title: conferido.titulo,
    p_content: conferido.conteudo,
  });
  if (error) return { ok: false, erro: mensagemDoBanco('anexar o arquivo', error) };
  return devolverBase(contexto, data);
}

/** Apaga um arquivo de conhecimento. */
export async function apagarArquivo(arquivoId: unknown): Promise<ComBase> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehId(arquivoId)) return { ok: false, erro: ALGO_DEU_ERRADO };
  const { data, error } = await contexto.supabase.rpc('delete_my_ai_agent_document', { p_workspace_id: contexto.workspaceId, p_document_id: arquivoId });
  if (error) return { ok: false, erro: mensagemDoBanco('apagar o arquivo', error) };
  return devolverBase(contexto, data);
}

/**
 * As instruções que a IA recebe com esta base, do jeito que está GRAVADA (com os arquivos de conhecimento).
 * É o mesmo texto que o atendente usa. Quem participa da empresa pode ver.
 */
export async function verInstrucoes(baseId: unknown): Promise<Resultado<{ instrucoes: string; letras: number }>> {
  const contexto = await abrirContexto(false);
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehId(baseId)) return { ok: false, erro: ALGO_DEU_ERRADO };
  const { data, error } = await contexto.supabase.rpc('read_my_ai_agent', { p_workspace_id: contexto.workspaceId, p_agent_id: baseId, p_include_content: true });
  if (error) return { ok: false, erro: mensagemDoBanco('ler a base', error) };
  const base = lerBase(data);
  if (!base) return { ok: false, erro: ALGO_DEU_ERRADO };
  const instrucoes = montarInstrucoes(base, { agora: new Date(), nomeDoContato: 'Cliente de exemplo' });
  return { ok: true, instrucoes, letras: instrucoes.length };
}
