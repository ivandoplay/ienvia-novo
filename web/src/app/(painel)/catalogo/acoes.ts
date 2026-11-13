'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  avaliarArquivoDeCatalogo,
  nomeSeguroParaDeposito,
  validarItemCatalogoParaSalvar,
  type ItemDoCatalogo,
} from '@ienvia/shared/recursos';
import {
  lerConfiguracaoPix,
  validarConfiguracaoPixParaSalvar,
  type ConfiguracaoPix,
} from '@ienvia/shared/recursos-pix';
import { DEPOSITO } from '@/lib/inbox/arquivos';
import { ehIdentificador } from '@/lib/instancias/regras';
import { mapearItemCatalogo } from '@/lib/recursos/mapeamento';
import { obterSessao } from '@/lib/sessao';
import { enderecoDoDepositoParaONavegador } from '@/lib/supabase/deposito';
import { criarClienteDeServico } from '@/lib/supabase/servico';
import { criarClienteServidor } from '@/lib/supabase/servidor';

const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';
const SOMENTE_DONO = 'Só o dono da conta edita o catálogo ou a configuração do PIX.';

function atualizarTelas() {
  revalidatePath('/catalogo');
  revalidatePath('/simulador');
  revalidatePath('/inbox');
}

function traduzirErroCatalogo(msg: string | undefined): string {
  if (!msg) return 'Não foi possível salvar agora. Tente de novo.';
  if (msg.includes('Workspace owner required')) return SOMENTE_DONO;
  if (msg.includes('Catalog item limit reached')) return 'Você atingiu o limite de 500 itens no catálogo.';
  if (msg.includes('Maximum 5 media files')) return 'Cada item aceita no máximo 5 arquivos (fotos ou PDFs).';
  if (msg.includes('Invalid payment link')) return 'O link de pagamento precisa começar com https:// e não pode conter @ no domínio.';
  if (msg.includes('Catalog media file not uploaded')) return 'Um dos arquivos anexados não terminou o envio. Tente anexar de novo.';
  if (msg.includes('Invalid catalog media type')) return 'Use apenas JPG, PNG, WebP, GIF ou PDF nos itens do catálogo.';
  if (msg.includes('Invalid catalog media size')) return 'Cada arquivo do catálogo precisa ter até 25 MB.';
  if (msg.includes('pix_key required')) return 'Informe a chave PIX antes de ativar o envio automático.';
  return 'Não foi possível concluir a operação. Confira os dados e tente de novo.';
}

async function limparChavesRemovidas(workspaceId: string, prefixoEsperado: string, chaves: unknown) {
  if (!Array.isArray(chaves) || chaves.length === 0) return;
  const validas = chaves.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(`${workspaceId}/${prefixoEsperado}/`),
  );
  if (validas.length === 0) return;
  const servico = criarClienteDeServico();
  const cliente = servico ?? (await criarClienteServidor());
  await cliente.storage.from(DEPOSITO).remove(validas).catch(() => undefined);
}

export async function salvarConfiguracaoPix(
  entrada: Partial<ConfiguracaoPix>,
): Promise<{ ok: true; pix: ConfiguracaoPix } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };

  const validado = validarConfiguracaoPixParaSalvar(entrada);
  if (!validado.ok) return validado;

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('save_my_pix_settings', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_settings: {
      enabled: validado.dados.enabled,
      key_type: validado.dados.keyType,
      pix_key: validado.dados.key,
      receiver_name: validado.dados.receiverName,
      bank_name: validado.dados.bankName,
      city: validado.dados.city,
      send_qr_image: validado.dados.sendQrImage,
      include_copy_paste: validado.dados.includeCopyPaste,
      instructions: validado.dados.instructions,
    },
  });
  if (error || !data) {
    return { ok: false, erro: traduzirErroCatalogo(error?.message) };
  }

  atualizarTelas();
  return { ok: true, pix: lerConfiguracaoPix(data) };
}

