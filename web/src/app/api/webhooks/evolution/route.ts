import { after } from 'next/server';
import { processarAvisoEvolution } from '@/lib/evolution/processar-aviso';

/**
 * Porta de entrada dos avisos da Evolution no painel Next.js (usada em testes locais e como reserva
 * quando o tráfego principal vai para a Supabase Edge Function via porteiro Cloudflare).
 */
export const maxDuration = 60;

export async function POST(pedido: Request): Promise<Response> {
  return processarAvisoEvolution(pedido, {
    agendar: (tarefa) => after(tarefa),
  });
}
