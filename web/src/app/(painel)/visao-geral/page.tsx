import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icone, type NomeIcone } from '@/components/ui/icone';
import { carregarVisaoGeral, ETAPAS_DO_FUNIL } from '@/lib/dados/visao-geral';
import { plural } from '@/lib/formato';
import { obterSessao } from '@/lib/sessao';
import { Saudacao } from './saudacao';

export const metadata: Metadata = {
  title: 'Visão geral',
};

interface Indicador {
  rota: string;
  dica: string;
  icone: NomeIcone;
  cor: 'atencao' | 'ia' | 'campanha' | 'conexao' | 'mensagem' | 'contato';
  valor: string;
  /** Texto (em vez de número) usa uma letra menor. */
  valorEhTexto?: boolean;
  rotulo: string;
  rodape: string;
}

/** Número para a tela; `null` (consulta falhou) vira um traço em vez de um valor inventado. */
function numero(valor: number | null): string {
  return valor === null ? '—' : valor.toLocaleString('pt-BR');
}

export default async function PaginaVisaoGeral() {
  const sessao = await obterSessao();
  // O layout do painel já garante sessão e workspace; isto é só para o TypeScript.
  if (!sessao?.workspaceAtivo) return null;

  const dados = await carregarVisaoGeral(sessao.workspaceAtivo.id);
  const instancias = dados.instancias;

  const indicadores: Indicador[] = [
    {
      rota: '/inbox',
      dica: 'Conversas que a IA passou para você e estão paradas',
      icone: 'kpiAtencao',
      cor: 'atencao',
      valor: numero(dados.esperandoVoce),
      rotulo: 'Esperando você',
      rodape: 'conversas paradas · abrir',
    },
    {
      rota: '/instancias',
      dica: 'Chips conectados com a resposta automática ligada',
      icone: 'kpiIa',
      cor: 'ia',
      valor: instancias === null ? '—' : instancias.comIaLigada > 0 ? 'Ligada' : 'Desligada',
      valorEhTexto: true,
      rotulo: 'IA respondendo',
      rodape:
        instancias === null
          ? 'sem informação'
          : instancias.comIaLigada > 0
            ? `em ${plural(instancias.comIaLigada, 'chip', 'chips')}`
            : 'atendimento automático',
    },
    {
      rota: '/campanhas',
      dica: 'Campanhas disparando agora',
      icone: 'kpiCampanha',
      cor: 'campanha',
      valor: numero(dados.campanhasAtivas),
      rotulo: 'Campanhas ativas',
      rodape: dados.campanhasAtivas ? 'em andamento' : 'nenhuma rodando',
    },
    {
      rota: '/instancias',
      dica: 'Chips conectados — abrir o gerenciamento de instâncias',
      icone: 'instancias',
      cor: 'conexao',
      valor: numero(instancias?.conectadas ?? null),
      rotulo: 'Chips online',
      rodape: instancias === null ? 'sem informação' : `de ${plural(instancias.total, 'cadastrado', 'cadastrados')}`,
    },
    {
      rota: '/inbox',
      dica: 'Mensagens recebidas hoje',
      icone: 'kpiMensagem',
      cor: 'mensagem',
      valor: numero(dados.mensagensRecebidasHoje),
      rotulo: 'Mensagens recebidas',
      rodape:
        dados.respostasDaIaHoje === null
          ? 'hoje'
          : `hoje · ${plural(dados.respostasDaIaHoje, 'resposta da IA', 'respostas da IA')}`,
    },
    {
      rota: '/inbox',
      dica: 'Contatos guardados neste workspace',
      icone: 'contatos',
      cor: 'contato',
      valor: numero(dados.contatos),
      rotulo: 'Contatos',
      rodape: 'no seu CRM',
    },
  ];

  const funil = ETAPAS_DO_FUNIL.map((etapa, indice) => ({ ...etapa, quantidade: dados.funil[indice] ?? null }));
  const maiorEtapa = Math.max(1, ...funil.map((etapa) => etapa.quantidade ?? 0));
  const funilTemDados = funil.some((etapa) => (etapa.quantidade ?? 0) > 0);
  const funilFalhou = funil.every((etapa) => etapa.quantidade === null);

  return (
    <>
      <div className="visao-topo">
        <div className="visao-ola">
          <Saudacao />
          <p className="visao-ola-sub">Tudo o que está acontecendo nas suas abas, num lugar só.</p>
        </div>
        <div className="visao-acoes">
          <Link href="/instancias" className="btn btn-secondary">
            <Icone nome="instancias" className="icon-15" />
            <span>Conectar um chip</span>
          </Link>
          <Link href="/simulador" className="btn btn-secondary">
            Testar no Simulador
          </Link>
          <Link href="/treinamento" className="btn btn-primary">
            Editar Treinamento
          </Link>
        </div>
      </div>

      <div className="visao-kpis">
        {indicadores.map((indicador) => (
          <Link
            key={indicador.rotulo}
            href={indicador.rota}
            className="visao-kpi"
            title={indicador.dica}
          >
            <span className="visao-kpi-topo">
              <span className={`visao-kpi-icone ${indicador.cor}`}>
                <Icone nome={indicador.icone} className="icon-15" />
              </span>
            </span>
            <span className={indicador.valorEhTexto ? 'visao-kpi-num visao-kpi-num--texto' : 'visao-kpi-num'}>
              {indicador.valor}
            </span>
            <span className="visao-kpi-rotulo">{indicador.rotulo}</span>
            <span className="visao-kpi-pe">{indicador.rodape}</span>
          </Link>
        ))}
      </div>

      <div className="visao-grade">
        <section className="panel" aria-labelledby="titulo-funil">
          <div className="panel-header">
            <div>
              <h2 id="titulo-funil" className="panel-title">
                Funil de conversão
              </h2>
              <p className="panel-desc">Onde estão suas conversas agora.</p>
            </div>
            <Link href="/inbox" className="btn btn-secondary btn-sm">
              Ver conversas
            </Link>
          </div>

          {funilFalhou ? (
            <p className="visao-vazio">Não foi possível carregar o funil agora. Atualize a página em instantes.</p>
          ) : funilTemDados ? (
            <ul className="funil">
              {funil.map((etapa) => (
                <li key={etapa.etapa} className="funil-linha">
                  <span className="funil-rotulo">{etapa.rotulo}</span>
                  <span className="funil-trilho" aria-hidden="true">
                    {etapa.quantidade ? (
                      <span className="funil-barra" style={{ width: `${(etapa.quantidade / maiorEtapa) * 100}%` }} />
                    ) : null}
                  </span>
                  <span className="funil-numero">{numero(etapa.quantidade)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="visao-vazio">
              Sem conversas no funil ainda — o gráfico aparece assim que a primeira conversa entrar.
            </p>
          )}
        </section>

        <section className="panel" aria-labelledby="titulo-passos">
          <div className="panel-header">
            <div>
              <h2 id="titulo-passos" className="panel-title">
                Para começar a atender
              </h2>
              <p className="panel-desc">Os três passos até a primeira resposta automática.</p>
            </div>
          </div>
          <ol className="lista-passos">
            <Passo numero={1} feito={(instancias?.conectadas ?? 0) > 0}>
              <strong>Conecte um chip</strong> em Instâncias, por QR Code ou código.
            </Passo>
            {/* O passo 2 passa a ser marcado de verdade na Fase 2, quando o Treinamento existir. */}
            <Passo numero={2} feito={false}>
              <strong>Treine o atendente</strong> com as informações do seu negócio.
            </Passo>
            <Passo numero={3} feito={(instancias?.comIaLigada ?? 0) > 0}>
              <strong>Ligue a IA</strong> no chip quando estiver satisfeito com as respostas.
            </Passo>
          </ol>
        </section>
      </div>
    </>
  );
}

function Passo({ numero: ordem, feito, children }: { numero: number; feito: boolean; children: ReactNode }) {
  return (
    <li>
      <span className={feito ? 'passo-marca feito' : 'passo-marca'} aria-hidden="true">
        {feito ? '✓' : ordem}
      </span>
      <span>
        {children}
        {feito ? <span className="so-leitor-de-tela"> (concluído)</span> : null}
      </span>
    </li>
  );
}