export async function prepararUploadArquivoCatalogo(dados: {
  itemId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}): Promise<{ ok: true; fileId: string; objectKey: string; signedUrl: string; safeName: string } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };
  if (!ehIdentificador(dados.itemId)) return { ok: false, erro: 'Identificador do item inválido.' };

  const avaliacao = avaliarArquivoDeCatalogo({
    nome: dados.fileName,
    tipoInformado: dados.contentType,
    tamanho: dados.byteSize,
  });
  if (!avaliacao.ok) return avaliacao;

  const fileId = randomUUID();
  const safeName = nomeSeguroParaDeposito(dados.fileName || 'arquivo', 'bin');
  const objectKey = `${sessao.workspaceAtivo.id}/catalogo/${dados.itemId}/${fileId}/${safeName}`;

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.storage.from(DEPOSITO).createSignedUploadUrl(objectKey);
  if (error || !data?.signedUrl) {
    return { ok: false, erro: 'Não foi possível preparar o envio do arquivo.' };
  }

  return {
    ok: true,
    fileId,
    objectKey,
    signedUrl: enderecoDoDepositoParaONavegador(data.signedUrl),
    safeName,
  };
}

export async function salvarItemDoCatalogo(entrada: {
  id: string;
  name: string;
  category: string;
  price: string;
  description: string;
  paymentLink: string;
  active: boolean;
  sortOrder: number;
  files: Array<{
    objectKey: string;
    fileName: string;
    contentType: string;
    byteSize: number;
  }>;
}): Promise<{ ok: true; item: ItemDoCatalogo } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };
  if (!ehIdentificador(entrada.id)) return { ok: false, erro: 'Identificador do item inválido.' };

  const validado = validarItemCatalogoParaSalvar({
    name: entrada.name,
    category: entrada.category,
    price: entrada.price,
    description: entrada.description,
    paymentLink: entrada.paymentLink,
    files: entrada.files,
  });
  if (!validado.ok) return validado;

  const workspaceId = sessao.workspaceAtivo.id;
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('save_my_catalog_item', {
    p_workspace_id: workspaceId,
    p_item: {
      id: entrada.id,
      name: entrada.name.trim(),
      category: entrada.category.trim(),
      price: entrada.price.trim(),
      description: entrada.description.trim(),
      payment_link: entrada.paymentLink.trim(),
      active: entrada.active !== false,
      sort_order: Number.isFinite(entrada.sortOrder) ? Math.round(entrada.sortOrder) : 0,
      files: entrada.files.map((f, idx) => ({
        object_key: f.objectKey,
        file_name: f.fileName,
        content_type: f.contentType,
        byte_size: f.byteSize,
        sort_order: idx,
      })),
    },
  });

  if (error || !data || typeof data !== 'object') {
    return { ok: false, erro: traduzirErroCatalogo(error?.message) };
  }

  const resp = data as { item?: unknown; removed_object_keys?: unknown };
  await limparChavesRemovidas(workspaceId, 'catalogo', resp.removed_object_keys);

  const item = mapearItemCatalogo(resp.item);
  if (!item) return { ok: false, erro: 'Item salvo, mas não foi possível lê-lo de volta.' };

  atualizarTelas();
  return { ok: true, item };
}

export async function excluirItemDoCatalogo(itemId: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };
  if (!ehIdentificador(itemId)) return { ok: false, erro: 'Item inválido.' };

  const workspaceId = sessao.workspaceAtivo.id;
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('delete_my_catalog_item', {
    p_workspace_id: workspaceId,
    p_item_id: itemId,
  });

  if (error) return { ok: false, erro: traduzirErroCatalogo(error.message) };
  const resp = (data ?? {}) as { removed_object_keys?: unknown };
  await limparChavesRemovidas(workspaceId, 'catalogo', resp.removed_object_keys);

  atualizarTelas();
  return { ok: true };
}
