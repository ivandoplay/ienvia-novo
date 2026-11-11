import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Icone } from '@/components/ui/icone';
import { nomeDaFase } from '@/lib/fases';
import { buscarItemPorRota } from '@/lib/navegacao';
import { obterSessao } from '@/lib/sessao';

/**
 * Abas do menu que ainda não foram reconstruídas caem aqui.
 * Quando uma aba ganha a sua pasta própria (ex.: app/(painel)/inbox), ela passa a
 * valer no lugar desta página automaticamente.
 */
export async function generateMetadata({ params }: PageProps<'/[aba]'>): Promise<Metadata> {
  const { aba } = await params;
  return { title: buscarItemPorRota(`/${aba}`)?.rotulo ?? 'Página não encontrada' };
}

export default async function PaginaEmConstrucao({ params }: PageProps<'/[aba]'>) {
  const { aba } = await params;
  const item = buscarItemPorRota(`/${aba}`);
  if (!item) notFound();

  if (item.somenteMaster) {
    const sessao = await obterSessao();
    if (!sessao?.ehMaster) notFound();
  }

  return (
    <div className="apoio">
      <div className="page-header">
        <div>
          <h1>{item.rotulo}</h1>
          <p>{item.descricao}</p>
        </div>
      </div>

      <div className="panel">
        <span className="apoio-fase">
          <Icone nome="ferramentas" className="icon-15" />
          Em reconstrução · Fase {item.fase} — {nomeDaFase(item.fase)}
        </span>
        <p className="apoio-texto">
          Esta aba existe no sistema antigo e está sendo refeita do zero. Ela ainda não funciona aqui: nada do que
          aparece nesta tela envia mensagens ou altera dados.
        </p>
        <p className="apoio-texto">
          As abas são entregues em ordem, uma fase por vez, e cada uma só entra no ar depois de testada.
        </p>
        <div className="apoio-acoes">
          <Link href="/visao-geral" className="btn btn-secondary">
            Voltar para a Visão geral
          </Link>
        </div>
      </div>
    </div>
  );
}
