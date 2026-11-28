import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measure } from '../../scripts/workspace-budget.mjs';
test('orçamento ignora gerados e aliases, mas conta arquivos privados normais', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-budget-'));
  try {
    await writeFile(path.join(root,'codigo.txt'),'abc');
    await writeFile(path.join(root,'.env'),'12345');
    await mkdir(path.join(root,'.cache'));
    await writeFile(path.join(root,'.cache','temporario'),'x'.repeat(100));
    await symlink(root,path.join(root,'alias'));
    const r = await measure(root);
    assert.equal(r.bytes,8); assert.equal(r.files,2); assert.equal(r.ok,true);
  } finally { await rm(root,{recursive:true,force:true}); }
});
