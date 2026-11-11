'use server';

import { redirect } from 'next/navigation';
import { usuarioParaEmail } from '@ienvia/shared';
import { dominioDeUsuario, lerConfigSupabase } from '@/lib/env';
import { destinoSeguro } from '@/lib/redirecionamento';
import { criarClienteServidor } from '@/lib/supabase/servidor';

export interface EstadoDoLogin {
  /** Mensagem de erro para mostrar no formulário. */
  erro?: string;
  /** O usuário digitado, devolvido para a pessoa não precisar digitar de novo. */
  usuario?: string;
}

const SENHA_MAXIMA = 200;

/** Ação do formulário de login. Em caso de sucesso redireciona; em caso de erro devolve a mensagem. */
export async function entrar(_estadoAnterior: EstadoDoLogin, dados: FormData): Promise<EstadoDoLogin> {
  const usuario = String(dados.get('usuario') ?? '').trim();
  const senha = String(dados.get('senha') ?? '');

  if (!lerConfigSupabase()) {
    return { usuario, erro: 'O painel ainda não foi ligado ao banco de dados. Avise o suporte.' };
  }

  const email = usuarioParaEmail(usuario, dominioDeUsuario());
  if (!email || !senha) {
    return { usuario, erro: 'Informe seu usuário e sua senha.' };
  }
  if (senha.length > SENHA_MAXIMA) {
    return { usuario, erro: 'Usuário ou senha incorretos.' };
  }

  const supabase = await criarClienteServidor();
  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });

  if (error) {
    return { usuario, erro: mensagemDeErro(error.status, error.code) };
  }

  // redirect() interrompe a função; por isso fica fora de qualquer try/catch.
  redirect(destinoSeguro(dados.get('voltar')));
}

/** A mesma mensagem para "usuário não existe" e "senha errada": não revelar quais contas existem. */
function mensagemDeErro(status: number | undefined, codigo: string | undefined): string {
  if (status === 429 || codigo === 'over_request_rate_limit') {
    return 'Muitas tentativas seguidas. Espere um minuto e tente de novo.';
  }
  if (status === 400 || status === 401 || status === 403 || status === 422) {
    return 'Usuário ou senha incorretos.';
  }
  return 'Não foi possível entrar agora. Tente de novo em instantes.';
}
