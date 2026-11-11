import type { Metadata } from 'next';
import Image from 'next/image';
import { destinoSeguro } from '@/lib/redirecionamento';
import { FormularioDeLogin } from './formulario';

export const metadata: Metadata = {
  title: 'Entrar',
};

const DESTAQUES = ['Inbox ao vivo', 'Vários chips', 'Áudios na sua voz', 'Dados isolados por conta'];

export default async function PaginaDeLogin({ searchParams }: PageProps<'/login'>) {
  const { voltar } = await searchParams;
  const destino = destinoSeguro(Array.isArray(voltar) ? voltar[0] : voltar);

  return (
    <main className="tela-login">
      <div className="saas-login-card">
        <div className="login-marca">
          <div className="brand-mark" aria-hidden="true">
            <Image src="/ienvia-icone.png" alt="" width={48} height={48} priority />
          </div>
          <div>
            <h1 className="panel-title login-titulo">Ienvia</h1>
            <div className="login-subtitulo">Atendimento inteligente e CRM para WhatsApp</div>
          </div>
        </div>

        <div className="saas-login-pills" aria-hidden="true">
          {DESTAQUES.map((destaque) => (
            <span key={destaque} className="saas-login-pill">
              {destaque}
            </span>
          ))}
        </div>

        <p className="panel-desc login-descricao">
          Entre com seu usuário (ou e-mail) e senha para acessar sua operação no WhatsApp.
        </p>

        <FormularioDeLogin voltar={destino} />

        <div className="login-rodape">
          <span>Acesso exclusivo para assinantes e contas autorizadas.</span>
        </div>
      </div>
    </main>
  );
}
