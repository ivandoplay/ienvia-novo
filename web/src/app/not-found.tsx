import Link from 'next/link';

export default function PaginaNaoEncontrada() {
  return (
    <main className="apoio-tela-cheia">
      <div className="panel">
        <h1>Página não encontrada</h1>
        <p className="apoio-texto">O endereço que você abriu não existe no painel.</p>
        <div className="apoio-acoes">
          <Link href="/visao-geral" className="btn btn-primary">
            Ir para a Visão geral
          </Link>
        </div>
      </div>
    </main>
  );
}
