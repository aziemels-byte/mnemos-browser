import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import electronPath from 'electron';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=path.resolve(root,'../..');
const delivery=path.resolve(process.env.MNEMOS_BROWSER_PACKAGE_ROOT??path.join(root,'dist'));
const target=path.join(delivery,'portable');
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This package script currently targets Windows x64 only');
// No deletion, no profile copy, no installation, and no production write.
await fs.mkdir(delivery,{recursive:true});
await fs.mkdir(target);
await fs.cp(path.dirname(electronPath),target,{recursive:true});
const executable=path.join(target,'MNEMOS Browser.exe');
await fs.rename(path.join(target,'electron.exe'),executable);
const appDir=path.join(target,'resources','app');
await fs.mkdir(path.join(appDir,'apps','browser'),{recursive:true});
for(const dir of ['src','ui'])await fs.cp(path.join(root,dir),path.join(appDir,'apps','browser',dir),{recursive:true});
await fs.copyFile(path.join(root,'package.json'),path.join(appDir,'apps','browser','package.json'));
const bundledConnector='connectors/perplexity/collaboration-store.mjs';
const packagedConnector=path.join(appDir,'apps','browser',bundledConnector);
await fs.mkdir(path.dirname(packagedConnector),{recursive:true});
await fs.copyFile(path.join(root,bundledConnector),packagedConnector);
await fs.writeFile(path.join(appDir,'package.json'),JSON.stringify({name:'mnemos-browser-runtime',version:'0.1.0',private:true,type:'module',main:'apps/browser/src/main.mjs'},null,2));
const copied=new Set();
async function copyModule(relative){
  if(copied.has(relative))return;copied.add(relative);
  const source=path.resolve(repo,relative);
  if(!source.startsWith(repo+path.sep)||!relative.startsWith('packages/'))throw new Error('Package dependency escaped Core source root');
  const content=await fs.readFile(source,'utf8'),dest=path.join(appDir,relative);
  await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,content);
  const dependencies=[...content.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+\.mjs)['"]/g)].map(m=>path.posix.normalize(path.posix.join(path.posix.dirname(relative),m[1])));
  for(const dep of dependencies)await copyModule(dep);
}
await copyModule('packages/core/src/controller/frontier-session-bus.mjs');
await copyModule('packages/core/src/providers/credential-store.mjs');
await fs.writeFile(path.join(delivery,'Start-MNEMOS-Browser.cmd'),'@echo off\r\nstart "" "%~dp0portable\\MNEMOS Browser.exe"\r\n');
const browserPackage=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const files=[];
async function inventory(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){if(item.name==='.profile')continue;const p=path.join(dir,item.name);if(item.isDirectory())await inventory(p);else{const bytes=await fs.readFile(p);files.push({path:path.relative(target,p).replaceAll('\\','/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}}
await inventory(target);
await fs.writeFile(path.join(delivery,'PACKAGE-MANIFEST.json'),JSON.stringify({createdAt:new Date().toISOString(),platform:'win32-x64',version:'0.1.0',electron:browserPackage.devDependencies.electron,signed:false,publicRelease:false,profileIncluded:false,coreModules:[...copied],files},null,2));
console.log(JSON.stringify({target,files:files.length,coreModules:copied.size,bytes:files.reduce((n,f)=>n+f.bytes,0),signed:false}));
