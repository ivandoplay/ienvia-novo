import {beforeEach,describe,expect,test,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),after:vi.fn(),atender:vi.fn(),sobras:vi.fn()}));
vi.mock('next/server',async importOriginal=>({...await importOriginal<typeof import('next/server')>(),after:m.after}));
vi.mock('@/lib/supabase/servico',()=>({criarClienteDeServico:()=>({rpc:m.rpc})}));
vi.mock('@/lib/atendente/atendente',()=>({atenderVez:m.atender,atenderSobras:m.sobras,orcamentoDoAtendente:()=>50000}));
import {POST} from '@/app/api/motor/eventos/route';
const body={instance_id:'test-chip',event_id:'test-wa',sender_jid:'5586000000000@s.whatsapp.net',body_text:'teste'};
function req(historical:boolean){return new Request('https://example.invalid/api/motor/eventos',{method:'POST',headers:{'content-type':'application/json','x-ienvia-motor-token':'a'.repeat(64)},body:JSON.stringify({...body,historical})});}
beforeEach(()=>{vi.clearAllMocks();m.rpc.mockResolvedValue({data:{result:'accepted',workspace_id:'test-workspace',message_id:'test-message',ai:{scheduled:true,turn_id:'test-turn',wait_ms:0}},error:null});});
describe('importação de histórico não inicia IA',()=>{
 test('histórico usa RPC própria e nunca agenda IA mesmo com retorno imprevisto',async()=>{
  expect((await POST(req(true))).status).toBe(200);expect(m.rpc).toHaveBeenCalledWith('ingest_local_history_message',expect.anything());expect(m.after).not.toHaveBeenCalled();expect(m.atender).not.toHaveBeenCalled();
 });
 test('mensagem nova continua agendando atendimento enquanto outras são importadas',async()=>{
  await POST(req(true));await POST(req(false));expect(m.after).toHaveBeenCalledTimes(1);expect(m.rpc).toHaveBeenLastCalledWith('ingest_local_message',expect.anything());
  await m.after.mock.calls[0]![0]();expect(m.atender).toHaveBeenCalledTimes(1);expect(m.sobras).toHaveBeenCalledTimes(1);
 });
});
