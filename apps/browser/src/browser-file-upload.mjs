/**
 * File selection in the logged-in Chromium tab.
 * Remote agents never supply a local path. User chooses ONE file via native OS picker.
 * Chromium CDP is used internally only for DOM.setFileInputFiles on that exact input.
 * No general debugger/CDP command is exposed through IPC, MCP, or Frontier Bus.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { validateBrowserAction, markBrowserFileInput, finishBrowserFileInput, unmarkBrowserFileInput } from './browser-actions.mjs';

const LIMIT=15*1024*1024;
const ALLOWED=new Set(['.pdf','.doc','.docx','.txt','.rtf','.odt','.png','.jpg','.jpeg']);
const FILE_INPUT_SELECTOR=nonce=>'input[type="file"][data-mnemos-file-token="'+nonce+'"]';
const MIME={
  '.pdf':'application/pdf','.doc':'application/msword',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt':'text/plain','.rtf':'application/rtf',
  '.odt':'application/vnd.oasis.opendocument.text',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'
};
function acceptedByField(accept,ext){
  if(!accept?.trim())return true;
  const pieces=accept.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  const mime=MIME[ext];
  return pieces.some(x=>x===ext||x===mime||(x==='image/*'&&mime.startsWith('image/'))||
    (x==='text/*'&&mime.startsWith('text/')));
}

export async function attachBrowserFile(wc,action,{showOpenDialog,ownerWindow,authorize=null}={}){
  const request=validateBrowserAction(action);
  if(request.operation!=='tab.attach')throw new Error('NATIVE_FILE_CHOOSER_REQUIRED');
  if(typeof showOpenDialog!=='function')throw new Error('NATIVE_FILE_CHOOSER_UNAVAILABLE');
  if(wc.isDestroyed()||!wc.debugger)throw new Error('CHROMIUM_TAB_UNAVAILABLE');
  const original=wc.getURL();
  if(new URL(original).origin!==request.expectedOrigin)throw new Error('TAB_ORIGIN_CHANGED');

  const nonce=randomUUID();
  let attached=false;
  try{
    const ready=await markBrowserFileInput(wc,request,nonce);
    if(!ready?.ready)throw new Error('FILE_INPUT_NOT_AVAILABLE');
    // The user chooses the file. The remote model never supplies or sees its disk path.
    const dialogResult=await showOpenDialog(ownerWindow,{
      title:'MNEMOS Browser — izvēlies VIENU failu pievienošanai vietnei',
      buttonLabel:'Pievienot failu (vietne var to augšupielādēt uzreiz)',
      properties:['openFile'],
      filters:[
        {name:'CV, dokumenti un attēli',extensions:['pdf','doc','docx','txt','rtf','odt','png','jpg','jpeg']}
      ]
    });
    if(dialogResult.canceled||dialogResult.filePaths?.length!==1)
      return {attached:false,cancelled:true,submitted:false};
    const file=dialogResult.filePaths[0];
    if(typeof file!=='string'||!path.isAbsolute(file)||!ALLOWED.has(path.extname(file).toLowerCase()))
      throw new Error('FILE_TYPE_NOT_ALLOWED');
    if(!acceptedByField(ready.accept,path.extname(file).toLowerCase()))
      throw new Error('FILE_NOT_ACCEPTED_BY_SITE_FIELD');
    const info=await stat(file);
    if(!info.isFile()||info.size<1||info.size>LIMIT)throw new Error('FILE_SIZE_OR_TYPE_REJECTED');
    if(wc.isDestroyed()||wc.getURL()!==original)throw new Error('TAB_CHANGED_DURING_FILE_SELECTION');
    if(wc.debugger.isAttached())throw new Error('DEVTOOLS_ALREADY_ATTACHED');
    let debuggerAttached=false;
    try{
      wc.debugger.attach('1.3');debuggerAttached=true;
      const tree=await wc.debugger.sendCommand('DOM.getDocument',{depth:0,pierce:false});
      const node=await wc.debugger.sendCommand('DOM.querySelector',{
        nodeId:tree.root.nodeId,selector:FILE_INPUT_SELECTOR(nonce)});
      if(!node?.nodeId)throw new Error('FILE_INPUT_CHANGED');
      if(authorize)await authorize();
      if(wc.getURL()!==original)throw new Error('TAB_CHANGED_DURING_FILE_SELECTION');
      await wc.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]});
    }finally{
      if(debuggerAttached&&wc.debugger.isAttached())wc.debugger.detach();
    }
    const verified=await finishBrowserFileInput(wc,request,nonce);
    if(verified?.fileCount!==1||verified?.fileName!==path.basename(file))
      throw new Error('FILE_ATTACHMENT_COULD_NOT_BE_VERIFIED');
    attached=true;
    return {attached:true,fileName:verified.fileName,fileCount:1,
      bytes:info.size,submitted:false,siteAccepted:false,
      note:'File field populated. Website may auto-upload; server-side acceptance is unverified.'};
  }finally{
    if(!attached)await unmarkBrowserFileInput(wc,nonce);
  }
}
