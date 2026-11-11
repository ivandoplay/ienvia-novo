import { redirect } from 'next/navigation';

/**
 * A raiz do site ainda não tem conteúdo próprio (a vitrine entra numa fase posterior).
 * Quem chega aqui vai para o painel; o proxy manda para o login quem não está logado.
 */
export default function PaginaRaiz() {
  redirect('/visao-geral');
}
