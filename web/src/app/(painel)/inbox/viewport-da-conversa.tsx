'use client';
import {useEffect} from 'react';
/** Mede a área realmente visível, inclusive no Chrome Android com teclado aberto. */
export function ViewportDaConversa({ativa}:{ativa:boolean}){
 useEffect(()=>{
  if(!ativa)return;
  const html=document.documentElement;
  const atualizar=()=>{
   const vv=window.visualViewport;
   html.style.setProperty('--inbox-altura-visivel',`${vv?.height??window.innerHeight}px`);
   html.style.setProperty('--inbox-topo-visivel',`${vv?.offsetTop??0}px`);
  };
  html.classList.add('conversa-mobile-ativa');atualizar();
  window.visualViewport?.addEventListener('resize',atualizar);
  window.visualViewport?.addEventListener('scroll',atualizar);
  window.addEventListener('resize',atualizar);
  return ()=>{html.classList.remove('conversa-mobile-ativa');html.style.removeProperty('--inbox-altura-visivel');html.style.removeProperty('--inbox-topo-visivel');window.visualViewport?.removeEventListener('resize',atualizar);window.visualViewport?.removeEventListener('scroll',atualizar);window.removeEventListener('resize',atualizar);};
 },[ativa]);return null;
}
