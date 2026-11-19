import {beforeAll,afterAll,describe,test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bancoComCenario,DONA_A,ATENDENTE_A,DONO_B,LOJA_A,LOJA_B} from './helpers/cenario';
import type {BancoDeTeste} from './helpers/banco';
let banco:BancoDeTeste;
beforeAll(async()=>{banco=await bancoComCenario();});
afterAll(async()=>{});
async function rpc<T=Record<string,unknown>>(sql:string,params:unknown[]=[]){const r=await banco.db.query<{r:T}>(sql,params);return r.rows[0]!.r;}
async function fixture(){
 const a=await rpc<{id:string}>("select public.save_my_ai_agent($1,null,$2) r",[LOJA_A,{label:'Editor fixture',business_name:'Loja',golden_rules:'Regra original'}]);
 const c=randomUUID(),v=randomUUID();
 await banco.db.exec('reset role');
 await banco.db.query("insert into public.catalog_items(id,workspace_id,name,category,price) values($1,$2,'Biz','Moto','100')",[c,LOJA_A]);
 await banco.db.query("insert into public.voice_library_items(id,workspace_id,name,transcription,when_to_use,object_key,file_name,content_type,byte_size) values($1,$2,'Garantia','Garantia de três meses','Quando perguntar',$3,'audio.ogg','audio/ogg',10)",[v,LOJA_A,`${LOJA_A}/audios/${v}/audio.ogg`]);
 await banco.db.exec('set local role authenticated');
 return {a:a.id,c,v};
}
async function begin(a:string,thread:string|null=null,text='Ajuste as regras',id=randomUUID()){
 return rpc<{thread_id:string;context:{agent:{data:{golden_rules:string}}}}>('select public.begin_my_training_ai_turn($1,$2,$3,$4,$5,$6) r',[LOJA_A,a,thread,id,'gemini',text]).then(x=>({...x,id}));
}
async function finish(id:string,changes:unknown[]){return rpc('select public.finish_my_training_ai_turn($1,$2,$3,$4,null) r',[LOJA_A,id,'Preparei a proposta',changes]);}
async function transition(id:string,action:string){return rpc('select public.transition_my_training_ai_proposal($1,$2,$3) r',[LOJA_A,id,action]);}
const ch=(resource:string,id:string,field:string,value:unknown)=>({resource,id,field,value});
describe('editor assistido: permissão, proposta e transação',()=>{
 test('apenas dono lê ou inicia; tabelas privadas mesmo para membros',async()=>{
  await banco.comoUsuario(ATENDENTE_A,async()=>{expect(await banco.esperarErro(()=>rpc('select public.read_my_training_ai_chat($1,$2,null) r',[LOJA_A,randomUUID()]))).toContain('Workspace owner required');expect(await banco.esperarErro(()=>banco.db.query('select * from public.training_ai_turns'))).toContain('permission denied');});
 });
 test('isola bases de outra empresa',async()=>{await banco.comoUsuario(DONA_A,async()=>{expect(await banco.esperarErro(()=>begin(randomUUID()))).toContain('editor_target_not_found');expect(await banco.esperarErro(()=>rpc('select public.read_my_training_ai_chat($1,$2,null) r',[LOJA_B,randomUUID()]))).toContain('Workspace owner required');});});
 test('gerar e descartar não mudam treinamento',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a}=await fixture();const t=await begin(a);await finish(t.id,[ch('treinamento',a,'golden_rules','Nova regra')]);
  const b=await rpc<{golden_rules:string}>('select public.read_my_ai_agent($1,$2,false) r',[LOJA_A,a]);expect(b.golden_rules).toBe('Regra original');
  await transition(t.id,'discard');expect((await rpc<{golden_rules:string}>('select public.read_my_ai_agent($1,$2,false) r',[LOJA_A,a])).golden_rules).toBe('Regra original');
  expect(await banco.esperarErro(()=>transition(t.id,'apply'))).toContain('editor_turn_changed');
 });});
 test('aprova treinamento, catálogo e áudio juntos; desfaz os três',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a,c,v}=await fixture();const t=await begin(a);
  await finish(t.id,[ch('treinamento',a,'golden_rules','Sem insistir'),ch('catalogo',c,'price','200'),ch('audio',v,'when_to_use','Quando perguntarem sobre garantia')]);
  await transition(t.id,'apply');expect((await rpc<{golden_rules:string}>('select public.read_my_ai_agent($1,$2,false) r',[LOJA_A,a])).golden_rules).toBe('Sem insistir');
  // A leitura direta de tabelas é feita como administrador só para verificar a persistência.
  await banco.db.exec('reset role');expect((await banco.db.query<{price:string}>('select price from public.catalog_items where id=$1',[c])).rows[0]?.price).toBe('200');
  await banco.db.exec('set local role authenticated');await transition(t.id,'undo');
  expect((await rpc<{golden_rules:string}>('select public.read_my_ai_agent($1,$2,false) r',[LOJA_A,a])).golden_rules).toBe('Regra original');
  await banco.db.exec('reset role');expect((await banco.db.query<{price:string}>('select price from public.catalog_items where id=$1',[c])).rows[0]?.price).toBe('100');
 });});
 test('conflito em catálogo impede TODAS as escritas',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a,c}=await fixture();const t=await begin(a);await finish(t.id,[ch('treinamento',a,'golden_rules','Não deve salvar'),ch('catalogo',c,'price','200')]);
  await banco.db.exec('reset role');await banco.db.query("update public.catalog_items set price='300' where id=$1",[c]);await banco.db.exec('set local role authenticated');
  expect(await banco.esperarErro(()=>transition(t.id,'apply'))).toContain('editor_conflict');expect((await rpc<{golden_rules:string}>('select public.read_my_ai_agent($1,$2,false) r',[LOJA_A,a])).golden_rules).toBe('Regra original');
 });});
 test('não desfaz sobre uma edição posterior',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a}=await fixture();const t=await begin(a);await finish(t.id,[ch('treinamento',a,'golden_rules','Proposta')]);await transition(t.id,'apply');
  await rpc('select public.save_my_ai_agent($1,$2,$3) r',[LOJA_A,a,{golden_rules:'Mudança posterior'}]);expect(await banco.esperarErro(()=>transition(t.id,'undo'))).toContain('editor_conflict');
 });});
 test('campos proibidos, alvos inexistentes e tipo incorreto são recusados',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a}=await fixture();const t=await begin(a);
  for(const changes of [[ch('treinamento',a,'workspace_id',LOJA_B)],[ch('audio',randomUUID(),'when_to_use','x')],[ch('treinamento',a,'golden_rules',true)]])expect(await banco.esperarErro(()=>finish(t.id,changes))).toMatch(/editor_(forbidden_field|target_not_found|invalid_type)/);
 });});
 test('bloqueia geração concorrente e pedido repetido',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a}=await fixture();const t=await begin(a);expect(await banco.esperarErro(()=>begin(a,t.thread_id))).toContain('editor_busy');expect(await banco.esperarErro(()=>begin(a,t.thread_id,'duplicado',t.id))).toContain('editor_request_already_used');
 });});
 test('conversa sem alterações não produz aprovação; histórico isolado por empresa',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a}=await fixture();const t=await begin(a);await finish(t.id,[]);expect(await banco.esperarErro(()=>transition(t.id,'apply'))).toContain('editor_turn_changed');
  const hist=await rpc<{turns:Array<{status:string}>}>('select public.read_my_training_ai_chat($1,$2,$3) r',[LOJA_A,a,t.thread_id]);expect(hist.turns[0]?.status).toBe('discussed');
 });await banco.comoUsuario(DONO_B,async()=>{expect(await banco.esperarErro(()=>rpc('select public.read_my_training_ai_chat($1,$2,null) r',[LOJA_A,randomUUID()]))).toContain('Workspace owner required');});});
});
describe('editor: limites e validação de payload',()=>{
 test('recusa campo repetido e mais de 30 alterações',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a}=await fixture(),t=await begin(a);const m=ch('treinamento',a,'golden_rules','Depois');
  expect(await banco.esperarErro(()=>finish(t.id,[m,m]))).toContain('editor_duplicate_field');
  expect(await banco.esperarErro(()=>finish(t.id,Array(31).fill(m)))).toContain('editor_invalid_proposal');
 });});
 test('limita solicitações por empresa mesmo em conversas novas',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a}=await fixture();for(let i=0;i<6;i++){const t=await begin(a);await finish(t.id,[]);}
  expect(await banco.esperarErro(()=>begin(a))).toContain('editor_rate_limit');
 });});
 test('nova geração carrega a proposta e o estado anterior para pedir ajuste',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a}=await fixture(),t=await begin(a);await finish(t.id,[ch('treinamento',a,'golden_rules','Primeira proposta')]);
  const next=await rpc<{history:Array<{status:string;mutations:unknown[]}>}>('select public.begin_my_training_ai_turn($1,$2,$3,$4,$5,$6) r',[LOJA_A,a,t.thread_id,randomUUID(),'gemini','Ajuste a proposta']);
  expect(next.history[0]?.status).toBe('proposed');expect(next.history[0]?.mutations).toHaveLength(1);
 });});
 test('falha de escrita reverte inclusive catálogo escrito antes do treinamento',async()=>{await banco.comoUsuario(DONA_A,async()=>{
  const {a,c}=await fixture(),t=await begin(a);
  await finish(t.id,[ch('catalogo',c,'price','900'),ch('treinamento',a,'tone','tom-inexistente')]);
  expect(await banco.esperarErro(()=>transition(t.id,'apply'))).toContain('Invalid tone');
  await banco.db.exec('reset role');expect((await banco.db.query<{price:string}>('select price from public.catalog_items where id=$1',[c])).rows[0]?.price).toBe('100');
 });});
});
