/**
 * Implementação em memória das tabelas e RPCs da Fase 6 (Catálogo, PIX, Áudios Estratégicos
 * e Simulador de Atendimento) para o Supabase de mentira dos testes E2E do Playwright.
 */
import crypto from 'node:crypto';

const lerConfiguracaoPix = (bruto) => {
  const obj = bruto && typeof bruto === 'object' ? bruto : {};
  const tipo = ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'].includes(obj.key_type) ? obj.key_type : 'aleatoria';
  return {
    enabled: obj.enabled === true,
    keyType: tipo,
    key: String(obj.pix_key ?? obj.key ?? '').trim(),
    receiverName: String(obj.receiver_name ?? obj.receiverName ?? '').trim(),
    bankName: String(obj.bank_name ?? obj.bankName ?? '').trim(),
    city: String(obj.city ?? 'BRASIL').trim() || 'BRASIL',
    sendQrImage: obj.send_qr_image !== false && obj.sendQrImage !== false,
    includeCopyPaste: obj.include_copy_paste !== false && obj.includeCopyPaste !== false,
    instructions: String(obj.instructions ?? '').trim(),
    updatedAt: typeof obj.updated_at === 'string' ? obj.updated_at : null,
  };
};

export const FUNCOES_RECURSOS_E_SIMULADOR = [
  'read_my_pix_settings',
  'save_my_pix_settings',
  'list_my_catalog_items',
  'save_my_catalog_item',
  'delete_my_catalog_item',
  'list_my_voice_library',
  'save_my_voice_item',
  'delete_my_voice_item',
  'read_my_simulator_session',
  'save_my_simulator_session',
  'reset_my_simulator_session',
];

const agora = () => new Date().toISOString();

function estadoInicial() {
  return {
    pixPorWorkspace: new Map(),
    catalogoPorWorkspace: new Map(),
    audiosPorWorkspace: new Map(),
    sessaoSimuladorPorUsuario: new Map(),
  };
}

