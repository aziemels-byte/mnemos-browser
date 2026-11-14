import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {selectBrowserProfile} from '../src/profile-policy.mjs';
const root=path.join(os.tmpdir(),'mnemos-fixture');
const legacy=path.join(root,'portable','.profile');
const appdata=path.join(root,'user-data');
const explicit=path.join(root,'custom');
const tmp=path.join(root,'test-profile');

test('A pre-existing authenticated Chromium profile is NEVER silently moved or destroyed',()=>{
 assert.deepEqual(selectBrowserProfile({legacyProfile:legacy,defaultProfile:appdata,legacyExists:true}),
   {path:legacy,location:'LEGACY_INSIDE_PACKAGE'});
});
test('A fresh install puts all new authenticated data outside the executable tree',()=>{
 assert.deepEqual(selectBrowserProfile({legacyProfile:legacy,defaultProfile:appdata,legacyExists:false}),
   {path:appdata,location:'APPDATA'});
});
test('Explicit profile wins over both legacy and new defaults',()=>{
 assert.deepEqual(selectBrowserProfile({legacyProfile:legacy,defaultProfile:appdata,
   explicitProfile:explicit,legacyExists:true}),{path:explicit,location:'EXPLICIT'});
});
test('Test mode refuses missing isolated profile instead of using user data',()=>{
 assert.throws(()=>selectBrowserProfile({legacyProfile:legacy,defaultProfile:appdata,
   testMode:true,legacyExists:true}),/PROFILE_TEST_MISSING/);
 assert.deepEqual(selectBrowserProfile({legacyProfile:legacy,defaultProfile:appdata,
   testMode:true,testProfile:tmp,legacyExists:true,explicitProfile:explicit}),
   {path:tmp,location:'TEST_ISOLATED'});
});
test('Refuse malformed profile roots and blank explicit paths',()=>{
 assert.throws(()=>selectBrowserProfile({legacyProfile:'relative',defaultProfile:appdata}),/PROFILE_ROOT_INVALID/);
 assert.throws(()=>selectBrowserProfile({legacyProfile:legacy,defaultProfile:appdata,explicitProfile:' '}),/PROFILE_EXPLICIT_MISSING/);
});
