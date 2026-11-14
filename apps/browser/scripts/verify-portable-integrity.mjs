import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const delivery=path.resolve(process.env.MNEMOS_BROWSER_PACKAGE_ROOT??path.join(here,'../dist'));
const portable=path.join(delivery,'portable');
test('portable browser manifest includes new Core bridge and matches every packaged byte',async()=>{
  const manifest=JSON.parse(await readFile(path.join(delivery,'PACKAGE-MANIFEST.json'),'utf8'));
  assert.equal(manifest.profileIncluded,false);
  assert.equal(manifest.platform,'win32-x64');
  const names=new Set(),entries=manifest.files;
  assert.ok(entries.length>50,'Expected full portable manifest');
  assert.ok(entries.some(x=>x.path==='resources/app/apps/browser/src/core-browser-bridge.mjs'));
  for(const row of entries){
    assert.ok(typeof row.path==='string'&&!row.path.startsWith('/')&&!row.path.includes('..'));
    assert.ok(!names.has(row.path),'Duplicate manifest entry: '+row.path);names.add(row.path);
    const file=path.resolve(portable,...row.path.split('/'));
    assert.ok(file.startsWith(portable+path.sep));
    const s=await stat(file);
    assert.equal(s.size,row.bytes,'Size mismatch: '+row.path);
    const hash=createHash('sha256');
    for await(const chunk of createReadStream(file))hash.update(chunk);
    assert.equal(hash.digest('hex'),row.sha256,'Hash mismatch: '+row.path);
  }
  console.log('Verified',entries.length,'portable files and all SHA256 digests');
});
