/**
 * Authenticated Chromium webview automation with explicit native consent in CoreBrowserBridge.
 * No arbitrary scripts, no browser-global / filesystem access, no private tabs, and no
 * secret-field reads. All operations are bound to the tab URL/origin last approved.
 */
// External form submissions require a fresh native confirmation.
// File attachment is separately gated by the user's native OS file picker;
// no second confirmation dialog is needed before the chooser.
export function requiresBrowserOwnerApproval(operation){
  return operation==='tab.submit';
}
const MAX_FIELDS=256,MAX_BUTTONS=256;
const INPUT_TYPES=new Set(['text','search','email','tel','url','number','date','time']);
const BLOCKED=/password|secret|token|otp|2fa|verification.?code|credit|card.?number|cvv|cvc|iban|account.?number|captcha|security.?answer|private.?key/i;
const clip=(v,n=150)=>String(v??'').trim().slice(0,n);
const isVisible=e=>{
  const b=e.getBoundingClientRect(),s=getComputedStyle(e);
  return b.width>2&&b.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[hidden],[aria-hidden="true"],[inert]');
};
function fieldNodes(){
  return [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')]
    .filter(e=>!e.disabled&&(isVisible(e)||(e.tagName==='INPUT'&&e.type==='file'))).slice(0,MAX_FIELDS);
}
function buttonNodes(){
  return [...document.querySelectorAll('button,input[type="submit"],[role="button"],input[type="button"],input[type="image"],a[href]')]
    .filter(e=>isVisible(e)&&!e.disabled).slice(0,MAX_BUTTONS);
}
function fieldName(e){
  return clip(e.getAttribute('aria-label')||e.labels?.[0]?.innerText||
    (e.id?document.querySelector('label[for="'+CSS.escape(e.id)+'"]')?.innerText:'')||
    e.getAttribute('placeholder')||e.getAttribute('name')||e.id||e.tagName,100);
}
function controlInfo(e,i){
  const type=(e.tagName==='INPUT'?e.type:e.isContentEditable?'contenteditable':e.tagName).toLowerCase();
  const name=fieldName(e),blocked=BLOCKED.test(type+' '+name+' '+e.getAttribute('autocomplete'));
  return {index:i,tag:e.tagName.toLowerCase(),type, name,
    required:!!e.required,blocked,
    ...(type==='file'?{fileUpload:true,accept:clip(e.accept,120),multiple:!!e.multiple}:{}),
    filled:!!String(e.value??e.innerText??'').trim(),
    ...(e.tagName==='SELECT'&&Array.isArray([...e.options])?{
      options:[...e.options].filter(o=>!o.disabled).slice(0,16)
        .map(o=>({value:clip(o.value,60),label:clip(o.textContent,60)}))
    }:{}),
    ...(['checkbox','radio'].includes(type)?{checked:!!e.checked}:{})
  };
}
function buttonInfo(e,i){
  const text=clip(e.getAttribute('aria-label')||e.getAttribute('alt')||e.innerText||e.value||e.title,120);
  const highImpact=/^(?:submit|send|post|publish|apply|confirm|accept|authorize|approve|delete|remove|buy|pay|purchase|checkout|order|register|subscribe|unsubscribe|withdraw|finalize|finish|save|update|iesniegt|nosūtīt|sūtīt|publicēt|pieteikties|apstiprināt|pirkt|apmaksāt|dzēst|atcelt|piekrist|reģistrēties|saglabāt|atsaukt|pieņemt)(?:\s|$|[:!])/i.test(text);
  return {index:i,tag:e.tagName.toLowerCase(),text,
    type:clip(e.getAttribute('type')||'',20).toLowerCase(),
    // Button.type defaults to 'submit' even outside a form; that does NOT make
    // ordinary navigation (Main menu, mode picker, etc.) a submission.
    submit:Boolean(highImpact||((e.getAttribute('type')??'').toLowerCase()==='submit')||
      (e.tagName==='BUTTON'&&e.form&&(e.type??'').toLowerCase()==='submit')),
    href:e.tagName==='A'&&e.href&&/^https:$/.test(new URL(e.href).protocol)?
      clip(new URL(e.href).origin+new URL(e.href).pathname,180):null};
}
const inspect=(data={})=>{
  const f=fieldNodes(),b=buttonNodes();
  const offsetField=Math.min(Math.max(0,Number(data.fieldOffset)||0),MAX_FIELDS);
  const offsetButton=Math.min(Math.max(0,Number(data.buttonOffset)||0),MAX_BUTTONS);
  const limit=Math.min(Math.max(1,Number(data.limit)||16),64);
  const result={
    // Chat pages can contain a very long history. The latest exchange is at the END.
    // Never return the oldest 4600 chars while silently hiding the new response.
    title:clip(document.title,180),text:String(document.body?.innerText??'').slice(-4600).trim(),
    origin:location.origin,url:location.origin+location.pathname,
    totalFields:f.length,totalButtons:b.length,
    fields:f.slice(offsetField,offsetField+limit).map((e,i)=>controlInfo(e,i+offsetField)),
    buttons:b.slice(offsetButton,offsetButton+limit).map((e,i)=>buttonInfo(e,i+offsetButton)),
    nextFieldOffset:offsetField+limit<f.length?offsetField+limit:null,
    nextButtonOffset:offsetButton+limit<b.length?offsetButton+limit:null,
    note:'Read-only form metadata plus latest visible page text (last 4600 chars); no input values. Controls beyond 256 are not exposed.'
  };
  // Frontier reply has a strict 16k-byte bound; never let Core truncate JSON.
  let size=JSON.stringify(result).length;
  while(size>11000&&result.text.length>0){
    result.text=result.text.slice(0,Math.max(0,result.text.length-500));
    size=JSON.stringify(result).length;
  }
  while(size>11000&&(result.buttons.length||result.fields.length)){
    if(result.buttons.length>=result.fields.length){result.buttons.pop();result.nextButtonOffset=offsetButton+result.buttons.length;}
    else {result.fields.pop();result.nextFieldOffset=offsetField+result.fields.length;}
    size=JSON.stringify(result).length;
  }
  return result;
};
function checkOrigin(expected,expectedPath){
  if(location.origin!==expected)throw new Error('ORIGIN_CHANGED');
  if(expectedPath!==undefined&&location.pathname!==expectedPath)throw new Error('PAGE_CHANGED_AFTER_APPROVAL');
}
function fill(data){
  checkOrigin(data.expectedOrigin,data.expectedPath);
  if(!Number.isInteger(data.index)||data.index<0||data.index>=MAX_FIELDS)throw new Error('FIELD_INDEX_INVALID');
  const e=fieldNodes()[data.index];
  if(!e)throw new Error('FIELD_NOT_FOUND');
  const info=controlInfo(e,data.index);
  if(info.name!==data.expectedName)throw new Error('FIELD_CHANGED');
  if(info.blocked||e.type==='password')throw new Error('SENSITIVE_FIELD_BLOCKED');
  if(!INPUT_TYPES.has(info.type)&&!['textarea','contenteditable'].includes(info.type))
    throw new Error('FIELD_TYPE_NOT_SUPPORTED');
  if(e.readOnly||e.hasAttribute('readonly'))throw new Error('FIELD_READONLY');
  // Do not overwrite an existing draft. Avoid destroying native React/Vue/ProseMirror state.
  const current=String(e.value??e.innerText??'').trim();
  if(current)throw new Error('FIELD_NOT_EMPTY');
  e.focus();
  if(document.activeElement!==e)throw new Error('FIELD_FOCUS_FAILED');
  return {focused:true,index:data.index,expectedName:info.name,origin:location.origin};
}
function verifyFill(data){
  checkOrigin(data.expectedOrigin,data.expectedPath);
  const e=fieldNodes()[data.index];
  if(!e||fieldName(e)!==data.expectedName)throw new Error('FIELD_CHANGED_AFTER_INPUT');
  return {filled:String(e.value??e.innerText??'')===data.value,
    characters:String(e.value??e.innerText??'').length,index:data.index};
}
function click(data){
  checkOrigin(data.expectedOrigin,data.expectedPath);
  if(!Number.isInteger(data.index)||data.index<0||data.index>=MAX_BUTTONS)
    throw new Error('BUTTON_INDEX_INVALID');
  const e=buttonNodes()[data.index];
  if(!e)throw new Error('BUTTON_NOT_FOUND');
  const info=buttonInfo(e,data.index);
  if(info.text!==data.expectedText)throw new Error('BUTTON_CHANGED');
  if(data.operation==='tab.submit'&&!info.submit)throw new Error('NOT_A_SUBMIT_BUTTON');
  if(data.operation==='tab.click'&&info.submit)throw new Error('USE_EXPLICIT_SUBMIT_ACTION');
  if(e.tagName==='A'&&e.href){
    const u=new URL(e.href);if(u.protocol!=='https:')throw new Error('LINK_PROTOCOL_BLOCKED');
  }
  e.click();
  return {triggered:true,operation:data.operation,index:data.index,
    outcome:'ACTION_TRIGGERED_SITE_ACCEPTANCE_NOT_VERIFIED'};
}
function submitTarget(data){
  checkOrigin(data.expectedOrigin,data.expectedPath);
  if(!Number.isInteger(data.index)||data.index<0||data.index>=MAX_BUTTONS)
    throw new Error('BUTTON_INDEX_INVALID');
  const e=buttonNodes()[data.index];
  if(!e)throw new Error('BUTTON_NOT_FOUND');
  const info=buttonInfo(e,data.index);
  if(info.text!==data.expectedText)throw new Error('BUTTON_CHANGED');
  if(!info.submit)throw new Error('NOT_A_SUBMIT_BUTTON');
  if(e.disabled||!isVisible(e))throw new Error('SUBMIT_BUTTON_NOT_VISIBLE');
  const rect=e.getBoundingClientRect(),x=Math.floor(rect.left+rect.width/2),
    y=Math.floor(rect.top+rect.height/2);
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||
     x>=window.innerWidth||y>=window.innerHeight)
    throw new Error('SUBMIT_BUTTON_OUTSIDE_VIEWPORT');
  // Never send a native input event if an overlay covers the intended control.
  const hit=document.elementFromPoint(x,y);
  if(!hit||(hit!==e&&!e.contains(hit)))throw new Error('SUBMIT_BUTTON_OBSCURED');
  return {x,y,index:data.index,expectedText:info.text};
}
function changeChoice(data){
  checkOrigin(data.expectedOrigin,data.expectedPath);
  const e=fieldNodes()[data.index];
  if(!e)throw new Error('FIELD_NOT_FOUND');
  const info=controlInfo(e,data.index);
  if(info.name!==data.expectedName)throw new Error('FIELD_CHANGED');
  if(info.blocked||e.disabled)throw new Error('SENSITIVE_FIELD_BLOCKED');
  if(data.operation==='tab.choose'){
    if(e.tagName!=='SELECT')throw new Error('SELECT_REQUIRED');
    const option=[...e.options].find(o=>o.value===data.value&&!o.disabled);
    if(!option)throw new Error('OPTION_NOT_FOUND');
    e.value=data.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    return {changed:e.value===data.value,selectedLabel:clip(option.textContent,100)};
  }
  if(!['checkbox','radio'].includes(info.type))throw new Error('CHECKBOX_OR_RADIO_REQUIRED');
  if(info.type==='radio'&&data.checked!==true)throw new Error('RADIO_CANNOT_UNCHECK');
  e.checked=data.checked;
  e.dispatchEvent(new Event('input',{bubbles:true}));
  e.dispatchEvent(new Event('change',{bubbles:true}));
  return {changed:e.checked===data.checked,checked:e.checked};
}
function markFileInput(data){
  checkOrigin(data.expectedOrigin,data.expectedPath);
  const e=fieldNodes()[data.index];
  if(!e||e.type!=='file'||e.tagName!=='INPUT')throw new Error('FILE_INPUT_NOT_FOUND');
  if(fieldName(e)!==data.expectedName)throw new Error('FILE_INPUT_CHANGED');
  if(controlInfo(e,data.index).blocked)throw new Error('SENSITIVE_FILE_FIELD_BLOCKED');
  if(e.files?.length)throw new Error('FILE_ALREADY_ATTACHED');
  e.setAttribute('data-mnemos-file-token',data.nonce);
  return {ready:true,accept:clip(e.accept,120),multiple:!!e.multiple};
}
function fileInputComplete(data){
  checkOrigin(data.expectedOrigin,data.expectedPath);
  const e=fieldNodes()[data.index];
  if(!e||e.getAttribute('data-mnemos-file-token')!==data.nonce||e.type!=='file')
    throw new Error('FILE_INPUT_CHANGED_AFTER_CHOOSER');
  e.removeAttribute('data-mnemos-file-token');
  if(e.files?.length!==1)throw new Error('FILE_ATTACHMENT_NOT_VERIFIED');
  return {attached:true,fileCount:1,fileName:clip(e.files[0]?.name,160),submitted:false,
    note:'File selection may trigger automatic upload on some sites. Server acceptance is not verified.'};
}
function fileInputUnmark(data){
  const e=document.querySelector('input[data-mnemos-file-token="'+data.nonce+'"]');
  if(e)e.removeAttribute('data-mnemos-file-token');
  return {unmarked:true};
}
function makeScript(fn,data){
  // Transport only a bounded, JSON-escaped object into a fixed, auditable function.
  return '(()=>{const clip='+clip.toString()+';const isVisible='+isVisible.toString()+';const inspect='+inspect.toString()+';'+
    [fieldNodes,buttonNodes,fieldName,controlInfo,buttonInfo,
      checkOrigin,fill,verifyFill,click,submitTarget,changeChoice,markFileInput,fileInputComplete,fileInputUnmark].map(x=>x.toString()).join(';')+
    ';const MAX_FIELDS=256,MAX_BUTTONS=256,INPUT_TYPES=new Set(["text","search","email","tel","url","number","date","time"]),'+
    'BLOCKED=/password|secret|token|otp|2fa|verification.?code|credit|card.?number|cvv|cvc|iban|account.?number|captcha|security.?answer|private.?key/i;'+
    'return '+fn+'('+JSON.stringify(data)+');})()';
}
export function validateBrowserAction(input){
  if(!input||typeof input!=='object')throw new Error('INVALID_BROWSER_ACTION');
  const operation=input.operation;
  if(!['tab.describe','tab.fill','tab.choose','tab.toggle','tab.click','tab.submit','tab.attach'].includes(operation))throw new Error('OPERATION_DENIED');
  const expectedOrigin=String(input.expectedOrigin??'');
  const u=new URL(expectedOrigin);
  if(u.protocol!=='https:'||u.origin!==expectedOrigin||u.username||u.password)
    throw new Error('EXPECTED_ORIGIN_REQUIRED');
  const expectedPath=input.expectedPath===undefined?null:String(input.expectedPath);
  if(expectedPath!==null&&(!expectedPath.startsWith('/')||/[?#\\]/.test(expectedPath)||expectedPath.length>900))
    throw new Error('EXPECTED_PATH_INVALID');
  const base={operation,expectedOrigin,...(expectedPath===null?{}:{expectedPath})};
  if(operation==='tab.describe'){
    const fieldOffset=Number(input.fieldOffset??0),buttonOffset=Number(input.buttonOffset??0),limit=Number(input.limit??16);
    if(!Number.isInteger(fieldOffset)||fieldOffset<0||fieldOffset>256||
      !Number.isInteger(buttonOffset)||buttonOffset<0||buttonOffset>256||
      !Number.isInteger(limit)||limit<1||limit>64)throw new Error('INVALID_CONTROL_PAGE');
    return {...base,fieldOffset,buttonOffset,limit};
  }
  const index=input.index;
  if(!Number.isInteger(index)||index<0||index>255)throw new Error('CONTROL_INDEX_INVALID');
  const key=['tab.fill','tab.choose','tab.toggle','tab.attach'].includes(operation)?'expectedName':'expectedText';
  if(typeof input[key]!=='string'||input[key].length<1||input[key].length>120)
    throw new Error('EXPECTED_CONTROL_LABEL_REQUIRED');
  if(operation==='tab.fill'){
    if(typeof input.value!=='string'||input.value.length>2500||!/[\S]/.test(input.value))
      throw new Error('FILL_VALUE_INVALID');
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.value))throw new Error('CONTROL_CHARACTERS_BLOCKED');
    return {...base,index,expectedName:input.expectedName,value:input.value};
  }
  if(operation==='tab.attach')return {...base,index,expectedName:input.expectedName};
  if(operation==='tab.choose'){
    if(typeof input.value!=='string'||input.value.length>90)throw new Error('OPTION_VALUE_INVALID');
    return {...base,index,expectedName:input.expectedName,value:input.value};
  }
  if(operation==='tab.toggle'){
    if(typeof input.checked!=='boolean')throw new Error('CHECKED_BOOLEAN_REQUIRED');
    return {...base,index,expectedName:input.expectedName,checked:input.checked};
  }
  return {...base,index,expectedText:input.expectedText};
}
export async function markBrowserFileInput(wc,input,nonce){
  const data=validateBrowserAction(input);
  if(data.operation!=='tab.attach'||!/^[a-f0-9-]{36}$/i.test(nonce))
    throw new Error('INVALID_FILE_INPUT_REQUEST');
  if(wc.isDestroyed()||new URL(wc.getURL()).origin!==data.expectedOrigin)
    throw new Error('FILE_TAB_ORIGIN_CHANGED');
  return wc.executeJavaScript(makeScript('markFileInput',{...data,nonce}),true);
}
export async function finishBrowserFileInput(wc,input,nonce){
  const data=validateBrowserAction(input);
  if(data.operation!=='tab.attach'||wc.isDestroyed()||
     new URL(wc.getURL()).origin!==data.expectedOrigin)
    throw new Error('FILE_TAB_ORIGIN_CHANGED');
  return wc.executeJavaScript(makeScript('fileInputComplete',{...data,nonce}),true);
}
export async function unmarkBrowserFileInput(wc,nonce){
  if(wc.isDestroyed())return;
  try{await wc.executeJavaScript(makeScript('fileInputUnmark',{nonce}),true);}catch{}
}
export async function performBrowserAction(wc,input,{authorize=null,assertCurrent=null}={}){
  const data=validateBrowserAction(input);
  if(wc.isDestroyed())throw new Error('TAB_DESTROYED');
  const check=()=>{assertCurrent?.();const u=new URL(wc.getURL());if(u.origin!==data.expectedOrigin||u.protocol!=='https:')throw new Error('TAB_ORIGIN_CHANGED');
    if(data.expectedPath!==undefined&&u.pathname!==data.expectedPath)throw new Error('PAGE_CHANGED_AFTER_APPROVAL');};
  check();
  if(data.operation==='tab.attach')throw new Error('NATIVE_FILE_CHOOSER_REQUIRED');
  if(data.operation==='tab.describe'){
    const result=await wc.executeJavaScript(makeScript('inspect',data),true);
    check();if(JSON.stringify(result).length>12000)throw new Error('CONTROL_PAGE_TOO_LARGE');
    return result;
  }
  if(data.operation==='tab.fill'){
    if(authorize)await authorize();
    check();
    const focused=await wc.executeJavaScript(makeScript('fill',data),true);
    if(!focused.focused)throw new Error('FOCUS_NOT_VERIFIED');
    check();await wc.insertText(data.value);await new Promise(resolve=>setTimeout(resolve,150));
    check();
    const result=await wc.executeJavaScript(makeScript('verifyFill',data),true);
    if(!result.filled)throw new Error('FILL_NOT_VERIFIED');
    return {filled:true,index:data.index,characters:result.characters,submitted:false};
  }
  if(['tab.choose','tab.toggle'].includes(data.operation)){
    if(authorize)await authorize();
    check();
    const selected=await wc.executeJavaScript(makeScript('changeChoice',data),true);
    check();
    if(!selected.changed)throw new Error('CHOICE_CHANGE_NOT_VERIFIED');
    return {...selected,index:data.index,submitted:false};
  }
  if(data.operation==='tab.submit'){
    if(typeof wc.sendInputEvent!=='function')throw new Error('NATIVE_SUBMIT_INPUT_UNAVAILABLE');
    // Read only metadata for an editor-state observation. Never read or log draft
    // values, and never retry based on an inconclusive observation.
    let filledEditors=[];
    try{
      const before=await wc.executeJavaScript(makeScript('inspect',{
        operation:'tab.describe',expectedOrigin:data.expectedOrigin,
        expectedPath:data.expectedPath,fieldOffset:0,buttonOffset:0,limit:64
      }),true);
      filledEditors=before.fields.filter(f=>
        ['contenteditable','textarea'].includes(f.type)&&f.filled===true&&f.blocked===false)
        .map(f=>({index:f.index,name:f.name}));
    }catch{}
    if(authorize)await authorize();
    const target=await wc.executeJavaScript(makeScript('submitTarget',data),true);
    check();
    // Electron native mouse events behave like user input; element.click() may be
    // ignored by chat editors that require trusted pointer events.
    // One down/up sequence only, never retry after an ambiguous result.
    wc.sendInputEvent({type:'mouseMove',x:target.x,y:target.y});
    wc.sendInputEvent({type:'mouseDown',x:target.x,y:target.y,button:'left',clickCount:1});
    wc.sendInputEvent({type:'mouseUp',x:target.x,y:target.y,button:'left',clickCount:1});
    let editorCleared=null;
    if(filledEditors.length){
      // A cleared composer is useful local evidence of dispatch, not proof of
      // server-side acceptance. Do NOT click a second time if it stays filled.
      for(const delay of [200,400,600]){
        await new Promise(resolve=>setTimeout(resolve,delay));
        try{
          check();
          const described=await wc.executeJavaScript(makeScript('inspect',{
            operation:'tab.describe',expectedOrigin:data.expectedOrigin,
            expectedPath:data.expectedPath,fieldOffset:0,buttonOffset:0,limit:64
          }),true);
          if(filledEditors.some(f=>described.fields.some(g=>
            g.index===f.index&&g.name===f.name&&g.filled===false))){
            editorCleared=true;break;
          }
          editorCleared=false;
        }catch{editorCleared=null;break;}
      }
    }
    return {triggered:true,operation:'tab.submit',index:data.index,
      method:'NATIVE_POINTER_SINGLE_ATTEMPT',submitted:true,
      editorCleared,verifiedSubmission:false,
      outcome:editorCleared===true?
        'NATIVE_CLICK_AND_COMPOSER_CLEARED_SERVER_UNVERIFIED':
        'NATIVE_CLICK_DISPATCHED_DELIVERY_UNVERIFIED'};
  }
  if(authorize)await authorize();
  check();
  const result=await wc.executeJavaScript(makeScript('click',data),true);
  return {...result,submitted:false,verifiedSubmission:false};
}
