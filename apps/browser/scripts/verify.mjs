import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const browser = fileURLToPath(new URL('../', import.meta.url));
const sourceFolders = ['src', 'ui', 'connectors', 'scripts', 'test'];
const modules = sourceFolders.flatMap(folder => {
  const directory = path.join(browser, folder);
  return readdirSync(directory, { recursive: true })
    .filter(file => /\.(mjs|js|cjs)$/.test(file))
    .map(file => path.join(directory, file));
});

for (const file of modules) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('Syntax verified for ' + modules.length + ' source files');
