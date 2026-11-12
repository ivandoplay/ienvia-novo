import { describe, expect, test } from 'vitest';
import { formatarTelefoneParaDossie, montarDossieParaAdmin } from '@/lib/atendente/dossie';

const AGORA = new Date('2026-11-12T15:40:00Z');

describe('Dossiê administrativo no WhatsApp', () => {
  test('formata números brasileiros com DDD e número com/sem 9', () => {
    expect(formatarTelefoneParaDossie('5586981303979')).toBe('+55 (86) 98130-3979');
    expect(formatarTelefoneParaDossie(null, '558681303979@s.whatsapp.net')).toBe('+55 (86) 8130-3979');
    expect(formatarTelefoneParaDossie(null, null)).toBe('Não identificado');
  });

  test('monta dossiê completo em blocos com recado estruturado e últimas mensagens do cliente', () => {
    const texto = montarDossieParaAdmin({
      tipo: 'handoff',
      agora: AGORA,
      nomeDoContato: 'Carlos Eduardo',
      telefoneDoContato: '+5586999887766',
      emailDoContato: 'carlos@empresa.com',
      nomeDoChip: 'Teste 86 98130-3979',
      telefoneDoChip: '5586981303979',
      recado: 'Cenário: Empresário dono de clínica buscando captação | Gatilho: Pediu valores de mensalidade | Próxima jogada: Validar faturamento e explicar escopo.',
      mensagens: [
        { id: '1', recebida: true, autor: 'contact', texto: 'Oi, atendo estética em Teresina', arquivo: null },
        { id: '2', recebida: false, autor: 'ai', texto: 'Olá Carlos!', arquivo: null },
        { id: '3', recebida: true, autor: 'contact', texto: 'Qual o valor mensal da gestão?', arquivo: null },
      ],
      incluirMensagens: true,
    });

    expect(texto).toContain('DOSSIÊ DE ATENDIMENTO — MODO MANUAL ATIVADO');
    expect(texto).toContain('*Gatilho que ativou:* Pediu valores de mensalidade');
    expect(texto).toContain('• *Nome:* Carlos Eduardo');
    expect(texto).toContain('• *WhatsApp:* +55 (86) 99988-7766');
    expect(texto).toContain('• *E-mail:* carlos@empresa.com');
    expect(texto).toContain('• *Chip de origem:* Teste 86 98130-3979 (+55 (86) 98130-3979)');
    expect(texto).toContain('• *Cenário:* Empresário dono de clínica buscando captação');
    expect(texto).toContain('• *Próxima jogada:* Validar faturamento e explicar escopo.');
    expect(texto).toContain('💬 *ÚLTIMAS MENSAGENS DO CLIENTE*');
    expect(texto).toContain('2. "Qual o valor mensal da gestão?"');
  });

  test('cobre todos os outros tipos (silent_handoff, uncertain_send, error, safety, test) e respeita incluirMensagens=false', () => {
    for (const [tipo, trecho] of [
      ['silent_handoff', 'PAUSA SILENCIOSA'],
      ['uncertain_send', 'ENVIO SEM CONFIRMAÇÃO'],
      ['error', 'FALHA NA IA'],
      ['safety', 'PARADA DE SEGURANÇA'],
      ['test', 'TESTE DE DOSSIÊ ADMINISTRATIVO'],
    ] as const) {
      const msg = montarDossieParaAdmin({
        tipo,
        agora: AGORA,
        recipientJid: '5511999998888@s.whatsapp.net',
        mensagens: [{ id: '1', recebida: true, autor: 'contact', texto: 'Mensagem privada', arquivo: null }],
        incluirMensagens: false,
      });
      expect(msg, tipo).toContain(trecho);
      expect(msg, tipo).not.toContain('ÚLTIMAS MENSAGENS DO CLIENTE');
      expect(msg.length, tipo).toBeLessThanOrEqual(4000);
    }
  });
});
