#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = /(^|\/)(?:node_modules|\.cache|\.next|test-results|playwright-report|wa_auth|data|\.runtime)(\/|$)|(^|\/)\.env(?:\.|$)/;
const findings = [];
for (const file of files) {
  if (file.endsWith('.env.example')) continue;
  if (forbidden.test(file)) findings.push(`${file}: caminho privado/gerado`);
  if (!fs.existsSync(file)) continue;
  const b = fs.readFileSync(file);
  if (b.length > 2_000_000) findings.push(`${file}: arquivo acima de 2 MB; use arquivo externo`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/.test(b.toString('utf8'))) findings.push(`${file}: possível segredo (conteúdo não exibido)`);
}
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log(`OK: ${files.length} arquivos versionados; sem caminhos privados/gerados nem segredos nos padrões verificados.`);
