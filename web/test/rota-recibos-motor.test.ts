import {beforeEach,describe,expect,test,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/servico',()=>({criarClienteDeServico:()=>({rpc:mocks.rpc})}));
import {POST} from '@/app/api/motor/recibos/route';
const token='a'.repeat(64),instance='11111111-1111-4111-8111-111111111111';
function request(body:unknown,authorized=true){return new Request('https://painel.test/api/motor/recibos',{method:'POST',headers:{'content-type':'application/json',...(authorized?{'x-ienvia-motor-token':token}:{})},body:JSON.stringify(body)});}
beforeEach(()=>mocks.rpc.mockReset());
describe('recibos do motor — API isolada',()=>{
 test('exige token e payload válido sem chamar banco',async()=>{
  expect((await POST(request({},false))).status).toBe(401);
  expect((await POST(request({instance_id:instance,receipts:[{id:'x',status:2}]}))).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
 });
 test('recibo do dossiê é confirmado mesmo sem message_id; autenticação fica na RPC',async()=>{
  mocks.rpc.mockResolvedValue({data:{result:'ok',confirmed:['wa-dossie'],pending:0},error:null});
  const result=await POST(request({instance_id:instance,receipts:[{id:'wa-dossie',status:4}]}));
  expect(result.status).toBe(200);expect((await result.json()).confirmed).toEqual(['wa-dossie']);
  expect(mocks.rpc).toHaveBeenCalledWith('apply_local_motor_receipts',expect.objectContaining({p_instance_id:instance,p_receipts:[{id:'wa-dossie',status:4}]}));
 });
 test('falha de banco não confirma; aparelho de outro workspace é rejeitado',async()=>{
  mocks.rpc.mockResolvedValueOnce({data:null,error:{message:'offline'}}).mockResolvedValueOnce({data:{result:'unauthorized'},error:null});
  const body={instance_id:instance,receipts:[{id:'wa',status:3}]};
  expect((await POST(request(body))).status).toBe(503);expect((await POST(request(body))).status).toBe(401);
 });
});
