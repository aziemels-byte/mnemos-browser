import { randomBytes,createHash } from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {WindowsDpapiSecretStore} from '../../../packages/core/src/providers/credential-store.mjs';
import {connectorPaths} from '../src/connector-config.mjs';
const paths=connectorPaths(),configPath=paths.geminiConfig;
let cfg=null;
try{cfg=JSON.parse(await readFile(configPath,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;}
if(!cfg){
 const clientId='mnemos-gemini-'+randomBytes(16).toString('hex');
 const consent=randomBytes(32).toString('base64url');
 const store=new WindowsDpapiSecretStore({root:paths.security});
 const reference=await store.put('gemini-oauth-consent-key',consent);
 const verified=await store.resolve(reference);
 if(verified.trim()!==consent)throw new Error('DPAPI_CONSENT_ROUNDTRIP_FAILED');
 cfg={schema:'mnemos.gemini-oauth.v1',clientId,
   consentSha:createHash('sha256').update(consent).digest('hex'),
   method:'oauth-authorization-code-pkce-s256',createdAt:new Date().toISOString()};
 await writeFile(configPath,JSON.stringify(cfg,null,2)+'\n',{flag:'wx',mode:0o600});
}
if(!cfg?.clientId||!cfg?.consentSha)throw new Error('INVALID_GEMINI_CONFIG');
console.log('GEMINI_OAUTH_PROVISIONED',JSON.stringify({
 clientId:cfg.clientId,method:cfg.method,consentStoredInWindowsDpapi:true,
 configContainsRawConsent:false,configFile:configPath
}));
