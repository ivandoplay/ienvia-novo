'use server';

import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import {
  validarAlteracaoDeSenha,
  validarConfiguracaoDaMarca,
  validarPoliticaDeDados,
  type ConfiguracaoDaMarca,
  type PoliticaDeDados,
} from '@ienvia/shared/contas';
import { usuarioParaEmail } from '@ienvia/shared';
import { dominioDeUsuario, lerConfigSupabase } from '@/lib/env';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export type ResultadoAcao<T = undefined> = T extends undefined
  ? { ok: true; mensagem: string } | { ok: false; erro: string }
  : { ok: true; mensagem: string; dados: T } | { ok: false; erro: string };

const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo para continuar.';
const SOMENTE_DONO = 'Somente o proprietário da conta pode alterar essas configurações.';

export async function salvarMarcaEPerfil(
  entrada: ConfiguracaoDaMarca,
): Promise<ResultadoAcao<ConfiguracaoDaMarca>> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };

  const validado = validarConfiguracaoDaMarca(entrada);
  if (!validado.ok) return { ok: false, erro: validado.erro };

  const supabase = await criarClienteServidor();

  // Perfil pessoal: qualquer usuário pode atualizar o próprio nome de exibição.
  const { error: erroPerfil } = await supabase.from('profiles').upsert(
    {
      id: sessao.usuario.id,
      display_name: validado.dados.nomeDoUsuario,
    },
    { onConflict: 'id' },
  );

  if (erroPerfil) {
    console.error('[configurações] erro ao salvar perfil:', erroPerfil);
    return { ok: false, erro: 'Não foi possível salvar seu nome de exibição agora.' };
  }

  // White-label e nome da empresa: apenas proprietário (ou master em Modo Suporte).
  if (sessao.workspaceAtivo.papel === 'owner') {
    const { error: erroMarca } = await supabase.rpc('update_my_workspace_branding', {
      p_workspace_id: sessao.workspaceAtivo.id,
      p_workspace_name: validado.dados.nomeWorkspace,
      p_brand_name: validado.dados.nomeDaMarca,
      p_brand_subtitle: validado.dados.subtituloDaMarca,
    });
    if (erroMarca) {
      console.error('[configurações] erro ao salvar marca:', erroMarca);
      return {
        ok: false,
        erro: /Workspace owner required/.test(erroMarca.message)
          ? SOMENTE_DONO
          : /not active/i.test(erroMarca.message)
            ? 'Esta conta está desativada; reative-a antes de alterar o nome e a marca.'
            : 'Não foi possível salvar a marca e o nome da empresa.',
      };
    }
  }

  revalidatePath('/', 'layout');
  revalidatePath('/configuracoes');
  return {
    ok: true,
    mensagem:
      sessao.workspaceAtivo.papel === 'owner'
        ? 'Nome, marca e perfil salvos.'
        : 'Seu nome de exibição foi atualizado.',
    dados: validado.dados,
  };
}

export async function salvarNomePessoal(nomeDoUsuario: string): Promise<ResultadoAcao> {
  const sessao = await obterSessao();
  if (!sessao) return { ok: false, erro: SESSAO_EXPIRADA };
  const limpo = String(nomeDoUsuario ?? '').trim().replace(/\s+/g, ' ');
  if (limpo.length < 1 || limpo.length > 80) {
    return { ok: false, erro: 'Seu nome de exibição deve ter entre 1 e 80 caracteres.' };
  }

  const supabase = await criarClienteServidor();
  const { error } = await supabase.from('profiles').upsert(
    { id: sessao.usuario.id, display_name: limpo },
    { onConflict: 'id' },
  );
  if (error) {
    console.error('[configurações] erro ao salvar nome pessoal:', error);
    return { ok: false, erro: 'Não foi possível salvar seu nome agora.' };
  }

  revalidatePath('/', 'layout');
  revalidatePath('/configuracoes');
  return { ok: true, mensagem: 'Seu nome de exibição foi atualizado.' };
}

export async function alterarMinhaSenha(entrada: {
  senhaAtual: string;
  novaSenha: string;
  confirmarSenha: string;
}): Promise<ResultadoAcao> {
  const sessao = await obterSessao();
  if (!sessao) return { ok: false, erro: SESSAO_EXPIRADA };

  const validado = validarAlteracaoDeSenha(entrada);
  if (!validado.ok) return { ok: false, erro: validado.erro };

  const cfg = lerConfigSupabase();
  if (!cfg) return { ok: false, erro: 'O painel ainda não foi ligado ao banco de dados.' };

  const email = usuarioParaEmail(sessao.usuario.login, dominioDeUsuario());
  if (!email) return { ok: false, erro: 'Conta sem e-mail válido para conferência.' };

  const verificador = createClient(cfg.url, cfg.chavePublica, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: erroAtual } = await verificador.auth.signInWithPassword({
    email,
    password: validado.dados.senhaAtual,
  });
  if (erroAtual) {
    return { ok: false, erro: 'A senha atual informada não confere.' };
  }

  const supabase = await criarClienteServidor();
  const { error: erroTroca } = await supabase.auth.updateUser({ password: validado.dados.novaSenha });
  if (erroTroca) {
    console.error('[configurações] erro ao atualizar senha:', erroTroca);
    return { ok: false, erro: 'Não foi possível alterar a senha agora. Tente outra senha forte.' };
  }

  return { ok: true, mensagem: 'Senha alterada com sucesso.' };
}

export async function salvarPoliticaDeDados(entrada: PoliticaDeDados): Promise<ResultadoAcao<PoliticaDeDados>> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { ok: false, erro: SESSAO_EXPIRADA };
  if (sessao.workspaceAtivo.papel !== 'owner') return { ok: false, erro: SOMENTE_DONO };

  const validado = validarPoliticaDeDados(entrada);
  if (!validado.ok) return { ok: false, erro: validado.erro };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.rpc('update_my_workspace_data_policy', {
    p_workspace_id: sessao.workspaceAtivo.id,
    p_message_retention_days: validado.dados.messageRetentionDays,
    p_media_retention_days: validado.dados.mediaRetentionDays,
    p_recovery_window_days: validado.dados.recoveryWindowDays,
    p_active_data_purge_sla_days: validado.dados.activeDataPurgeSlaDays,
    p_backup_expiry_target_days: validado.dados.backupExpiryTargetDays,
  });

  if (error) {
    console.error('[configurações] erro ao atualizar política LGPD:', error);
    return { ok: false, erro: 'Não foi possível salvar a política de retenção agora.' };
  }

  revalidatePath('/configuracoes');
  return { ok: true, mensagem: 'Política de guarda e limpeza atualizada.', dados: validado.dados };
}
