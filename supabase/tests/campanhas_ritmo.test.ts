import {beforeAll, expect, test} from 'vitest';
import {bancoComCenario, DONA_A, LOJA_A} from './helpers/cenario';
import type {BancoDeTeste} from './helpers/banco';
let banco: BancoDeTeste;
beforeAll(async()=>{banco=await bancoComCenario();});
test('migração expõe ritmo preservando função e autorização',async()=>{
 const {rows}=await banco.db.query<{def:string}>(`select pg_get_functiondef('public.read_my_campaign(uuid,uuid)'::regprocedure) as def`);
 expect(rows[0]!.def).toContain("'next_action_at'");expect(rows[0]!.def).toContain('is_workspace_member');
 const claim=await banco.db.query<{def:string}>(`select pg_get_functiondef('public.claim_due_campaign_steps(integer)'::regprocedure) as def`);
 expect(claim.rows[0]!.def).toContain("'batch_rest'");expect(claim.rows[0]!.def).toContain('rhythm_delay_sec = v_delay');
 await banco.comoUsuario(DONA_A,async()=>{
  const res=await banco.db.query<{r:unknown}>('select public.list_my_campaigns($1) as r',[LOJA_A]);expect(res.rows[0]).toBeDefined();
 });
});
