import { describe, expect, test } from 'vitest';
import {
  crc16Ccitt,
  formatarMensagemPix,
  gerarBrCodePix,
  interpretarValorPix,
  lerConfiguracaoPix,
  normalizarChavePix,
  validarConfiguracaoPixParaSalvar,
} from '../src/recursos/pix';
import {
  avaliarArquivoDeAudio,
  avaliarArquivoDeCatalogo,
  caminhoAudioEstrategico,
  caminhoArquivoDeCatalogo,
  detectarRecusaDeAudioDoCliente,
  ehCaminhoAudioEstrategico,
  ehCaminhoArquivoDeCatalogo,
  ehOggOpusNativo,
  ehUrlPagamentoSegura,
  inspecionarOggOpus,
  normalizarWaveform,
  validarAudioEstrategicoParaSalvar,
  validarItemCatalogoParaSalvar,
} from '../src/recursos/regras';

describe('PIX EMV Banco Central', () => {
  test('normaliza CPF, CNPJ e celular com +55 automaticamente', () => {
    expect(normalizarChavePix('123.456.789-00', 'cpf')).toBe('12345678900');
    expect(normalizarChavePix('12.345.678/0001-99', 'cnpj')).toBe('12345678000199');
    expect(normalizarChavePix('(86) 99988-7766', 'celular')).toBe('+5586999887766');
    expect(normalizarChavePix('+5586999887766', 'celular')).toBe('+5586999887766');
    expect(normalizarChavePix('pix@empresa.com', 'email')).toBe('pix@empresa.com');
  });

  test('interpreta valores em formato brasileiro e americano', () => {
    expect(interpretarValorPix('149,90')).toBe(149.9);
    expect(interpretarValorPix('R$ 1.250,50')).toBe(1250.5);
    expect(interpretarValorPix('149.90')).toBe(149.9);
    expect(interpretarValorPix(0)).toBeNull();
    expect(interpretarValorPix('')).toBeNull();
  });

  test('gera BR Code EMV válido com CRC16-CCITT correto e sem acentos', () => {
    const brcode = gerarBrCodePix({
      key: '(86) 99988-7766',
      keyType: 'celular',
      receiverName: 'José Araújo / Loja',
      city: 'São Paulo',
      amount: '149,90',
    });
    expect(brcode).not.toBeNull();
    expect(brcode).toContain('br.gov.bcb.pix');
    expect(brcode).toContain('+5586999887766');
    expect(brcode).toContain('5406149.90');
    expect(brcode).toContain('5916JOSE ARAUJO LOJA');
    expect(brcode).toContain('6009SAO PAULO');
    const semCrc = brcode!.slice(0, -4);
    expect(brcode!.slice(-4)).toBe(crc16Ccitt(semCrc));
  });

  test('formatarMensagemPix respeita flag enabled e allowDisabled', () => {
    expect(formatarMensagemPix({ enabled: false, key: 'a@b.com', keyType: 'email' })).toBeNull();
    const preview = formatarMensagemPix(
      { enabled: false, allowDisabled: true, key: 'a@b.com', keyType: 'email', receiverName: 'Loja', bankName: 'Nubank' },
      '99,90',
    );
    expect(preview).not.toBeNull();
    expect(preview!.summaryText).toContain('*Valor:* R$ 99,90');
    expect(preview!.brcode).toContain('br.gov.bcb.pix');
  });

  test('validarConfiguracaoPixParaSalvar valida tipo x chave e obrigatoriedade ao ligar', () => {
    expect(validarConfiguracaoPixParaSalvar({ enabled: true, keyType: 'email', key: '' })).toEqual({
      ok: false,
      erro: 'Informe a chave PIX antes de ativar o envio automático.',
    });
    expect(validarConfiguracaoPixParaSalvar({ enabled: true, keyType: 'cpf', key: '123' }).ok).toBe(false);
    expect(validarConfiguracaoPixParaSalvar({ enabled: true, keyType: 'email', key: 'vendas@loja.com' }).ok).toBe(true);
    expect(lerConfiguracaoPix({ enabled: true, key_type: 'celular', pix_key: '86999887766' }).enabled).toBe(true);
  });
});

