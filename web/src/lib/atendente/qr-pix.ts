import { Buffer } from 'node:buffer';
import QRCode from 'qrcode';

/**
 * Gera PNG de QR Code PIX em memória usando algoritmo pure-JS (compatível com Node.js, Vercel e Deno Edge).
 */
export async function gerarPngQrPix(brcode: string): Promise<Buffer> {
  const dataUrl = await QRCode.toDataURL(brcode, {
    width: 340,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(base64, 'base64');
}
