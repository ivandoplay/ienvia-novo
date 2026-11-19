import {afterEach,describe,test,expect,vi} from 'vitest';
import {gerarResposta} from '@/lib/ia/provedores';
afterEach(()=>vi.unstubAllGlobals());
describe('formato JSON opt-in do editor',()=>{
 test.each(['gemini','openrouter','nvidia'] as const)('%s só recebe pedido estruturado quando solicitado',async provedor=>{
  const calls:Array<Record<string,unknown>>=[];
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify(provedor==='gemini'?{candidates:[{content:{parts:[{text:'{"resposta":"Oi","alteracoes":[]}'}]}}]}:{choices:[{message:{content:'{"resposta":"Oi","alteracoes":[]}'}}]}),{status:200,headers:{'content-type':'application/json'}});}));
  const req={provedor,chave:'ficticia',modelo:'modelo-exemplo',sistema:'Retorne JSON',conversa:[{de:'cliente' as const,texto:'Oi'}]};
  await gerarResposta(req);await gerarResposta({...req,formatoJson:true,limiteDeSaida:8192});
  if(provedor==='gemini'){
   expect(calls[0]!.generationConfig).toEqual({temperature:0.35,maxOutputTokens:4096});
   expect(calls[1]!.generationConfig).toEqual({temperature:0.35,maxOutputTokens:8192,responseMimeType:'application/json'});
  }else{expect(calls[0]).not.toHaveProperty('response_format');expect(calls[0]!.max_tokens).toBe(4096);expect(calls[1]!.response_format).toEqual({type:'json_object'});expect(calls[1]!.max_tokens).toBe(8192);}
 });
});
