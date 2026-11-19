import {beforeEach,describe,test,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({session:null as unknown,rpc:vi.fn(),generate:vi.fn(),revalidate:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mock.revalidate}));
vi.mock('@/lib/sessao',()=>({obterSessao:async()=>mock.session}));
vi.mock('@/lib/supabase/servidor',()=>({criarClienteServidor:async()=>({rpc:mock.rpc})}));
vi.mock('@/lib/ia/cofre',()=>({lerChaveDoCofre:()=> 'cofre-falso',contextoDaChaveDeIa:()=> 'contexto',decifrar:()=> 'chave-ficticia'}));
vi.mock('@/lib/ia/provedores',()=>({gerarResposta:mock.generate,ErroDeIa:class extends Error{motivo='limite'}}));
import {carregarChatDoTreinamento,enviarMensagemAoEditor,mudarPropostaDoEditor} from '@/app/(painel)/treinamento/acoes-do-chat';
const id='11111111-1111-4111-8111-111111111111';const thread='22222222-2222-4222-8222-222222222222';
const input={baseId:id,conversaId:null,pedidoId:id,provedor:'gemini' as const,texto:'Ajuste as regras'};
beforeEach(()=>{vi.clearAllMocks();mock.session={workspaceAtivo:{id,papel:'owner'}};mock.rpc.mockImplementation(async(name:string)=>{
 if(name==='read_my_ai_key_ciphertext')return {data:'cifra-falsa',error:null};
 if(name==='read_my_ai_settings')return {data:{},error:null};
 if(name==='begin_my_training_ai_turn')return {data:{thread_id:thread,history:[],context:{agent:{resource:'treinamento',id,label:'Loja',version:1,data:{golden_rules:'Antes'}},catalog:[],voices:[]}},error:null};
 if(name==='read_my_training_ai_chat')return {data:{threads:[],turns:[]},error:null};
 return {data:null,error:null};
 });mock.generate.mockResolvedValue({texto:JSON.stringify({resposta:'Revise a proposta',alteracoes:[{resource:'treinamento',id,field:'golden_rules',value:'Depois'}]})});});
describe('ações servidor do editor: dependências simuladas',()=>{
 test.each([null,{workspaceAtivo:{id,papel:'member'}}])('sem proprietário não acessa banco nem provedor',async session=>{mock.session=session;expect((await enviarMensagemAoEditor(input)).ok).toBe(false);expect((await carregarChatDoTreinamento(id,null)).ok).toBe(false);expect((await mudarPropostaDoEditor(id,'apply')).ok).toBe(false);expect(mock.rpc).not.toHaveBeenCalled();expect(mock.generate).not.toHaveBeenCalled();});
 test('entrada inválida recusada antes de chamar serviços',async()=>{expect((await enviarMensagemAoEditor({...input,texto:' '})).ok).toBe(false);expect((await enviarMensagemAoEditor({...input,pedidoId:'sql'})).ok).toBe(false);expect((await enviarMensagemAoEditor({...input,referencia:{nome:'x',texto:'x'.repeat(64001)}})).ok).toBe(false);expect(mock.generate).not.toHaveBeenCalled();expect(mock.rpc).not.toHaveBeenCalled();});
 test('gera proposta usando só o provedor selecionado e sem aplicar',async()=>{const r=await enviarMensagemAoEditor(input);expect(r).toEqual({ok:true,dados:{conversaId:thread}});expect(mock.generate).toHaveBeenCalledOnce();expect(mock.generate.mock.calls[0]![0]).toMatchObject({provedor:'gemini',chave:'chave-ficticia'});expect(mock.rpc.mock.calls.some(c=>c[0]==='transition_my_training_ai_proposal')).toBe(false);const call=mock.rpc.mock.calls.find(c=>c[0]==='finish_my_training_ai_turn');expect(call?.[1].p_changes).toEqual([{resource:'treinamento',id,field:'golden_rules',value:'Depois'}]);expect(JSON.stringify(r)).not.toContain('chave-ficticia');});
 test('erro não provoca fallback e remove a chave da mensagem',async()=>{mock.generate.mockRejectedValue(new Error('Erro chave-ficticia'));const r=await enviarMensagemAoEditor(input);expect(r.ok).toBe(false);expect(JSON.stringify(r)).not.toContain('chave-ficticia');expect(mock.generate).toHaveBeenCalledOnce();expect(mock.rpc.mock.calls.find(c=>c[0]==='finish_my_training_ai_turn')?.[1].p_error).toContain('[chave protegida]');});
 test('proposta malformada não chega à aprovação',async()=>{mock.generate.mockResolvedValue({texto:'SQL: delete from users'});expect((await enviarMensagemAoEditor(input)).ok).toBe(false);expect(mock.rpc.mock.calls.find(c=>c[0]==='finish_my_training_ai_turn')?.[1].p_changes).toEqual([]);});
 test('retorno de conflito é explicado sem invalidar conteúdo manual',async()=>{mock.rpc.mockResolvedValue({error:{message:'editor_conflict'}});const r=await mudarPropostaDoEditor(id,'apply');expect(r.ok).toBe(false);if(!r.ok)expect(r.erro).toContain('Nada foi sobrescrito');expect(mock.revalidate).not.toHaveBeenCalled();});
 test('aprovação invalida as telas relevantes, nunca a configuração do WhatsApp',async()=>{expect((await mudarPropostaDoEditor(id,'apply')).ok).toBe(true);expect(mock.rpc).toHaveBeenCalledWith('transition_my_training_ai_proposal',{p_workspace_id:id,p_turn_id:id,p_action:'apply'});expect(mock.revalidate.mock.calls.map(c=>c[0])).toEqual(['/treinamento','/catalogo','/audios','/simulador']);});
});

describe('recuperação limitada do protocolo',()=>{
 test('refaz uma resposta malformada uma única vez no mesmo provedor e valida de novo',async()=>{mock.generate.mockResolvedValueOnce({texto:'Oi! Como posso ajudar?'}).mockResolvedValueOnce({texto:JSON.stringify({resposta:'Olá! O que deseja melhorar?',alteracoes:[]})});const r=await enviarMensagemAoEditor({...input,texto:'Ola'});expect(r.ok).toBe(true);expect(mock.generate).toHaveBeenCalledTimes(2);for(const [p] of mock.generate.mock.calls)expect(p).toMatchObject({provedor:'gemini',formatoJson:true});expect(mock.rpc.mock.calls.find(c=>c[0]==='finish_my_training_ai_turn')?.[1].p_changes).toEqual([]);});
 test('não tenta corrigir campos proibidos nem chama provedor alternativo',async()=>{mock.generate.mockResolvedValue({texto:JSON.stringify({resposta:'Mudança',alteracoes:[{resource:'treinamento',id,field:'api_key',value:'segredo'}]})});expect((await enviarMensagemAoEditor(input)).ok).toBe(false);expect(mock.generate).toHaveBeenCalledOnce();});
});
