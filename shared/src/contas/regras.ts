import { DOMINIO_USUARIO_PADRAO, usuarioParaEmail } from '../auth/usuario';

export const MARCA_PADRAO = {
  nomeDaMarca: 'Ienvia',
  subtituloDaMarca: 'Atendente Universal',
} as const;

export const LIMITES_DE_CONTAS = {
  workspaceNomeMin: 2,
  workspaceNomeMax: 120,
  marcaNomeMin: 2,
  marcaNomeMax: 40,
  marcaSubtituloMax: 60,
  usuarioNomeMin: 1,
  usuarioNomeMax: 80,
  senhaMin: 8,
  senhaMax: 128,
  chipsMin: 0,
  chipsMax: 50,
  planoMax: 60,
  notasAdminMax: 4000,
  motivoSuporteMax: 300,
} as const;

export interface ConfiguracaoDaMarca {
  nomeWorkspace: string;
  nomeDaMarca: string;
  subtituloDaMarca: string;
  nomeDoUsuario: string;
}

export interface PoliticaDeDados {
  messageRetentionDays: number;
  mediaRetentionDays: number;
  recoveryWindowDays: number;
  activeDataPurgeSlaDays: number;
  backupExpiryTargetDays: number;
}

export type StatusWorkspaceSaas = 'active' | 'closed';

export interface ContaSaasResumo {
  id: string;
  name: string;
  status: 'active' | 'closed' | 'deleting' | 'deleted';
  maxInstances: number;
  brandName: string;
  brandSubtitle: string;
  planLabel: string;
  adminNotes: string;
  createdAt: string;
  closedAt: string | null;
  lastSupportAt: string | null;
  owner: {
    userId: string;
    email: string;
    login: string;
    displayName: string;
  } | null;
  membersCount: number;
  instancesTotal: number;
  instancesConnected: number;
  contactsCount: number;
  conversationsCount: number;
}

