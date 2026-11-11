import type { MetadataRoute } from 'next';

/** Permite "instalar" o painel na tela inicial do celular, como um aplicativo. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Ienvia — Atendimento inteligente no WhatsApp',
    short_name: 'Ienvia',
    description: 'Atendimento inteligente e CRM para WhatsApp.',
    lang: 'pt-BR',
    start_url: '/visao-geral',
    display: 'standalone',
    background_color: '#080e13',
    theme_color: '#059669',
    icons: [
      { src: '/pwa/192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa/512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
