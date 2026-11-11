'use client';

import { useActionState, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { entrar, type EstadoDoLogin } from './acoes';

const ESTADO_INICIAL: EstadoDoLogin = {};

export function FormularioDeLogin({ voltar }: { voltar: string }) {
  const [estado, enviar, enviando] = useActionState(entrar, ESTADO_INICIAL);
  const [senhaVisivel, setSenhaVisivel] = useState(false);

  return (
    <form action={enviar} className="login-form">
      {estado.erro ? (
        <div className="aviso aviso--erro" role="alert">
          {estado.erro}
        </div>
      ) : null}

      <div className="form-group">
        <label className="form-label" htmlFor="login-usuario">
          Usuário ou e-mail
        </label>
        <input
          id="login-usuario"
          name="usuario"
          type="text"
          required
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Digite seu usuário ou e-mail..."
          defaultValue={estado.usuario ?? ''}
        />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="login-senha">
          Senha
        </label>
        <div className="login-senha-linha">
          <input
            id="login-senha"
            name="senha"
            type={senhaVisivel ? 'text' : 'password'}
            required
            autoComplete="current-password"
            placeholder="Digite sua senha..."
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm login-olho"
            aria-label={senhaVisivel ? 'Ocultar senha' : 'Mostrar senha'}
            aria-pressed={senhaVisivel}
            onClick={() => setSenhaVisivel((visivel) => !visivel)}
          >
            <Icone nome="olho" />
          </button>
        </div>
      </div>

      <input type="hidden" name="voltar" value={voltar} />

      <button type="submit" className="btn btn-primary login-entrar" disabled={enviando}>
        {enviando ? 'Entrando…' : 'Acessar Meu Painel'}
      </button>
    </form>
  );
}
