import path from 'node:path';

// Pure, deterministic selector: never migrates, deletes or opens profile files.
// Chromium uses exclusive DB locks; copying a live profile is unsafe.
export function selectBrowserProfile({testMode=false,testProfile=null,explicitProfile=null,
 legacyProfile,defaultProfile,legacyExists=false}){
 if(typeof legacyProfile!=='string'||!path.isAbsolute(legacyProfile)||
    typeof defaultProfile!=='string'||!path.isAbsolute(defaultProfile))
   throw new Error('PROFILE_ROOT_INVALID');
 const pick=(value,name)=>{
   if(typeof value!=='string'||!value.trim())throw new Error('PROFILE_'+name+'_MISSING');
   return path.resolve(value);
 };
 if(testMode)return {path:pick(testProfile,'TEST'),location:'TEST_ISOLATED'};
 if(explicitProfile!=null)return {path:pick(explicitProfile,'EXPLICIT'),location:'EXPLICIT'};
 if(legacyExists)return {path:path.resolve(legacyProfile),location:'LEGACY_INSIDE_PACKAGE'};
 return {path:path.resolve(defaultProfile),location:'APPDATA'};
}
