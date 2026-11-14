import { NextResponse } from 'next/server';
import { usuarioParaEmail } from '@ienvia/shared';
import { dominioDeUsuario, lerConfigSupabase } from '@/lib/env';
import { criarClienteDeServico } from '@/lib/supabase/servico';
import { sha256Hex } from '@/lib/motor/autenticacao';

export const runtime = 'nodejs';

/**
 * Pareamento do Motor local com e-mail + senha da conta Ienvia.
 *
 * A pessoa digita na página inicial do motor o e-mail (ou usuário) e a senha que já usa no painel.
 * O motor manda isso aqui; esta rota:
 *   1) confere e-mail/senha no Supabase Auth (mesmo caminho do /login);
 *   2) lista as contas em que a pessoa é dona (se tiver mais de uma, devolve a lista e pede para escolher);
 *   3) cria o aparelho e devolve um `device_token` próprio do aparelho.
 *
 * Nada de senha é guardada: o token que o motor recebe é aleatório e só o hash dele fica no banco.
 */

const SENHA_MAXIMA = 200;

interface Corpo {
  email?: string;
  senha?: string;
  workspaceId?: string;
  aparelho?: string;
}

export async function POST(req: Request) {
  let corpo: Corpo = {};
  try {
    corpo = (await req.json()) as Corpo;
  } catch {
    return NextResponse.json({ erro: 'Corpo JSON inválido.' }, { status: 400 });
  }

  if (!lerConfigSupabase()) {
    return NextResponse.json({ erro: 'O painel ainda não foi ligado ao banco de dados. Avise o suporte.' }, { status: 503 });
  }

  const email = usuarioParaEmail(String(corpo.email ?? '').trim(), dominioDeUsuario());
  const senha = String(corpo.senha ?? '');
  if (!email || !senha) {
    return NextResponse.json({ erro: 'Informe o e-mail (ou usuário) e a senha da sua conta.' }, { status: 400 });
  }
  if (senha.length > SENHA_MAXIMA) {
    return NextResponse.json({ erro: 'E-mail ou senha incorretos.' }, { status: 401 });
  }

  const config = lerConfigSupabase();
  if (!config) {
    return NextResponse.json({ erro: 'Painel sem configuração do banco.' }, { status: 503 });
  }
  const url = config.url.replace(/\/+$/, '');
  const chave = config.chavePublica;

  // 1) Confere a senha num cliente isolado (não mexe nos cookies de quem estiver logado no navegador).
  const resp = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: chave, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: senha }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!resp) {
    return NextResponse.json({ erro: 'Não foi possível falar com o banco agora. Tente de novo.' }, { status: 503 });
  }
  if (resp.status === 429) {
    return NextResponse.json({ erro: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.' }, { status: 429 });
  }
  if (!resp.ok) {
    // Mesma mensagem para e-mail inexistente e senha errada: não revelar quais contas existem.
    return NextResponse.json({ erro: 'E-mail ou senha incorretos.' }, { status: 401 });
  }

  const sessao = (await resp.json().catch(() => null)) as { access_token?: string } | null;
  const accessToken = sessao?.access_token;
  if (!accessToken) {
    return NextResponse.json({ erro: 'Não foi possível entrar agora. Tente de novo em instantes.' }, { status: 502 });
  }

  const cabecalhos = { apikey: chave, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };

  // 2) Quais contas esta pessoa administra?
  const listaResp = await fetch(`${url}/rest/v1/rpc/list_my_owner_workspaces`, {
    method: 'POST',
    headers: cabecalhos,
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  const contas = listaResp && listaResp.ok ? ((await listaResp.json().catch(() => null)) as { id: string; name: string }[] | null) : null;
  if (!contas) {
    return NextResponse.json({ erro: 'Não foi possível ler suas contas agora. Tente de novo.' }, { status: 502 });
  }
  if (contas.length === 0) {
    return NextResponse.json(
      { erro: 'Sua conta não administra nenhuma empresa ativa no Ienvia. Fale com o suporte.' },
      { status: 403 },
    );
  }

  let workspaceId = String(corpo.workspaceId ?? '').trim();
  if (!workspaceId) {
    if (contas.length > 1) {
      return NextResponse.json({ precisaEscolherConta: true, contas }, { status: 200 });
    }
    workspaceId = contas[0]!.id;
  }
  if (!contas.some((c) => c.id === workspaceId)) {
    return NextResponse.json({ erro: 'Você não administra essa conta.' }, { status: 403 });
  }

  // 3) Cria o aparelho já ativo e devolve o token dele.
  const deviceToken = gerarTokenDoAparelho();
  const supabase = criarClienteDeServico();
  if (!supabase) {
    return NextResponse.json({ erro: 'Painel sem configuração de serviço.' }, { status: 503 });
  }

  const { data, error } = await supabase.rpc('pair_local_executor_by_password', {
    p_workspace_id: workspaceId,
    p_display_name: String(corpo.aparelho ?? '').trim().slice(0, 80) || 'Meu aparelho',
    p_token_sha256: sha256Hex(deviceToken),
  });

  if (error) {
    console.error('[motor/parear-senha] falha no banco:', error);
    const mensagem = error.message?.includes('Too many local executors')
      ? 'Muitos aparelhos criados hoje. Tente novamente amanhã ou revogue aparelhos antigos no painel.'
      : 'Não foi possível ligar este aparelho agora.';
    return NextResponse.json({ erro: mensagem }, { status: 500 });
  }

  const res = data as { result?: string; executor_id?: string; display_name?: string } | null;
  if (!res || res.result !== 'paired' || !res.executor_id) {
    return NextResponse.json({ erro: 'Não foi possível ligar este aparelho agora.' }, { status: 500 });
  }

  return NextResponse.json({
    executor_id: res.executor_id,
    workspace_id: workspaceId,
    display_name: res.display_name ?? 'Meu aparelho',
    device_token: deviceToken,
  });
}

function gerarTokenDoAparelho(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
