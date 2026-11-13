/**
 * Gerador e validador oficial de PIX Copia e Cola (padrão EMV QRCPS / Banco Central do Brasil).
 * Código puro, sem dependências de Node, DOM ou rede: roda igual no servidor, navegador e Edge Function.
 */

export const TIPOS_CHAVE_PIX = ['cnpj', 'cpf', 'celular', 'email', 'aleatoria'] as const;
export type TipoChavePix = (typeof TIPOS_CHAVE_PIX)[number];

export const ROTULOS_CHAVE_PIX: Record<TipoChavePix, string> = {
  cnpj: 'CNPJ',
  cpf: 'CPF',
  celular: 'Celular',
  email: 'E-mail',
  aleatoria: 'Chave Aleatória',
};

export interface ConfiguracaoPix {
  enabled: boolean;
  keyType: TipoChavePix;
  key: string;
  receiverName: string;
  bankName: string;
  city: string;
  sendQrImage: boolean;
  includeCopyPaste: boolean;
  instructions: string;
  updatedAt: string | null;
}

export const CONFIG_PIX_PADRAO: ConfiguracaoPix = {
  enabled: false,
  keyType: 'aleatoria',
  key: '',
  receiverName: '',
  bankName: '',
  city: 'BRASIL',
  sendQrImage: true,
  includeCopyPaste: true,
  instructions: '',
  updatedAt: null,
};

function semAcentosEmv(valor = ''): string {
  return String(valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function campoEmv(id: string, valor: string): string {
  const texto = String(valor ?? '');
  const tamanho = String(texto.length).padStart(2, '0');
  return `${id}${tamanho}${texto}`;
}

export function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i += 1) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function normalizarChavePix(chave = '', tipo: TipoChavePix = 'aleatoria'): string {
  const limpa = String(chave ?? '').trim();
  if (!limpa) return '';
  const digitos = limpa.replace(/\D/g, '');
  if (tipo === 'cpf' || tipo === 'cnpj') {
    return digitos;
  }
  if (tipo === 'celular') {
    if (!digitos) return '';
    if (limpa.startsWith('+')) return `+${digitos}`;
    if (digitos.length === 11 || digitos.length === 10) return `+55${digitos}`;
    if (digitos.startsWith('55') && digitos.length >= 12) return `+${digitos}`;
    return `+${digitos}`;
  }
  return limpa;
}

export function interpretarValorPix(valor: number | string | null | undefined): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') {
    return Number.isFinite(valor) && valor > 0 ? Math.round(valor * 100) / 100 : null;
  }
  const limpo = String(valor)
    .trim()
    .replace(/[^\d.,-]/g, '');
  if (!limpo) return null;

  let normalizado = limpo;
  if (limpo.includes(',')) {
    // Ex.: "1.249,90" ou "149,90"
    normalizado = limpo.replace(/\./g, '').replace(',', '.');
  } else {
    // Ex.: "149.90" ou "1.249"
    const pontos = limpo.split('.');
    if (pontos.length > 2 || (pontos.length === 2 && (pontos[1]?.length ?? 0) === 3)) {
      normalizado = limpo.replace(/\./g, '');
    }
  }
  const numero = Number.parseFloat(normalizado);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return Math.round(numero * 100) / 100;
}

export function gerarBrCodePix(params: {
  key: string;
  keyType?: TipoChavePix;
  receiverName?: string;
  city?: string;
  amount?: number | string | null;
  txid?: string;
}): string | null {
  const tipo = params.keyType ?? 'aleatoria';
  const chaveNormalizada = normalizarChavePix(params.key, tipo);
  if (!chaveNormalizada) return null;

  const nomeLimpo = (semAcentosEmv(params.receiverName ?? '') || 'RECEBEDOR').slice(0, 25).toUpperCase();
  const cidadeLimpa = (semAcentosEmv(params.city ?? '') || 'BRASIL').slice(0, 15).toUpperCase();
  const txidLimpo = (semAcentosEmv(params.txid ?? '').replace(/\s+/g, '') || '***').slice(0, 25);

  const gui = campoEmv('00', 'br.gov.bcb.pix');
  const chaveEmv = campoEmv('01', chaveNormalizada);
  const contaComerciante = campoEmv('26', `${gui}${chaveEmv}`);

  let payload = '';
  payload += campoEmv('00', '01');
  payload += contaComerciante;
  payload += campoEmv('52', '0000');
  payload += campoEmv('53', '986');

  const valor = interpretarValorPix(params.amount);
  if (valor !== null) {
    payload += campoEmv('54', valor.toFixed(2));
  }

  payload += campoEmv('58', 'BR');
  payload += campoEmv('59', nomeLimpo);
  payload += campoEmv('60', cidadeLimpa);
  payload += campoEmv('62', campoEmv('05', txidLimpo === '***' ? '***' : txidLimpo));
  payload += '6304';

  const crc = crc16Ccitt(payload);
  return `${payload}${crc}`;
}

export interface MensagemPixFormatada {
  summaryText: string;
  rawKey: string;
  brcode: string | null;
  qrBrcode: string;
  sendQrImage: boolean;
  amount: number | null;
}

