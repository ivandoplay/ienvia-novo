/**
 * Mostrada quando o painel sobe sem as variáveis do Supabase.
 * É uma tela para quem está instalando, não para o cliente final.
 */
export function ConfiguracaoPendente() {
  return (
    <main className="apoio-tela-cheia">
      <div className="panel">
        <h1>Falta ligar o painel ao banco de dados</h1>
        <p className="apoio-texto">
          O painel está no ar, mas ainda não sabe em qual projeto do Supabase deve entrar. Defina estas duas
          variáveis de ambiente e reinicie:
        </p>
        <ul className="apoio-lista">
          <li>
            <code>NEXT_PUBLIC_SUPABASE_URL</code>
          </li>
          <li>
            <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>
          </li>
        </ul>
        <p className="apoio-texto">
          O modelo com a explicação de cada uma está em <code>web/.env.example</code>.
        </p>
      </div>
    </main>
  );
}
