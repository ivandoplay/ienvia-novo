import {beforeAll,describe,test,expect} from 'vitest';import {randomUUID} from 'node:crypto';
import {bancoComCenario,DONA_A,LOJA_A,LOJA_B,CHIP_A,CHIP_B} from './helpers/cenario';import type {BancoDeTeste} from './helpers/banco';
let banco:BancoDeTeste;beforeAll(async()=>{banco=await bancoComCenario();});
async function rpc<T=Record<string,unknown>>(name:string,args:unknown[]=[]){const q=args.map((_,i)=>'$'+(i+1)).join(',');return(await banco.db.query<{r:T}>(`select public.${name}(${q}) r`,args)).rows[0]!.r;}
async function fixture(workspace=LOJA_A,token='a'.repeat(64)){
 const executor=randomUUID(),instance=randomUUID();await banco.db.exec('reset role');
 await banco.db.query("update public.workspaces set max_instances=20 where id=$1",[workspace]);
 await banco.db.query("insert into public.workspace_ai_settings(workspace_id,admin_alert_enabled,admin_alert_whatsapp) values($1,true,'5586981638438') on conflict(workspace_id) do update set admin_alert_enabled=true,admin_alert_whatsapp='5586981638438'",[workspace]);
 await banco.db.query("insert into public.local_executors(id,workspace_id,display_name,status,last_seen_at) values($1,$2,'Fixture','active',clock_timestamp())",[executor,workspace]);
 await banco.db.query('insert into private.local_executor_tokens(executor_id,workspace_id,token_sha256) values($1,$2,$3)',[executor,workspace,token]);
 await banco.db.query("insert into public.instances(id,workspace_id,channel,engine,display_name,status,local_executor_id) values($1,$2,'whatsapp','baileys','Local','connected',$3)",[instance,workspace,executor]);
 await banco.db.query("update public.instances set status='connected',provider_instance_name='evo-'||id::text where id=$1",[workspace===LOJA_A?CHIP_A:CHIP_B]);return {executor,instance,token,workspace};
}
async function enqueue(f:Awaited<ReturnType<typeof fixture>>){return rpc<{result:string;delivery_id:string;command_id:string}>('enqueue_workspace_admin_alert',[f.workspace,'test','Dossiê de teste',f.instance,null,null]);}
async function sent(command:string,id='wa-test'){await banco.db.query("update public.local_motor_commands set status='succeeded',provider_message_id=$2 where id=$1",[command,id]);await banco.db.query("update private.admin_alert_deliveries set status='sent',provider_message_id=$2 where id=(select (payload->>'admin_alert_delivery_id')::uuid from public.local_motor_commands where id=$1)",[command,id]);}
describe('dossiê local: roteamento e confirmações para qualquer workspace',()=>{
 test('contas A e B mantêm dossiê no próprio local; não redireciona para Evolution conectado',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  for(const [ws,tok]of [[LOJA_A,'a'.repeat(64)],[LOJA_B,'b'.repeat(64)]]){const f=await fixture(ws,tok);const r=await enqueue(f);expect(r.result).toBe('queued_local');
  const cmd=(await banco.db.query<{instance_id:string;executor_id:string;workspace_id:string}>('select instance_id,executor_id,workspace_id from public.local_motor_commands where id=$1',[r.command_id])).rows[0]!;expect(cmd).toEqual({instance_id:f.instance,executor_id:f.executor,workspace_id:ws});}
 });});
 test('se o local preferido fica offline não usa Evolution em silêncio',async()=>{await banco.comoUsuario(DONA_A,async()=>{const f=await fixture();await banco.db.query("update public.instances set status='disconnected' where id=$1",[f.instance]);expect((await enqueue(f)).result).toBe('no_connected_chip');});});
 test('dossiê sem message_id recebe entrega e leitura sem regredir ou reenviar',async()=>{await banco.comoUsuario(DONA_A,async()=>{const f=await fixture(),r=await enqueue(f);await sent(r.command_id);
  for(const status of [4,3,0,4]){const receipt=await rpc<{result:string;confirmed:string[]}>('apply_local_motor_receipts',[f.token,f.instance,[{id:'wa-test',status}]]);expect(receipt.confirmed).toEqual(['wa-test']);}
  const d=(await banco.db.query<{status:string;delivered_at:unknown;read_at:unknown}>('select status,delivered_at,read_at from private.admin_alert_deliveries where id=$1',[r.delivery_id])).rows[0]!;expect(d.status).toBe('sent');expect(d.delivered_at).toBeTruthy();expect(d.read_at).toBeTruthy();
  expect((await banco.db.query('select id from public.local_motor_commands where instance_id=$1',[f.instance])).rows).toHaveLength(1);
 });});
 test('recibo antes da conclusão fica pendente; token de outro aparelho/empresa é recusado',async()=>{await banco.comoUsuario(DONA_A,async()=>{const a=await fixture(),b=await fixture(LOJA_B,'b'.repeat(64)),r=await enqueue(a);const receipts=[{id:'wa-test',status:3}];
  expect((await rpc('apply_local_motor_receipts',[a.token,a.instance,receipts])).pending).toBe(1);
  expect((await rpc('apply_local_motor_receipts',[b.token,a.instance,receipts])).result).toBe('unauthorized');
  await sent(r.command_id);expect((await rpc<{confirmed:string[]}>('apply_local_motor_receipts',[a.token,a.instance,receipts])).confirmed).toEqual(['wa-test']);
 });});
 test('a RPC de recibos não é pública para o dono nem visitante',async()=>{await banco.comoUsuario(DONA_A,async()=>{expect(await banco.esperarErro(()=>rpc('apply_local_motor_receipts',['a'.repeat(64),randomUUID(),[]]))).toContain('permission denied');});});
});
