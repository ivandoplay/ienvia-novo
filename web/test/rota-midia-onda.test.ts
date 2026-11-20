import {beforeEach,expect,test,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),download:vi.fn(),from:vi.fn(),select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn()}));
vi.mock('@/lib/supabase/servico',()=>({criarClienteDeServico:()=>({rpc:mocks.rpc,storage:{from:()=>({download:mocks.download})},from:mocks.from})}));
import {GET} from '@/app/api/motor/midia/route';
beforeEach(()=>{vi.clearAllMocks();mocks.from.mockReturnValue({select:mocks.select});mocks.select.mockReturnValue({eq:mocks.eq});mocks.eq.mockReturnValue({eq:mocks.eq,maybeSingle:mocks.maybeSingle});});
const req=()=>new Request('https://painel.test/api/motor/midia?message_id=m',{headers:{'x-ienvia-motor-token':'a'.repeat(64)}});
test('onda acompanha somente o arquivo autorizado e não altera bytes',async()=>{
 mocks.rpc.mockResolvedValue({data:{result:'ok',workspace_id:'w',object_key:'w/audios/voz.ogg',content_type:'audio/ogg'},error:null});
 mocks.download.mockResolvedValue({data:new Blob(['audio-original']),error:null});
 const onda=Array.from({length:64},(_,i)=>i);mocks.maybeSingle.mockResolvedValue({data:{waveform:onda},error:null});
 const r=await GET(req());expect(await r.text()).toBe('audio-original');
 expect(Buffer.from(r.headers.get('x-ienvia-audio-waveform')!,'base64')).toEqual(Buffer.from(onda));
 expect(mocks.eq).toHaveBeenCalledWith('workspace_id','w');expect(mocks.eq).toHaveBeenCalledWith('object_key','w/audios/voz.ogg');
});
test('nega acesso antes de consultar arquivo ou onda',async()=>{
 mocks.rpc.mockResolvedValue({data:{result:'unauthorized'},error:null});
 expect((await GET(req())).status).toBe(401);expect(mocks.download).not.toHaveBeenCalled();expect(mocks.from).not.toHaveBeenCalled();
});
test('onda ausente não quebra áudio já existente',async()=>{
 mocks.rpc.mockResolvedValue({data:{result:'ok',workspace_id:'w',object_key:'w/voz.ogg',content_type:'audio/ogg'},error:null});
 mocks.download.mockResolvedValue({data:new Blob(['audio']),error:null});mocks.maybeSingle.mockResolvedValue({data:null,error:null});
 const r=await GET(req());expect(r.status).toBe(200);expect(r.headers.has('x-ienvia-audio-waveform')).toBe(false);
});
