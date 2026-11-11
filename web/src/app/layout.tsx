import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { COOKIE_TEMA, lerTema } from '@/lib/tema';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Ienvia — Atendimento inteligente no WhatsApp',
    template: '%s · Ienvia',
  },
  description: 'Atendimento inteligente e CRM para WhatsApp.',
  // O painel é uma área privada: não deve aparecer em buscadores.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#059669',
};

export default async function LayoutRaiz({ children }: { children: ReactNode }) {
  // O tema fica num cookie para a página já chegar na cor certa, sem piscar.
  const cookieStore = await cookies();
  const tema = lerTema(cookieStore.get(COOKIE_TEMA)?.value);

  return (
    // data-scroll-behavior: a rolagem suave vale para âncoras, não para a troca de aba.
    <html lang="pt-BR" data-theme={tema === 'claro' ? 'light' : undefined} data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
