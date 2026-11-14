/** Detector de estouro/corte sem falsos positivos: ignora sr-only, inputs e quem rola por projeto. */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:3100';
const env = Object.fromEntries(readFileSync('/home/user/.env','utf8').split('\n').map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const TELAS=['/visao-geral','/inbox','/conexoes','/instancias','/campanhas','/catalogo','/treinamento','/inteligencia-artificial','/audios','/simulador','/seguranca','/configuracoes'];
const MEDIDA = `(() => {
  const janela = window.innerWidth;
  const achados = [];
  const visivel = (el) => { const s=getComputedStyle(el); const r=el.getBoundingClientRect();
    return s.display!=='none' && s.visibility!=='hidden' && parseFloat(s.opacity)>.05 && r.width>0 && r.height>0; };
  for (const el of document.querySelectorAll('main *')) {
    if (el.closest('.so-leitor-de-tela')) continue;
    if (el.classList.contains('so-leitor-de-tela')) continue;
    if (!visivel(el)) continue;
    const s = getComputedStyle(el);
    const texto = (el.childElementCount===0 ? el.textContent : '').trim();
    // 1) texto mais largo que a caixa, sem rolagem prevista e sem reticências
    if (texto && el.scrollWidth > el.clientWidth + 2 && s.overflowX !== 'auto' && s.overflowX !== 'scroll'
        && s.textOverflow !== 'ellipsis' && s.webkitLineClamp === 'none'
        && !['TEXTAREA','INPUT','SELECT'].includes(el.tagName) && s.whiteSpace !== 'pre') {
      achados.push({ tipo:'texto cortado', sel:el.tagName.toLowerCase()+'.'+(el.className||'').toString().split(' ')[0],
        txt:texto.slice(0,45), precisa:el.scrollWidth, tem:el.clientWidth });
    }
    // 2) elemento visível fora da janela à direita
    const r = el.getBoundingClientRect();
    if (r.width>0 && r.right > janela + 2 && s.position !== 'fixed') {
      const pai = el.parentElement; const rolavel = pai && ['auto','scroll'].includes(getComputedStyle(pai).overflowX);
      if (!rolavel) achados.push({ tipo:'fora da tela', sel:el.tagName.toLowerCase()+'.'+(el.className||'').toString().split(' ')[0],
        txt:(el.textContent||'').trim().slice(0,45), direita:Math.round(r.right), janela });
    }
  }
  const vistos=new Set(); return achados.filter(a=>{const k=a.tipo+a.sel+a.txt; if(vistos.has(k))return false; vistos.add(k); return true;}).slice(0,12);
})()`;

const b=await chromium.launch();
const saida={};
for (const [rotulo, vp, extra] of [['celular',{width:390,height:844},{isMobile:true,hasTouch:true}],['desktop',{width:1440,height:900},{}]]) {
  const ctx=await b.newContext({viewport:vp,locale:'pt-BR',...extra});
  const p=await ctx.newPage();
  await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
  await p.getByLabel(/usuário|usuario|e-mail|email/i).first().fill(env.TESTE_USUARIO);
  await p.getByLabel(/senha/i).first().fill(env.TESTE_SENHA);
  await p.getByRole('button',{name:/entrar|acessar/i}).first().click(); await p.waitForTimeout(2200);
  for (const rota of TELAS) {
    await p.goto(`${BASE}${rota}`,{waitUntil:'networkidle'}); await p.waitForTimeout(1100);
    const achados = await p.evaluate(MEDIDA);
    // rola até o fim e mede de novo (o que só aparece lá embaixo)
    await p.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)'); await p.waitForTimeout(600);
    const fim = await p.evaluate(MEDIDA);
    const todos = [...achados, ...fim.map(a=>({...a, fim:true}))];
    if (todos.length) { saida[`${rotulo}${rota}`]=todos; console.log(`\n[${rotulo}] ${rota}`); todos.forEach(a=>console.log(`  · ${a.tipo} ${a.sel}${a.fim?' (fim)':''} — "${a.txt}" ${a.precisa?`precisa ${a.precisa} tem ${a.tem}`:`direita ${a.direita} > ${a.janela}`}`)); }
  }
  await ctx.close();
}
writeFileSync('/home/user/ienvia/auditoria-visual/cortes.json', JSON.stringify(saida,null,2));
console.log(`\n${Object.keys(saida).length} tela(s) com achado`);
await b.close();
