import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=path.join(root,'artifacts','workspace-fixture.png');
const info=await stat(file);
if(info.size>1_000_000)throw new Error('PREVIEW_TOO_LARGE');
console.log('THEME_PREVIEW_SIZE='+info.size);
console.log('THEME_PREVIEW_BASE64='+Buffer.from(await readFile(file)).toString('base64'));