describe('Catálogo e Áudios Estratégicos', () => {
  test('valida URL HTTPS segura e caminhos de storage isolados por workspace', () => {
    expect(ehUrlPagamentoSegura('')).toBe(true);
    expect(ehUrlPagamentoSegura('https://pay.exemplo.com/checkout')).toBe(true);
    expect(ehUrlPagamentoSegura('http://inseguro.com')).toBe(false);
    expect(ehUrlPagamentoSegura('https://user:pass@site.com')).toBe(false);

    const ws = '11111111-1111-4111-8111-111111111111';
    const item = '22222222-2222-4222-8222-222222222222';
    const file = '33333333-3333-4333-8333-333333333333';
    const pCat = caminhoArquivoDeCatalogo(ws, item, file, 'foto-carro.jpg');
    expect(ehCaminhoArquivoDeCatalogo(pCat, ws)).toBe(true);
    expect(ehCaminhoArquivoDeCatalogo(pCat, item)).toBe(false);

    const pAud = caminhoAudioEstrategico(ws, item, file, 'abertura.ogg');
    expect(ehCaminhoAudioEstrategico(pAud, ws)).toBe(true);
    expect(ehCaminhoAudioEstrategico(pCat, ws)).toBe(false);
  });

  test('avalia arquivos do catálogo (até 5, fotos e PDF) e áudio estratégico', () => {
    expect(avaliarArquivoDeCatalogo({ nome: 'tabela.pdf', tipoInformado: 'application/pdf', tamanho: 1024 })).toMatchObject({
      ok: true,
      contentType: 'application/pdf',
    });
    expect(avaliarArquivoDeCatalogo({ nome: 'virus.exe', tipoInformado: '', tamanho: 1024 }).ok).toBe(false);
    expect(avaliarArquivoDeAudio({ nome: 'voz.ogg', tipoInformado: 'audio/ogg; codecs=opus', tamanho: 4000 })).toMatchObject({
      ok: true,
      contentType: 'audio/ogg',
    });
    expect(avaliarArquivoDeAudio({ nome: 'foto.png', tipoInformado: 'image/png', tamanho: 4000 }).ok).toBe(false);
  });

  test('detecta container Ogg/Opus, gera waveform de 64 barras e detecta recusa de áudio (S06)', () => {
    const fakeOgg = new Uint8Array(64);
    fakeOgg.set([0x4f, 0x67, 0x67, 0x53], 0);
    fakeOgg[26] = 1;
    fakeOgg[27] = 19;
    fakeOgg.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 28);
    expect(ehOggOpusNativo(fakeOgg)).toBe(true);
    const info = inspecionarOggOpus(fakeOgg);
    expect(info).not.toBeNull();
    expect(info!.waveform).toHaveLength(64);
    expect(normalizarWaveform([10, 50, 90])).toHaveLength(64);

    expect(detectarRecusaDeAudioDoCliente('Tô sem fone, não consigo ouvir áudio agora', [])).toBe(true);
    expect(detectarRecusaDeAudioDoCliente('Quero saber mais sobre o veículo', [])).toBe(false);
  });

  test('valida formulário de item do catálogo e áudio estratégico', () => {
    expect(validarItemCatalogoParaSalvar({ name: 'Corolla 2024', paymentLink: 'http://nao-https.com' }).ok).toBe(false);
    expect(
      validarItemCatalogoParaSalvar({
        name: 'Corolla 2024',
        files: Array.from({ length: 6 }, (_, i) => ({
          objectKey: `k${i}`,
          fileName: `f${i}.jpg`,
          contentType: 'image/jpeg',
          byteSize: 100,
        })),
      }).ok,
    ).toBe(false);
    expect(validarItemCatalogoParaSalvar({ name: 'Corolla 2024', paymentLink: 'https://loja.com/pagar' }).ok).toBe(true);

    expect(validarAudioEstrategicoParaSalvar({ name: 'Boas-vindas', transcription: '', objectKey: 'a/b' }).ok).toBe(false);
    expect(validarAudioEstrategicoParaSalvar({ name: 'Boas-vindas', transcription: 'Olá tudo bem', objectKey: 'a/b' }).ok).toBe(true);
  });
});