export function formatarMensagemPix(
  config: Partial<ConfiguracaoPix> & { allowDisabled?: boolean },
  valorSolicitado: number | string | null = null,
): MensagemPixFormatada | null {
  const chave = typeof config.key === 'string' ? config.key.trim() : '';
  if (!chave) return null;
  if (!config.allowDisabled && config.enabled !== true) return null;

  const keyType: TipoChavePix =
    config.keyType && (TIPOS_CHAVE_PIX as readonly string[]).includes(config.keyType)
      ? config.keyType
      : 'aleatoria';

  const brcode = gerarBrCodePix({
    key: chave,
    keyType,
    receiverName: config.receiverName || 'ATENDIMENTO',
    city: config.city || 'BRASIL',
    amount: valorSolicitado,
  });
  if (!brcode) return null;

  const linhas: string[] = [
    '*DADOS PARA PAGAMENTO VIA PIX*',
    '',
    `*Tipo:* ${ROTULOS_CHAVE_PIX[keyType]}`,
    `*Chave:* ${chave}`,
  ];

  if (config.receiverName?.trim()) {
    linhas.push(`*Favorecido:* ${config.receiverName.trim()}`);
  }
  if (config.bankName?.trim()) {
    linhas.push(`*Instituição:* ${config.bankName.trim()}`);
  }

  const valor = interpretarValorPix(valorSolicitado);
  if (valor !== null) {
    linhas.push(`*Valor:* R$ ${valor.toFixed(2).replace('.', ',')}`);
  }

  if (config.instructions?.trim()) {
    linhas.push('', config.instructions.trim());
  } else {
    linhas.push('', '_Assim que realizar o pagamento, envie o comprovante por aqui para confirmarmos na hora!_');
  }

  return {
    summaryText: linhas.join('\n'),
    rawKey: chave,
    brcode: config.includeCopyPaste !== false ? brcode : null,
    qrBrcode: brcode,
    sendQrImage: config.sendQrImage !== false,
    amount: valor,
  };
}

export function lerConfiguracaoPix(bruto: unknown): ConfiguracaoPix {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return { ...CONFIG_PIX_PADRAO };
  }
  const o = bruto as Record<string, unknown>;
  const texto = (chave: string, max: number) =>
    typeof o[chave] === 'string' ? o[chave].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';

  const keyTypeRaw = typeof o.key_type === 'string' ? o.key_type : o.keyType;
  const keyType: TipoChavePix =
    typeof keyTypeRaw === 'string' && (TIPOS_CHAVE_PIX as readonly string[]).includes(keyTypeRaw)
      ? (keyTypeRaw as TipoChavePix)
      : 'aleatoria';

  const key = texto(typeof o.pix_key === 'string' ? 'pix_key' : 'key', 200);
  const receiverName = texto(typeof o.receiver_name === 'string' ? 'receiver_name' : 'receiverName', 200);
  const bankName = texto(typeof o.bank_name === 'string' ? 'bank_name' : 'bankName', 200);
  const city = texto('city', 80) || 'BRASIL';
  const instructions = texto('instructions', 2000);
  const sendQrImage = typeof o.send_qr_image === 'boolean' ? o.send_qr_image : o.sendQrImage !== false;
  const includeCopyPaste =
    typeof o.include_copy_paste === 'boolean' ? o.include_copy_paste : o.includeCopyPaste !== false;
  const updatedAt = typeof o.updated_at === 'string' ? o.updated_at : typeof o.updatedAt === 'string' ? o.updatedAt : null;

  return {
    enabled: o.enabled === true && Boolean(key),
    keyType,
    key,
    receiverName,
    bankName,
    city,
    sendQrImage,
    includeCopyPaste,
    instructions,
    updatedAt,
  };
}

export function validarConfiguracaoPixParaSalvar(
  config: Partial<ConfiguracaoPix>,
): { ok: true; dados: Omit<ConfiguracaoPix, 'updatedAt'> } | { ok: false; erro: string } {
  const keyType: TipoChavePix =
    config.keyType && (TIPOS_CHAVE_PIX as readonly string[]).includes(config.keyType) ? config.keyType : 'aleatoria';
  const key = (config.key ?? '').trim().slice(0, 200);
  const enabled = config.enabled === true;

  if (enabled && !key) {
    return { ok: false, erro: 'Informe a chave PIX antes de ativar o envio automático.' };
  }
  if (key && keyType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) {
    return { ok: false, erro: 'A chave PIX do tipo E-mail parece inválida.' };
  }
  if (key && keyType === 'cpf' && normalizarChavePix(key, 'cpf').length !== 11) {
    return { ok: false, erro: 'A chave CPF precisa ter 11 dígitos.' };
  }
  if (key && keyType === 'cnpj' && normalizarChavePix(key, 'cnpj').length !== 14) {
    return { ok: false, erro: 'A chave CNPJ precisa ter 14 dígitos.' };
  }
  if (key && keyType === 'celular' && normalizarChavePix(key, 'celular').replace(/\D/g, '').length < 10) {
    return { ok: false, erro: 'Informe o número completo com DDD para chave celular.' };
  }

  return {
    ok: true,
    dados: {
      enabled,
      keyType,
      key,
      receiverName: (config.receiverName ?? '').trim().slice(0, 200),
      bankName: (config.bankName ?? '').trim().slice(0, 200),
      city: ((config.city ?? '').trim() || 'BRASIL').slice(0, 80),
      sendQrImage: config.sendQrImage !== false,
      includeCopyPaste: config.includeCopyPaste !== false,
      instructions: (config.instructions ?? '').trim().slice(0, 2000),
    },
  };
}
