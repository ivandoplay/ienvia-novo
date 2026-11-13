import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { MolduraDoPainel } from '@/components/casca/moldura-do-painel';
import { ConfiguracaoPendente } from '@/components/configuracao-pendente';
import { lerConfigSupabase } from '@/lib/env';
import { obterSessao } from '@/lib/sessao';

/** Área exclusiva do administrador da plataforma (não exige workspace ativo). */
export default async function LayoutDaPlataforma({ children }: { children: ReactNode }) {
  if (!lerConfigSupabase()) return <ConfiguracaoPendente />;

  const sessao = await obterSessao();
  if (!sessao) redirect('/login');
  if (!sessao.ehMaster) notFound();

  return <MolduraDoPainel sessao={sessao}>{children}</MolduraDoPainel>;
}
