-- Índices de expressão são mantidos sob o papel que insere/atualiza o contato.
-- phone_core é IMMUTABLE, transforma somente o texto recebido e não lê tabelas.
-- Não concede acesso a tabelas privadas nem a visitantes anônimos.
grant execute on function private.phone_core(text) to authenticated;
