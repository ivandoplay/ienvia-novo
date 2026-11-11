/** Mostrado enquanto a aba busca os dados no servidor (aparece só se demorar). */
export default function CarregandoAba() {
  return (
    <div className="carregando" role="status" aria-live="polite">
      <span className="so-leitor-de-tela">Carregando…</span>
      <div className="esqueleto esqueleto--titulo" />
      <div className="esqueleto esqueleto--linha" />
      <div className="esqueleto-grade">
        <div className="esqueleto esqueleto--cartao" />
        <div className="esqueleto esqueleto--cartao" />
        <div className="esqueleto esqueleto--cartao" />
      </div>
    </div>
  );
}
