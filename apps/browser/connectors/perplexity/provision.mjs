import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import {WindowsDpapiSecretStore} from '../../../../packages/core/src/providers/credential-store.mjs';
import {connectorPaths} from '../../src/connector-config.mjs';
const paths=connectorPaths();
const secrets=new WindowsDpapiSecretStore({root:paths.security});
await mkdir(paths.security,{recursive:true});
try {
  const old=JSON.parse(await readFile(paths.credential,'utf8'));
  const existing=(await secrets.resolve('vault:dpapi.perplexity-remote-key')).trim();
  if(!/^[a-f0-9]{64}$/.test(old.sha256)||createHash('sha256').update(existing).digest('hex')!==old.sha256)throw new Error('MISMATCH');
  console.log('MNEMOS_PERPLEXITY_CREDENTIAL:present (DPAPI-protected; unchanged)');
} catch(e) {
  if(e.code!=='ENOENT')throw new Error('CREDENTIAL_INCONSISTENT_OR_UNREADABLE: '+e.message);
  const token=randomBytes(32).toString('base64url');
  await secrets.put('perplexity-remote-key',token);
  const sha256=createHash('sha256').update(token).digest('hex');
  await writeFile(paths.credential,JSON.stringify({schema:'mnemos.perplexity.auth.v1',sha256,createdAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('MNEMOS_PERPLEXITY_CREDENTIAL:created (raw key only in Windows DPAPI)');
}
