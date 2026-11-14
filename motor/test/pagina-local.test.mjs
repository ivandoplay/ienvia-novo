import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { iniciarPaginaLocal, lerTokenLocal, paginaHtml } from '../src/pagina-local.mjs';
import { lerConfiguracao, salvarConfiguracao } from '../src/config.mjs';

function pastaTemporaria() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ienvia-pagina-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '6.1.0' }));
  return dir;
}

test('página local exige token e nunca oferece conectar chip/WhatsApp', async () => {
  const rootDir = pastaTemporaria();
  const pagina = await iniciarPaginaLocal({
    rootDir,
    porta: 0,
    abrirNavegador: false,
    candidatosDePainel: ['https://painel.invalido'],
    lerConfiguracao,
    salvarConfiguracao,
    fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    onLog: () => {},
  });

  try {
    // O endereço informado é sempre local: nunca escuta na rede.
    assert.match(pagina.endereco, /^http:\/\/127\.0\.0\.1:\d+$/);

    const html = await (await fetch(`${pagina.endereco}/`)).text();
    // As duas formas de ligar o aparelho aparecem na página.
    assert.match(html, /E-mail e senha/);
    assert.match(html, /Código de pareamento/);
    // Conectar WhatsApp (QR ou código de 8 dígitos) NÃO acontece aqui.
    assert.doesNotMatch(html, /QR Code|requestPairingCode|pairing_code/i);
    // A senha não fica embutida no HTML.
    assert.doesNotMatch(html, /senha"\s*value=/i);

    // Sem o token local, qualquer POST é recusado (outra página aberta no PC não pode parear sozinha).
    const semToken = await fetch(`${pagina.endereco}/api/parear-codigo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codigo: 'IENV-ABCD-2345' }),
    });
    assert.equal(semToken.status, 403);

    // Com o token e um código inválido, quem decide é o painel — e o erro volta legível
    // (sem o token local, a resposta seria 403; aqui ela passa da porta de segurança).
    const comToken = await fetch(`${pagina.endereco}/api/parear-codigo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ienvia-local': pagina.token },
      body: JSON.stringify({ codigo: 'IENV-ABCD-2345', painel: 'https://painel.invalido' }),
    });
    assert.notEqual(comToken.status, 403);
    const erro = await comToken.json();
    assert.match(erro.erro, /internet|painel|expirado/i);

    // Nada foi gravado: aparelho continua não pareado.
    assert.equal(lerConfiguracao(rootDir).deviceToken, '');
  } finally {
    await pagina.fechar();
  }
});

test('pareamento por senha grava a configuração e vira a página para "ligado"', async () => {
  const rootDir = pastaTemporaria();
  const chamadas = [];
  const fetchFn = async (url, opcoes = {}) => {
    chamadas.push({ url: String(url), corpo: opcoes.body ? JSON.parse(opcoes.body) : null });
    if (String(url).endsWith('/api/motor/parear-senha')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          executor_id: '11111111-1111-1111-1111-111111111111',
          workspace_id: '22222222-2222-2222-2222-222222222222',
          display_name: 'Celular da Loja',
          device_token: 'a'.repeat(64),
        }),
      };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };

  const pagina = await iniciarPaginaLocal({
    rootDir,
    porta: 0,
    abrirNavegador: false,
    candidatosDePainel: [],
    lerConfiguracao,
    salvarConfiguracao,
    fetchFn,
    onLog: () => {},
  });

  try {
    const resp = await fetch(`${pagina.endereco}/api/parear-senha`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ienvia-local': pagina.token },
      body: JSON.stringify({ email: 'dono@exemplo.com', senha: 'segredo123', painel: 'https://painel.teste' }),
    });
    assert.equal(resp.status, 200);
    const dados = await resp.json();
    assert.equal(dados.ok, true);

    const cfg = lerConfiguracao(rootDir);
    assert.equal(cfg.panelUrl, 'https://painel.teste');
    assert.equal(cfg.deviceToken, 'a'.repeat(64));
    assert.equal(cfg.displayName, 'Celular da Loja');

    // A senha foi usada só na chamada; nunca é gravada em disco.
    const arquivo = fs.readFileSync(path.join(rootDir, 'data', 'motor.json'), 'utf8');
    assert.doesNotMatch(arquivo, /segredo123/);

    const estado = await (await fetch(`${pagina.endereco}/api/estado`)).json();
    assert.equal(estado.pareado, true);
    assert.equal(estado.aparelho, 'Celular da Loja');
  } finally {
    await pagina.fechar();
  }
});

test('token local é criado uma vez e reaproveitado', () => {
  const rootDir = pastaTemporaria();
  const primeiro = lerTokenLocal(rootDir);
  const segundo = lerTokenLocal(rootDir);
  assert.equal(primeiro.token, segundo.token);
  assert.ok(primeiro.token.length >= 32);
  const modo = fs.statSync(primeiro.arquivo).mode & 0o777;
  assert.equal(modo, 0o600);
});

test('html escapa o nome do aparelho (sem injeção na página)', () => {
  const html = paginaHtml({ token: 'x', estado: { pareado: true, aparelho: '<script>alert(1)</script>' } });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});
