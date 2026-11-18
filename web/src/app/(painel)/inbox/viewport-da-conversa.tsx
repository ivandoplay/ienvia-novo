'use client';
import {useEffect} from 'react';
/** Integra viewport real, acesso ao CRM e fechamento dos painéis sem alterar dados. */
export function ViewportDaConversa({ativa}:{ativa:boolean}){
 useEffect(()=>{
  if(!ativa)return;
  const html=document.documentElement;
  const media=window.matchMedia('(max-width: 900px)');
  const menuCrm=()=>document.querySelector<HTMLDetailsElement>('.inbox-crm-completo');
  const fecharCrm=(focar=false)=>{const menu=menuCrm();if(!menu?.open||!media.matches)return;menu.open=false;if(focar)menu.querySelector<HTMLElement>('summary')?.focus();};
  const atualizar=()=>{
   const vv=window.visualViewport,altura=vv?.height??window.innerHeight;
   html.style.setProperty('--inbox-altura-visivel',`${altura}px`);
   html.style.setProperty('--inbox-topo-visivel',`${vv?.offsetTop??0}px`);
   html.classList.toggle('conversa-mobile-baixa',media.matches&&altura<=440);
  };
  const ajustarCrm=()=>{const menu=menuCrm();if(menu)menu.open=!media.matches;atualizar();};
  const aoTeclar=(e:KeyboardEvent)=>{if(e.key==='Escape'&&media.matches&&menuCrm()?.open){e.preventDefault();fecharCrm(true);}};
  const aoTocar=(e:PointerEvent)=>{const menu=menuCrm();if(menu?.open&&!menu.contains(e.target as Node))fecharCrm();};
  const aoAbrir=(e:Event)=>{
   const alvo=e.target;
   if(!media.matches||!(alvo instanceof HTMLDetailsElement)||!alvo.open)return;
   if(alvo.matches('.inbox-crm-completo'))document.querySelector<HTMLDetailsElement>('.inbox-ferramentas')?.removeAttribute('open');
   if(alvo.matches('.inbox-ferramentas'))fecharCrm();
  };
  media.addEventListener('change',ajustarCrm);ajustarCrm();
  html.classList.add('conversa-mobile-ativa');atualizar();
  window.visualViewport?.addEventListener('resize',atualizar);
  window.visualViewport?.addEventListener('scroll',atualizar);
  window.addEventListener('resize',atualizar);
  document.addEventListener('keydown',aoTeclar);
  document.addEventListener('pointerdown',aoTocar);
  document.addEventListener('toggle',aoAbrir,true);
  return ()=>{
   media.removeEventListener('change',ajustarCrm);
   html.classList.remove('conversa-mobile-ativa','conversa-mobile-baixa');
   html.style.removeProperty('--inbox-altura-visivel');html.style.removeProperty('--inbox-topo-visivel');
   window.visualViewport?.removeEventListener('resize',atualizar);window.visualViewport?.removeEventListener('scroll',atualizar);window.removeEventListener('resize',atualizar);
   document.removeEventListener('keydown',aoTeclar);document.removeEventListener('pointerdown',aoTocar);document.removeEventListener('toggle',aoAbrir,true);
  };
 },[ativa]);return null;
}
