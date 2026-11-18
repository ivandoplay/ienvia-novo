import test from 'node:test';import assert from 'node:assert/strict';import {argumentosDeInicio} from '../src/iniciar-guiado.mjs';
test('primeiro uso exige código válido e usa painel de produção',()=>{assert.deepEqual(argumentosDeInicio({},'IENV-ABCD-EFGH'),['--url','https://app.ienvia.online','--pair','IENV-ABCD-EFGH','--once']);assert.throws(()=>argumentosDeInicio({},'123'));});
test('vínculo salvo não pede novo código',()=>{assert.deepEqual(argumentosDeInicio({deviceToken:'salvo'}),['--sem-pagina']);});
test('painel sem HTTPS não é aceito',()=>{assert.throws(()=>argumentosDeInicio({panelUrl:'http://inseguro'},'IENV-ABCD-EFGH'));});
