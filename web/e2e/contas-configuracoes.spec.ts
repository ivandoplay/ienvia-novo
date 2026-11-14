import { expect, test } from '@playwright/test';
import { abrirMenuDaConta, entrar } from './apoio/sessao';
import { SENHA_DE_TESTE } from './apoio/dados.mjs';

const REINICIAR_FASE7 = 'http://127.0.0.1:54399/controle/reiniciar-fase7';

test.describe('Fase 7 — Configurações, Multi-workspace e Clientes SaaS', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(REINICIAR_FASE7);
  });

  test.afterAll(async ({ request }) => {
    await request.post(REINICIAR_FASE7);
  });

  test('dono altera marca white-label, perfil, senha, política LGPD e baixa JSON sanitizado', async ({
    page,
    isMobile,
  }) => {
    await entrar(page, 'dona');
    await page.goto('/configuracoes');

    // 1. White-label e perfil
    await page.getByLabel('Nome da empresa (workspace)').fill('Boutique Maria VIP');
    await page.getByLabel('Nome da marca no topo').fill('Zap Maria');
    await page.getByLabel('Subtítulo da marca').fill('Atendimento Boutique');
    await page.getByLabel('Seu nome de exibição').fill('Maria Proprietária');
    await page.getByRole('button', { name: 'Salvar marca e perfil' }).click();

    await expect(page.getByText('Nome, marca e perfil salvos.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Nome da empresa (workspace)')).toHaveValue('Boutique Maria VIP');
    await expect(page.getByLabel('Nome da marca no topo')).toHaveValue('Zap Maria');
    await expect(page.getByLabel('Subtítulo da marca')).toHaveValue('Atendimento Boutique');
    await expect(page.getByLabel('Seu nome de exibição')).toHaveValue('Maria Proprietária');

    if (!isMobile) {
      await expect(page.locator('#menu-principal .brand-title')).toHaveText('Zap Maria');
      await expect(page.locator('#menu-principal .brand-sub')).toHaveText('Atendimento Boutique');
    }

    // 2. Política de retenção LGPD
    await page.getByLabel('Guarda de mensagens (dias)').fill('90');
    await page.getByLabel('Guarda de mídias da Inbox (dias)').fill('45');
    await page.getByRole('button', { name: 'Salvar política de guarda' }).click();
    await expect(page.getByText('Política de guarda e limpeza atualizada.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Guarda de mensagens (dias)')).toHaveValue('90');
    await expect(page.getByLabel('Guarda de mídias da Inbox (dias)')).toHaveValue('45');

    // 3. Exportação JSON sanitizada (dispara requisição e valida conteúdo limpo)
    const [respExport] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/configuracoes/exportar')),
      page.getByRole('button', { name: 'Baixar cópia em JSON' }).click(),
    ]);
    expect(respExport.status()).toBe(200);
    const exportado = (await respExport.json()) as Record<string, unknown>;
    expect(exportado.format).toBe('ienvia-workspace-export-v1');
    expect((exportado.workspace as { name?: string })?.name).toBe('Boutique Maria VIP');
    const jsonTexto = JSON.stringify(exportado);
    expect(jsonTexto).not.toContain('encrypted_api_key');
    expect(jsonTexto).not.toContain('provider_instance_name');

    // 4. Troca de senha (recusa senha atual errada, aceita correta e loga com a nova)
    await page.getByLabel('Senha atual').fill('errada-123');
    await page.getByLabel('Nova senha', { exact: true }).fill('NovaSenhaForte99');
    await page.getByLabel('Confirmar nova senha').fill('NovaSenhaForte99');
    await page.getByRole('button', { name: 'Atualizar senha' }).click();
    await expect(page.getByText('A senha atual informada não confere.')).toBeVisible();

    await page.getByLabel('Senha atual').fill(SENHA_DE_TESTE);
    await page.getByRole('button', { name: 'Atualizar senha' }).click();
    await expect(page.getByText('Senha alterada com sucesso.')).toBeVisible();

    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: 'Sair desta conta' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await entrar(page, 'dona', 'NovaSenhaForte99');
    await expect(page).toHaveURL(/\/visao-geral$/);
  });

  test('operador não altera marca, retenção nem exporta JSON', async ({ page }) => {
    await entrar(page, 'atendente');
    await page.goto('/configuracoes');

    await expect(page.getByRole('heading', { level: 1, name: 'Geral' })).toBeVisible();
    await expect(page.getByLabel('Seu nome de exibição')).toBeVisible();
    await expect(page.getByLabel('Nome da marca no topo')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Guarda e limpeza automática (LGPD)' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Exportar meus dados' })).toHaveCount(0);

    await page.getByLabel('Seu nome de exibição').fill('Ana Silva');
    await page.getByRole('button', { name: 'Salvar perfil' }).click();
    await expect(page.getByText('Seu nome de exibição foi atualizado.')).toBeVisible();

    const respExport = await page.request.get('/api/configuracoes/exportar');
    expect(respExport.status()).toBe(403);
  });

  test('usuário com múltiplos workspaces troca de conta no menu e mantém escolha após recarregar', async ({
    page,
  }) => {
    await entrar(page, 'multi');

    // Começa na Loja da Maria (mais antiga) com 9 conversas esperando.
    await expect(page.getByRole('link', { name: /^9\s*Esperando você/ })).toBeVisible();

    const folha = await abrirMenuDaConta(page);
    await expect(folha.getByText('Trocar de workspace')).toBeVisible();
    await folha.getByRole('button', { name: /Outra Empresa/ }).click();

    await expect(page.getByRole('link', { name: /^0\s*Esperando você/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: /^0\s*Esperando você/ })).toBeVisible();
  });

  test('master cria cliente SaaS, desativa conta, usa Modo Suporte auditado e sai', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');

    await expect(page.getByRole('heading', { level: 1, name: 'Clientes SaaS' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Loja da Maria' })).toBeVisible();

    // 1. Cria novo cliente SaaS
    await page.getByRole('button', { name: '+ Novo cliente' }).click();
    await page.getByLabel('Nome da empresa').fill('Clínica Boa Saúde');
    await page.getByLabel('Login ou e-mail do dono').fill('clinica_nova');
    await page.getByLabel('Nome do responsável').fill('Dra. Clara');
    await page.getByLabel('Senha inicial').fill('ClinicaSenha2026!');
    await page.getByLabel('Limite de chips').fill('3');
    await page.getByLabel('Plano / pacote').fill('Pro');
    await page.getByRole('button', { name: 'Criar cliente SaaS' }).click();

    await expect(page.getByText('Cliente "Clínica Boa Saúde" criado com sucesso.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Clínica Boa Saúde' })).toBeVisible();

    // 2. Entra em Modo Suporte na Loja da Maria
    const cardMaria = page.locator('.conta-card', { hasText: 'Loja da Maria' });
    await cardMaria.getByRole('button', { name: 'Entrar em suporte' }).click();
    await page.getByLabel('Motivo do suporte (vai para o registro de auditoria)').fill('Conferir atendimento Fase 7');
    await page.getByRole('button', { name: 'Confirmar entrada em suporte' }).click();

    await expect(page).toHaveURL(/\/visao-geral$/);
    const faixaSuporte = page.getByRole('region', { name: 'Modo suporte ativo' });
    await expect(faixaSuporte).toContainText('Loja da Maria');
    await expect(faixaSuporte).toContainText('Conferir atendimento Fase 7');
    await expect(page.getByRole('link', { name: /^9\s*Esperando você/ })).toBeVisible();

    // Sai do Modo Suporte pela faixa superior
    await faixaSuporte.getByRole('button', { name: 'Sair do suporte' }).click();
    await expect(faixaSuporte).toHaveCount(0);

    // Volta para /contas e confere auditoria
    await page.goto('/contas');
    await expect(page.getByText('Iniciou Modo Suporte — Loja da Maria')).toBeVisible();
    await expect(page.getByText('Conferir atendimento Fase 7')).toBeVisible();
    await expect(page.getByText('Encerrou Modo Suporte — Loja da Maria')).toBeVisible();

    // 3. Desativa a Clínica Boa Saúde e testa que o dono vê o aviso de conta desativada
    const cardClinica = page.locator('.conta-card', { hasText: 'Clínica Boa Saúde' });
    await cardClinica.getByRole('button', { name: 'Editar conta' }).click();
    await cardClinica.getByLabel('Situação da conta').selectOption('closed');
    await cardClinica.getByRole('button', { name: 'Salvar conta' }).click();
    await expect(page.getByText('Conta "Clínica Boa Saúde" salva e desativada.')).toBeVisible();

    // Sai como master e entra como clinica_nova
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: 'Sair desta conta' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Usuário ou e-mail').fill('clinica_nova');
    await page.getByLabel('Senha', { exact: true }).fill('ClinicaSenha2026!');
    await page.getByRole('button', { name: 'Acessar Meu Painel' }).click();

    await expect(page).toHaveURL(/\/visao-geral$/);
    await expect(page.getByRole('heading', { name: 'Esta conta está desativada' })).toBeVisible();
  });

  test('master exclui um cliente, o acesso cai na hora, fica no histórico e dá para desfazer', async ({ page }) => {
    await entrar(page, 'master@exemplo.com');
    await page.goto('/contas');
    await expect(page.getByRole('heading', { level: 1, name: 'Clientes SaaS' })).toBeVisible();

    // 1. Exclui a Loja da Maria: abre a janela, exige motivo e confirma
    const card = page.locator('.conta-card', { hasText: 'Loja da Maria' }).first();
    await card.getByRole('button', { name: 'Excluir cliente' }).click();

    const janela = page.getByRole('dialog', { name: /Excluir Loja da Maria/ });
    await expect(janela).toBeVisible();
    const confirmar = janela.getByRole('button', { name: 'Excluir cliente' });
    await expect(confirmar).toBeDisabled(); // sem motivo não exclui

    await janela.getByLabel('Motivo da exclusão (fica no histórico)').fill('Cliente pediu para sair');
    await expect(confirmar).toBeEnabled();
    await confirmar.click();

    await expect(page.getByText(/Loja da Maria foi excluído/)).toBeVisible();

    // 2. O cartão vira "Desativada" e oferece desfazer
    const cardDesativado = page.locator('.conta-card', { hasText: 'Loja da Maria' }).first();
    await expect(cardDesativado.getByText('Desativada')).toBeVisible();
    await expect(cardDesativado.getByRole('button', { name: 'Desfazer exclusão' })).toBeVisible();
    await expect(page.getByText('Excluiu cliente — Loja da Maria')).toBeVisible();
    await expect(page.getByText(/Motivo: Cliente pediu para sair/)).toBeVisible();

    // 3. O dono da loja perde o acesso na hora
    const folha = await abrirMenuDaConta(page);
    await folha.getByRole('button', { name: 'Sair desta conta' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Usuário ou e-mail').fill('dona@zapia.local');
    await page.getByLabel('Senha', { exact: true }).fill(SENHA_DE_TESTE);
    await page.getByRole('button', { name: 'Acessar Meu Painel' }).click();
    await expect(page.getByRole('heading', { name: 'Esta conta está desativada' })).toBeVisible();

    // 4. Master volta e desfaz a exclusão por engano
    const folhaDaDona = await abrirMenuDaConta(page);
    await folhaDaDona.getByRole('button', { name: 'Sair desta conta' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await entrar(page, 'master@exemplo.com');

    await page.goto('/contas');
    const cardRestaurar = page.locator('.conta-card', { hasText: 'Loja da Maria' }).first();
    await cardRestaurar.getByRole('button', { name: 'Desfazer exclusão' }).click();
    await expect(page.getByText(/Loja da Maria voltou a ficar ativo/)).toBeVisible();
    await expect(page.locator('.conta-card', { hasText: 'Loja da Maria' }).first().getByText('Ativa')).toBeVisible();
    await expect(page.getByText('Restaurou cliente — Loja da Maria')).toBeVisible();
  });
});
