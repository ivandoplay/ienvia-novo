/**
 * Semeia o workspace de TESTE com conversas realistas (contatos, conversas, mensagens),
 * para que as telas tenham conteúdo. Nada é escrito no workspace de produção.
 *
 * Rodar: node auditoria/semear-conversas.mjs
 * Limpar: node auditoria/semear-conversas.mjs --limpar
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('/home/user/.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const URL_BASE = env.SUPABASE_URL;
const CHAVE = env.SUPABASE_SERVICE_ROLE_KEY;
const WORKSPACE = env.TESTE_WORKSPACE;

const cabecalhos = {
  apikey: CHAVE,
  authorization: `Bearer ${CHAVE}`,
  'content-type': 'application/json',
  prefer: 'return=representation',
};

async function inserir(tabela, linhas) {
  const r = await fetch(`${URL_BASE}/rest/v1/${tabela}`, {
    method: 'POST',
    headers: cabecalhos,
    body: JSON.stringify(linhas),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${tabela}: ${r.status} ${texto.slice(0, 300)}`);
  return JSON.parse(texto);
}

const limpar = process.argv.includes('--limpar');

// instância do workspace de teste (se não existir, cria uma de mentira porque conversas apontam para ela)
const r = await fetch(`${URL_BASE}/rest/v1/instances?select=id,display_name&workspace_id=eq.${WORKSPACE}&limit=1`, { headers: cabecalhos });
const instancias = await r.json();

if (limpar) {
  console.log('apagando dados de teste deste workspace…');
  for (const tabela of ['messages', 'conversations', 'contacts']) {
    const resp = await fetch(`${URL_BASE}/rest/v1/${tabela}?workspace_id=eq.${WORKSPACE}`, { method: 'DELETE', headers: cabecalhos });
    console.log(` ${tabela}: ${resp.status}`);
  }
  process.exit(0);
}

// O workspace de teste precisa de um chip: conversations.instance_id é obrigatório.
// Criamos um chip de mentira, só aqui, para as telas terem o que mostrar.
let INSTANCIA = instancias[0]?.id ?? null;
if (!INSTANCIA) {
  const [criada] = await inserir('instances', [{
    workspace_id: WORKSPACE,
    channel: 'whatsapp',
    engine: 'evolution',
    display_name: 'Chip de teste (auditoria)',
    provider_instance_name: 'auditoria-chip-teste',
    status: 'connected',
    is_enabled: false,
    connected_phone: '+5586999000000',
    purpose: 'attendance',
  }]);
  INSTANCIA = criada.id;
  console.log(` chip de teste criado: ${INSTANCIA}`);
}

const PESSOAS = [
  { nome: 'Maria Santos', fone: '5586999110001', empresa: 'Boutique da Maria', cidade: 'Parnaíba', conversa: [
      ['inbound', 'Oi, boa tarde! Vocês entregam no centro de Parnaíba?'],
      ['outbound', 'Boa tarde, Maria! Entregamos sim 😊 O prazo é de 1 a 2 dias úteis.'],
      ['inbound', 'Perfeito. E quanto custa a blusa da foto?'],
      ['outbound', 'A blusa que você viu está R$ 89,90. Tenho nas cores preta, branca e verde.'],
      ['inbound', 'Quero a preta. Como faço o pagamento?'],
      ['outbound', 'Posso mandar o PIX ou link de cartão. Qual prefere?'],
      ['inbound', 'PIX'],
    ], semLer: 2, etapa: 'waiting_customer' },
  { nome: 'João Pedro Lima', fone: '5586999110002', empresa: null, cidade: 'Piracuruca', conversa: [
      ['inbound', 'bom dia'],
      ['outbound', 'Bom dia, João! Em que posso ajudar?'],
      ['inbound', 'queria saber se tem o produto em estoque'],
      ['outbound', 'Temos sim! Qual produto você está procurando?'],
      ['inbound', 'aquele kit de presente'],
    ], semLer: 1, etapa: 'new' },
  { nome: 'Ana Clara Rocha', fone: '5586999110003', empresa: 'Studio Ana', cidade: 'Teresina', conversa: [
      ['inbound', 'Oi! Fiz o pedido ontem, já foi enviado?'],
      ['outbound', 'Oi, Ana! Seu pedido saiu hoje de manhã. O código de rastreio é BR123456789.'],
      ['inbound', 'Ótimo, obrigada!'],
      ['outbound', 'Qualquer coisa é só chamar 💚'],
    ], semLer: 0, etapa: 'resolved' },
  { nome: 'Carlos Eduardo', fone: '5586999110004', empresa: 'CE Distribuidora', cidade: 'Fortaleza', conversa: [
      ['inbound', 'Boa noite, preciso de 50 unidades para revenda'],
      ['outbound', 'Boa noite, Carlos! Para 50 unidades temos desconto de 15%. Fica R$ 2.550 no total.'],
      ['inbound', 'Consegue emitir nota?'],
      ['outbound', 'Emitimos sim, com CNPJ. Me passa os dados que já preparo o orçamento.'],
      ['inbound', 'vou mandar'],
    ], semLer: 3, etapa: 'waiting_customer' },
  { nome: 'Fernanda Alves', fone: '5586999110005', empresa: null, cidade: 'Piripiri', conversa: [
      ['inbound', 'Oi, tudo bem? Vi o anúncio de vocês no Instagram'],
      ['outbound', 'Oi, Fernanda! Tudo bem sim 😊 Que bom te ver por aqui. O que você gostaria de saber?'],
      ['inbound', 'Queria saber se tem alguma promoção essa semana'],
    ], semLer: 1, etapa: 'new' },
  { nome: 'Rafael Nunes', fone: '5586999110006', empresa: 'Nunes Auto Peças', cidade: 'Parnaíba', conversa: [
      ['outbound', 'Oi Rafael! Passando para avisar que chegou o lote novo.'],
      ['inbound', 'Boa! Me manda foto das opções'],
      ['outbound', 'Claro, já envio ainda hoje.'],
      ['inbound', 'fechado'],
    ], semLer: 0, etapa: 'resolved' },
  { nome: 'Beatriz Sousa', fone: '5586999110007', empresa: null, cidade: 'Luís Correia', conversa: [
      ['inbound', 'Bom dia, vocês abrem no domingo?'],
      ['outbound', 'Bom dia, Beatriz! Abrimos das 8h às 13h no domingo.'],
    ], semLer: 0, etapa: 'resolved' },
  { nome: 'Lucas Martins', fone: '5586999110008', empresa: 'LM Serviços', cidade: 'Parnaíba', conversa: [
      ['inbound', 'preciso falar com um humano'],
      ['outbound', 'Claro, Lucas. Já chamei alguém da equipe para te atender.'],
    ], semLer: 1, etapa: 'new', humano: true },
];

console.log(`semeando ${PESSOAS.length} conversas no workspace de teste…`);

const agora = Date.now();
// ---- segundo chip: um online, para medir a tela em estado "conectado" ----
if (!process.argv.includes('--limpar')) {
  const jaTem = await fetch(`${URL_BASE}/rest/v1/instances?select=id,display_name&workspace_id=eq.${WORKSPACE}`, { headers: cabecalhos });
  const instancias = await jaTem.json();
  if (!instancias.some((i) => i.display_name === 'Chip ativo (auditoria)')) {
    const criado = await inserir('instances', [{
      workspace_id: WORKSPACE,
      display_name: 'Chip ativo (auditoria)',
      channel: 'whatsapp',
      engine: 'evolution',
      logical_number_key: 'auditoria-ativo',
      status: 'connected',
      is_enabled: true,
    }]);
    console.log(`chip ativo de teste criado: ${criado[0]?.id}`);
  }
}

const linhasContato = PESSOAS.map((p, i) => ({
  workspace_id: WORKSPACE,
  instance_id: INSTANCIA,
  channel: 'whatsapp',
  external_user_id: `${p.fone}@s.whatsapp.net`,
  display_name: p.nome,
  phone_e164: `+${p.fone}`,
  company: p.empresa ?? '',
  document_id: '',
  city: p.cidade ?? '',
  lead_source: '',
  notes: '',
  consent_status: 'opted_in',
}));

const contatos = await inserir('contacts', linhasContato);
console.log(` ${contatos.length} contatos criados`);

const linhasConversa = contatos.map((c, i) => {
  const p = PESSOAS[i];
  const ultima = p.conversa[p.conversa.length - 1];
  const minutosAtras = (PESSOAS.length - i) * 37;
  return {
    workspace_id: WORKSPACE,
    contact_id: c.id,
    instance_id: INSTANCIA,
    stage: p.etapa,
    unread_count: p.semLer,
    last_message_at: new Date(agora - minutosAtras * 60_000).toISOString(),
    last_message_preview: ultima[1].slice(0, 120),
    automation_paused: Boolean(p.humano),
    ai_pause_reason: p.humano ? 'handoff' : null,
  };
});

const conversas = await inserir('conversations', linhasConversa);
console.log(` ${conversas.length} conversas criadas`);

const linhasMensagem = [];
conversas.forEach((conv, i) => {
  const p = PESSOAS[i];
  p.conversa.forEach(([direcao, texto], j) => {
    const minutos = (PESSOAS.length - i) * 37 + (p.conversa.length - j) * 3;
    linhasMensagem.push({
      workspace_id: WORKSPACE,
      conversation_id: conv.id,
      instance_id: INSTANCIA,
      direction: direcao,
      source_engine: 'evolution',
      actor_type: direcao === 'inbound' ? 'contact' : 'ai',
      status: direcao === 'inbound' ? 'received' : 'delivered',
      body_text: texto,
      occurred_at: new Date(agora - minutos * 60_000).toISOString(),
      provider_message_id: `semente-${i}-${j}-${randomUUID().slice(0, 8)}`,
      idempotency_key: `semente-${i}-${j}`,
    });
  });
});

const mensagens = await inserir('messages', linhasMensagem);
console.log(` ${mensagens.length} mensagens criadas`);
console.log('pronto.');