export function criarRecursosESimuladorDoBanco({ participacoes, responder, deposito }) {
  let estado = estadoInicial();

  function papelDe(usuarioId, workspaceId) {
    return participacoes.find((p) => p.user_id === usuarioId && p.workspace_id === workspaceId && p.status === 'active')?.role ?? null;
  }

  function listaCatalogo(workspaceId) {
    if (!estado.catalogoPorWorkspace.has(workspaceId)) estado.catalogoPorWorkspace.set(workspaceId, []);
    return estado.catalogoPorWorkspace.get(workspaceId);
  }

  function listaAudios(workspaceId) {
    if (!estado.audiosPorWorkspace.has(workspaceId)) estado.audiosPorWorkspace.set(workspaceId, []);
    return estado.audiosPorWorkspace.get(workspaceId);
  }

  function serializarItem(item) {
    return {
      id: item.id,
      workspace_id: item.workspace_id,
      name: item.name,
      category: item.category,
      price: item.price,
      description: item.description,
      payment_link: item.payment_link,
      active: item.active,
      sort_order: item.sort_order,
      files: item.files,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }

  function acoes(res, usuario, nome, corpo) {
    const workspaceId = String(corpo?.p_workspace_id ?? '');
    const papel = papelDe(usuario.id, workspaceId);
    if (!papel) return responder(res, 403, { code: '42501', message: 'Workspace membership required' });
    const erro = (status, code, message) => responder(res, status, { code, message });

    if (nome === 'read_my_pix_settings') {
      const atual = estado.pixPorWorkspace.get(workspaceId) ?? {};
      const norm = lerConfiguracaoPix(atual);
      return responder(res, 200, {
        enabled: norm.enabled,
        key_type: norm.keyType,
        pix_key: norm.key,
        receiver_name: norm.receiverName,
        bank_name: norm.bankName,
        city: norm.city,
        send_qr_image: norm.sendQrImage,
        include_copy_paste: norm.includeCopyPaste,
        instructions: norm.instructions,
        updated_at: norm.updatedAt,
      });
    }

    if (nome === 'save_my_pix_settings') {
      if (papel !== 'owner') return erro(403, '42501', 'Workspace owner required');
      const s = corpo?.p_settings ?? {};
      const norm = lerConfiguracaoPix({
        enabled: s.enabled === true,
        key_type: s.key_type,
        pix_key: s.pix_key,
        receiver_name: s.receiver_name,
        bank_name: s.bank_name,
        city: s.city,
        send_qr_image: s.send_qr_image !== false,
        include_copy_paste: s.include_copy_paste !== false,
        instructions: s.instructions,
        updated_at: agora(),
      });
      if (norm.enabled && !norm.key.trim()) return erro(400, '22023', 'pix_key required');
      const salvo = {
        enabled: norm.enabled,
        key_type: norm.keyType,
        pix_key: norm.key,
        receiver_name: norm.receiverName,
        bank_name: norm.bankName,
        city: norm.city,
        send_qr_image: norm.sendQrImage,
        include_copy_paste: norm.includeCopyPaste,
        instructions: norm.instructions,
        updated_at: agora(),
      };
      estado.pixPorWorkspace.set(workspaceId, salvo);
      return responder(res, 200, salvo);
    }

    if (nome === 'list_my_catalog_items') {
      return responder(res, 200, listaCatalogo(workspaceId).map(serializarItem));
    }

    if (nome === 'save_my_catalog_item') {
      if (papel !== 'owner') return erro(403, '42501', 'Workspace owner required');
      const p = corpo?.p_item ?? {};
      const name = String(p.name ?? '').trim();
      if (!name || name.length > 200) return erro(400, '22023', 'Invalid catalog item name');
      const id = typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID();
      const filesInput = Array.isArray(p.files) ? p.files : [];
      if (filesInput.length > 5) return erro(400, '22023', 'Maximum 5 media files per catalog item');

      for (const f of filesInput) {
        const key = String(f.object_key ?? '');
        if (!key.startsWith(`${workspaceId}/catalogo/`) || !deposito.has(key)) {
          return erro(400, 'P0001', 'Catalog media file not uploaded');
        }
      }

      const lista = listaCatalogo(workspaceId);
      const existente = lista.find((i) => i.id === id);
      const chavesAntigas = existente ? existente.files.map((f) => f.object_key) : [];
      const chavesNovas = new Set(filesInput.map((f) => f.object_key));
      const removed_object_keys = chavesAntigas.filter((k) => !chavesNovas.has(k));

      const ts = agora();
      const files = filesInput.map((f, idx) => ({
        id: crypto.randomUUID(),
        object_key: String(f.object_key),
        file_name: String(f.file_name || 'arquivo'),
        content_type: String(f.content_type || 'application/octet-stream'),
        byte_size: Number(f.byte_size ?? 1),
        sort_order: Number.isFinite(f.sort_order) ? f.sort_order : idx,
      }));
      const registro = {
        id,
        workspace_id: workspaceId,
        name,
        category: String(p.category ?? '').trim(),
        price: String(p.price ?? '').trim(),
        description: String(p.description ?? '').trim(),
        payment_link: String(p.payment_link ?? '').trim(),
        active: p.active !== false,
        sort_order: Number.isFinite(p.sort_order) ? p.sort_order : lista.length,
        files,
        created_at: existente?.created_at ?? ts,
        updated_at: ts,
      };
      if (existente) {
        Object.assign(existente, registro);
      } else {
        lista.push(registro);
      }
      return responder(res, 200, { item: serializarItem(registro), removed_object_keys });
    }

    if (nome === 'delete_my_catalog_item') {
      if (papel !== 'owner') return erro(403, '42501', 'Workspace owner required');
      const itemId = String(corpo?.p_item_id ?? '');
      const lista = listaCatalogo(workspaceId);
      const idx = lista.findIndex((i) => i.id === itemId);
      if (idx < 0) return responder(res, 200, { deleted: false, removed_object_keys: [] });
      const [removido] = lista.splice(idx, 1);
      return responder(res, 200, {
        deleted: true,
        removed_object_keys: (removido?.files ?? []).map((f) => f.object_key),
      });
    }

    if (nome === 'list_my_voice_library') {
      return responder(res, 200, listaAudios(workspaceId));
    }

    if (nome === 'save_my_voice_item') {
      if (papel !== 'owner') return erro(403, '42501', 'Workspace owner required');
      const p = corpo?.p_voice ?? {};
      const name = String(p.name ?? '').trim();
      const transcription = String(p.transcription ?? '').trim();
      if (!name) return erro(400, '22023', 'Voice name required');
      if (!transcription) return erro(400, '22023', 'Voice transcription required');
      const objectKey = String(p.object_key ?? '');
      if (!objectKey.startsWith(`${workspaceId}/audios/`) || !deposito.has(objectKey)) {
        return erro(400, 'P0001', 'Voice media file not uploaded');
      }
      const id = typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID();
      const lista = listaAudios(workspaceId);
      const existente = lista.find((a) => a.id === id);
      const removed_object_key = existente && existente.object_key !== objectKey ? existente.object_key : null;
      const ts = agora();
      const registro = {
        id,
        workspace_id: workspaceId,
        name,
        transcription,
        when_to_use: String(p.when_to_use ?? '').trim(),
        linked_message_code: String(p.linked_message_code ?? '').trim(),
        ai_enabled: p.ai_enabled !== false,
        object_key: objectKey,
        file_name: String(p.file_name || 'audio.ogg'),
        content_type: String(p.content_type || 'audio/ogg; codecs=opus'),
        byte_size: Number(p.byte_size ?? 1),
        duration_sec: p.duration_sec ?? null,
        waveform: Array.isArray(p.waveform) ? p.waveform : [],
        created_at: existente?.created_at ?? ts,
        updated_at: ts,
      };
      if (existente) {
        Object.assign(existente, registro);
      } else {
        lista.push(registro);
      }
      return responder(res, 200, { voice: registro, removed_object_key });
    }

    if (nome === 'delete_my_voice_item') {
      if (papel !== 'owner') return erro(403, '42501', 'Workspace owner required');
      const voiceId = String(corpo?.p_voice_id ?? '');
      const lista = listaAudios(workspaceId);
      const idx = lista.findIndex((a) => a.id === voiceId);
      if (idx < 0) return responder(res, 200, { deleted: false, removed_object_key: null });
      const [removido] = lista.splice(idx, 1);
      return responder(res, 200, { deleted: true, removed_object_key: removido?.object_key ?? null });
    }

    if (nome === 'read_my_simulator_session') {
      const key = `${workspaceId}:${usuario.id}`;
      const atual = estado.sessaoSimuladorPorUsuario.get(key) ?? {
        workspace_id: workspaceId,
        user_id: usuario.id,
        agent_id: null,
        history: [],
        updated_at: null,
      };
      return responder(res, 200, atual);
    }

    if (nome === 'save_my_simulator_session') {
      const key = `${workspaceId}:${usuario.id}`;
      const registro = {
        workspace_id: workspaceId,
        user_id: usuario.id,
        agent_id: corpo?.p_agent_id ?? null,
        history: Array.isArray(corpo?.p_history) ? corpo.p_history.slice(-40) : [],
        updated_at: agora(),
      };
      estado.sessaoSimuladorPorUsuario.set(key, registro);
      return responder(res, 200, registro);
    }

    if (nome === 'reset_my_simulator_session') {
      const key = `${workspaceId}:${usuario.id}`;
      const registro = {
        workspace_id: workspaceId,
        user_id: usuario.id,
        agent_id: corpo?.p_agent_id ?? null,
        history: [],
        updated_at: agora(),
      };
      estado.sessaoSimuladorPorUsuario.set(key, registro);
      return responder(res, 200, registro);
    }

    return erro(404, 'PGRST202', `Função não imitada: ${nome}`);
  }

  return {
    acoes,
    reiniciarFase6() {
      estado = estadoInicial();
    },
  };
}