export interface EventoDeAuditoriaSuporte {
  id: number;
  workspaceId: string | null;
  workspaceName: string;
  action: string;
  actorEmail: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export type ResultadoValidacao<T> = { ok: true; dados: T } | { ok: false; erro: string };

const textoLimpo = (valor: unknown): string => String(valor ?? '').trim().replace(/\s+/g, ' ');
const textoMultilinha = (valor: unknown): string => String(valor ?? '').trim();

export function validarConfiguracaoDaMarca(entrada: {
  nomeWorkspace?: unknown;
  nomeDaMarca?: unknown;
  subtituloDaMarca?: unknown;
  nomeDoUsuario?: unknown;
}): ResultadoValidacao<ConfiguracaoDaMarca> {
  const nomeWorkspace = textoLimpo(entrada.nomeWorkspace);
  const nomeDaMarca = textoLimpo(entrada.nomeDaMarca);
  const subtituloDaMarca = textoLimpo(entrada.subtituloDaMarca);
  const nomeDoUsuario = textoLimpo(entrada.nomeDoUsuario);

  if (nomeWorkspace.length < LIMITES_DE_CONTAS.workspaceNomeMin || nomeWorkspace.length > LIMITES_DE_CONTAS.workspaceNomeMax) {
    return {
      ok: false,
      erro: `O nome da empresa deve ter entre ${LIMITES_DE_CONTAS.workspaceNomeMin} e ${LIMITES_DE_CONTAS.workspaceNomeMax} caracteres.`,
    };
  }
  if (nomeDaMarca.length < LIMITES_DE_CONTAS.marcaNomeMin || nomeDaMarca.length > LIMITES_DE_CONTAS.marcaNomeMax) {
    return {
      ok: false,
      erro: `O nome da marca no topo deve ter entre ${LIMITES_DE_CONTAS.marcaNomeMin} e ${LIMITES_DE_CONTAS.marcaNomeMax} caracteres.`,
    };
  }
  if (subtituloDaMarca.length > LIMITES_DE_CONTAS.marcaSubtituloMax) {
    return {
      ok: false,
      erro: `O subtítulo da marca pode ter no máximo ${LIMITES_DE_CONTAS.marcaSubtituloMax} caracteres.`,
    };
  }
  if (nomeDoUsuario.length < LIMITES_DE_CONTAS.usuarioNomeMin || nomeDoUsuario.length > LIMITES_DE_CONTAS.usuarioNomeMax) {
    return {
      ok: false,
      erro: `Seu nome de exibição deve ter entre ${LIMITES_DE_CONTAS.usuarioNomeMin} e ${LIMITES_DE_CONTAS.usuarioNomeMax} caracteres.`,
    };
  }

  return {
    ok: true,
    dados: { nomeWorkspace, nomeDaMarca, subtituloDaMarca, nomeDoUsuario },
  };
}

export function validarAlteracaoDeSenha(entrada: {
  senhaAtual?: unknown;
  novaSenha?: unknown;
  confirmarSenha?: unknown;
}): ResultadoValidacao<{ senhaAtual: string; novaSenha: string }> {
  const senhaAtual = String(entrada.senhaAtual ?? '');
  const novaSenha = String(entrada.novaSenha ?? '');
  const confirmarSenha = String(entrada.confirmarSenha ?? '');

  if (!senhaAtual) {
    return { ok: false, erro: 'Informe sua senha atual para confirmar a alteração.' };
  }
  if (novaSenha.length < LIMITES_DE_CONTAS.senhaMin || novaSenha.length > LIMITES_DE_CONTAS.senhaMax) {
    return {
      ok: false,
      erro: `A nova senha deve ter entre ${LIMITES_DE_CONTAS.senhaMin} e ${LIMITES_DE_CONTAS.senhaMax} caracteres.`,
    };
  }
  if (novaSenha === senhaAtual) {
    return { ok: false, erro: 'A nova senha precisa ser diferente da senha atual.' };
  }
  if (novaSenha !== confirmarSenha) {
    return { ok: false, erro: 'A confirmação da nova senha não confere.' };
  }
  return { ok: true, dados: { senhaAtual, novaSenha } };
}

function lerInteiro(valor: unknown, min: number, max: number): number | null {
  const n = typeof valor === 'number' ? valor : Number(String(valor ?? '').trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

export function validarPoliticaDeDados(entrada: {
  messageRetentionDays?: unknown;
  mediaRetentionDays?: unknown;
  recoveryWindowDays?: unknown;
  activeDataPurgeSlaDays?: unknown;
  backupExpiryTargetDays?: unknown;
}): ResultadoValidacao<PoliticaDeDados> {
  const messageRetentionDays = lerInteiro(entrada.messageRetentionDays, 1, 3650);
  if (messageRetentionDays === null) {
    return { ok: false, erro: 'A guarda de mensagens deve ficar entre 1 e 3650 dias.' };
  }
  const mediaRetentionDays = lerInteiro(entrada.mediaRetentionDays, 1, 3650);
  if (mediaRetentionDays === null) {
    return { ok: false, erro: 'A guarda de mídias deve ficar entre 1 e 3650 dias.' };
  }
  const recoveryWindowDays = lerInteiro(entrada.recoveryWindowDays, 1, 180);
  if (recoveryWindowDays === null) {
    return { ok: false, erro: 'A janela de recuperação deve ficar entre 1 e 180 dias.' };
  }
  const activeDataPurgeSlaDays = lerInteiro(entrada.activeDataPurgeSlaDays, 1, 90);
  if (activeDataPurgeSlaDays === null) {
    return { ok: false, erro: 'O prazo de exclusão LGPD deve ficar entre 1 e 90 dias.' };
  }
  const backupExpiryTargetDays = lerInteiro(entrada.backupExpiryTargetDays, 0, 90);
  if (backupExpiryTargetDays === null) {
    return { ok: false, erro: 'A expiração de cópias deve ficar entre 0 e 90 dias.' };
  }

  return {
    ok: true,
    dados: {
      messageRetentionDays,
      mediaRetentionDays,
      recoveryWindowDays,
      activeDataPurgeSlaDays,
      backupExpiryTargetDays,
    },
  };
}

export interface CriacaoDeClienteValidada {
  workspaceNome: string;
  email: string;
  nomeUsuario: string;
  senha: string;
  limiteDeChips: number;
  plano: string;
  notasAdmin: string;
  nomeDaMarca: string;
  subtituloDaMarca: string;
}

export function validarCriacaoDeCliente(
  entrada: {
    workspaceNome?: unknown;
    loginOuEmail?: unknown;
    nomeUsuario?: unknown;
    senha?: unknown;
    limiteDeChips?: unknown;
    plano?: unknown;
    notasAdmin?: unknown;
    nomeDaMarca?: unknown;
    subtituloDaMarca?: unknown;
  },
  dominioPadrao: string = DOMINIO_USUARIO_PADRAO,
): ResultadoValidacao<CriacaoDeClienteValidada> {
  const workspaceNome = textoLimpo(entrada.workspaceNome);
  const email = usuarioParaEmail(String(entrada.loginOuEmail ?? ''), dominioPadrao);
  const nomeUsuario = textoLimpo(entrada.nomeUsuario);
  const senha = String(entrada.senha ?? '');
  const limiteDeChips = lerInteiro(entrada.limiteDeChips ?? 1, LIMITES_DE_CONTAS.chipsMin, LIMITES_DE_CONTAS.chipsMax);
  const plano = textoLimpo(entrada.plano || 'Padrão');
  const notasAdmin = textoMultilinha(entrada.notasAdmin);
  const nomeDaMarca = textoLimpo(entrada.nomeDaMarca || MARCA_PADRAO.nomeDaMarca);
  const subtituloDaMarca = textoLimpo(entrada.subtituloDaMarca ?? MARCA_PADRAO.subtituloDaMarca);

  if (workspaceNome.length < LIMITES_DE_CONTAS.workspaceNomeMin || workspaceNome.length > LIMITES_DE_CONTAS.workspaceNomeMax) {
    return {
      ok: false,
      erro: `O nome da empresa deve ter entre ${LIMITES_DE_CONTAS.workspaceNomeMin} e ${LIMITES_DE_CONTAS.workspaceNomeMax} caracteres.`,
    };
  }
  if (!email) {
    return { ok: false, erro: 'Informe um usuário (ex.: loja-centro) ou um e-mail válido para o acesso do cliente.' };
  }
  if (nomeUsuario.length > LIMITES_DE_CONTAS.usuarioNomeMax) {
    return { ok: false, erro: `O nome do responsável pode ter no máximo ${LIMITES_DE_CONTAS.usuarioNomeMax} caracteres.` };
  }
  if (senha.length < LIMITES_DE_CONTAS.senhaMin || senha.length > LIMITES_DE_CONTAS.senhaMax) {
    return {
      ok: false,
      erro: `A senha inicial deve ter entre ${LIMITES_DE_CONTAS.senhaMin} e ${LIMITES_DE_CONTAS.senhaMax} caracteres.`,
    };
  }
  if (limiteDeChips === null) {
    return {
      ok: false,
      erro: `O limite de chips deve ser um número inteiro entre ${LIMITES_DE_CONTAS.chipsMin} e ${LIMITES_DE_CONTAS.chipsMax}.`,
    };
  }
  if (plano.length > LIMITES_DE_CONTAS.planoMax) {
    return { ok: false, erro: `O rótulo do plano pode ter no máximo ${LIMITES_DE_CONTAS.planoMax} caracteres.` };
  }
  if (notasAdmin.length > LIMITES_DE_CONTAS.notasAdminMax) {
    return { ok: false, erro: `As anotações do administrador podem ter no máximo ${LIMITES_DE_CONTAS.notasAdminMax} caracteres.` };
  }
  if (nomeDaMarca.length < LIMITES_DE_CONTAS.marcaNomeMin || nomeDaMarca.length > LIMITES_DE_CONTAS.marcaNomeMax) {
    return {
      ok: false,
      erro: `O nome da marca deve ter entre ${LIMITES_DE_CONTAS.marcaNomeMin} e ${LIMITES_DE_CONTAS.marcaNomeMax} caracteres.`,
    };
  }
  if (subtituloDaMarca.length > LIMITES_DE_CONTAS.marcaSubtituloMax) {
    return { ok: false, erro: `O subtítulo da marca pode ter no máximo ${LIMITES_DE_CONTAS.marcaSubtituloMax} caracteres.` };
  }

  return {
    ok: true,
    dados: {
      workspaceNome,
      email,
      nomeUsuario: nomeUsuario || workspaceNome,
      senha,
      limiteDeChips,
      plano: plano || 'Padrão',
      notasAdmin,
      nomeDaMarca,
      subtituloDaMarca,
    },
  };
}

export interface AtualizacaoDeClienteValidada {
  workspaceNome: string;
  status: StatusWorkspaceSaas;
  limiteDeChips: number;
  plano: string;
  notasAdmin: string;
}

export function validarAtualizacaoDeCliente(entrada: {
  workspaceNome?: unknown;
  status?: unknown;
  limiteDeChips?: unknown;
  plano?: unknown;
  notasAdmin?: unknown;
}): ResultadoValidacao<AtualizacaoDeClienteValidada> {
  const workspaceNome = textoLimpo(entrada.workspaceNome);
  const status = entrada.status === 'closed' ? 'closed' : entrada.status === 'active' ? 'active' : null;
  const limiteDeChips = lerInteiro(entrada.limiteDeChips, LIMITES_DE_CONTAS.chipsMin, LIMITES_DE_CONTAS.chipsMax);
  const plano = textoLimpo(entrada.plano || 'Padrão');
  const notasAdmin = textoMultilinha(entrada.notasAdmin);

  if (workspaceNome.length < LIMITES_DE_CONTAS.workspaceNomeMin || workspaceNome.length > LIMITES_DE_CONTAS.workspaceNomeMax) {
    return {
      ok: false,
      erro: `O nome da empresa deve ter entre ${LIMITES_DE_CONTAS.workspaceNomeMin} e ${LIMITES_DE_CONTAS.workspaceNomeMax} caracteres.`,
    };
  }
  if (!status) {
    return { ok: false, erro: 'Situação da conta inválida.' };
  }
  if (limiteDeChips === null) {
    return {
      ok: false,
      erro: `O limite de chips deve ser um número inteiro entre ${LIMITES_DE_CONTAS.chipsMin} e ${LIMITES_DE_CONTAS.chipsMax}.`,
    };
  }
  if (plano.length > LIMITES_DE_CONTAS.planoMax) {
    return { ok: false, erro: `O rótulo do plano pode ter no máximo ${LIMITES_DE_CONTAS.planoMax} caracteres.` };
  }
  if (notasAdmin.length > LIMITES_DE_CONTAS.notasAdminMax) {
    return { ok: false, erro: `As anotações podem ter no máximo ${LIMITES_DE_CONTAS.notasAdminMax} caracteres.` };
  }

  return {
    ok: true,
    dados: {
      workspaceNome,
      status,
      limiteDeChips,
      plano: plano || 'Padrão',
      notasAdmin,
    },
  };
}

export function validarMotivoSuporte(motivo: unknown): ResultadoValidacao<string> {
  const texto = textoLimpo(motivo);
  if (texto.length > LIMITES_DE_CONTAS.motivoSuporteMax) {
    return { ok: false, erro: `O motivo do suporte pode ter no máximo ${LIMITES_DE_CONTAS.motivoSuporteMax} caracteres.` };
  }
  return { ok: true, dados: texto };
}

export const CAMPOS_SENSIVEIS_EXPORTACAO = new Set([
  'encrypted_api_key',
  'api_key',
  'apikey',
  'token_sha256',
  'device_token_sha256',
  'pair_code_sha256',
  'webhook_token_sha256',
  'password_hash',
  'encrypted_password',
]);

/** Remove recursivamente qualquer campo de chave cifrada ou hash antes de devolver dados exportados. */
export function sanitizarObjetoParaExportacao<T>(valor: T): T {
  if (Array.isArray(valor)) {
    return valor.map((item) => sanitizarObjetoParaExportacao(item)) as unknown as T;
  }
  if (valor && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chave, val] of Object.entries(valor as Record<string, unknown>)) {
      if (CAMPOS_SENSIVEIS_EXPORTACAO.has(chave.toLowerCase())) continue;
      saida[chave] = sanitizarObjetoParaExportacao(val);
    }
    return saida as T;
  }
  return valor;
}
