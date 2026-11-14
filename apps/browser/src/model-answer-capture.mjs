/**
 * Provider-scoped, read-only web chat extraction. No network, page-script access,
 * credentials, input values, or unsolicited interaction. DOM messages and fallback
 * page slices are always UNVERIFIED, not factual or semantic consensus.
 */
export const MAX_ANSWER_CAPTURE=32768;

export function modelAnswerExtractionScript(model,{prompt='',maxChars=MAX_ANSWER_CAPTURE}={}){
  if(!['ChatGPT','Gemini','Perplexity'].includes(model))
    throw new Error('COORDINATION_UNKNOWN_MODEL');
  if(typeof prompt!=='string'||prompt.length>2500||
     !Number.isInteger(maxChars)||maxChars<512||maxChars>MAX_ANSWER_CAPTURE)
    throw new Error('COORDINATION_CAPTURE_ARGS_INVALID');
  const selectors={
    ChatGPT:[
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]'
    ],
    Gemini:[
      'model-response .markdown',
      'model-response .model-response-text',
      'model-response',
      '[data-test-id="model-response"]'
    ],
    Perplexity:[
      '[data-testid="answer-content"]',
      '[data-testid="answer"] .prose',
      '[data-testid="answer"]',
      '[data-testid="assistant-response"]',
      '[data-testid*="answer-content"]',
      '[data-message-author-role="assistant"]'
    ]
  };
  return '('+function extractChatText(options){
    const norm=value=>String(value??'').replace(/\u0000/g,'').replace(/\r\n?/g,'\n').trim();
    const readElement=e=>norm(e.innerText??e.textContent??'');
    const body=norm(document.body?.innerText||'');
    const result={
      title:norm(document.title).slice(0,180),
      text:body.slice(-options.limit),bodyChars:body.length,
      bodyTruncated:body.length>options.limit,
      answer:'',answerChars:0,answerTruncated:false,
      kind:'PAGE_TEXT_ONLY',selector:null,candidates:0,
      busy:false,promptFound:false,assistantAfterPrompt:false,completionVisible:false
    };
    // Read-only heuristic: a visible Stop generation control is evidence of
    // streaming, but its absence is NOT proof of completion.
    const stopWords=/^(?:stop|stop generating|stop generation|stop response|pārtraukt|apturēt|pārtraukt ģenerēšanu)$/i;
    const buttons=[...document.querySelectorAll('button,[role="button"]')].slice(-256);
    result.busy=buttons.some(e=>
      stopWords.test(norm(e.getAttribute?.('aria-label')||e.innerText||e.title||'').slice(0,90)));
    for(const selector of options.selectors){
      const elements=[...document.querySelectorAll(selector)].slice(-120);
      const pieces=elements.map(readElement).filter(t=>t.length>=2);
      if(!pieces.length)continue;
      const candidate=pieces.at(-1);
      // Some providers render user and assistant text in a single wrapper.
      // If the isolated block is simply the user's prompt, reject it.
      if(options.prompt&&candidate===options.prompt)continue;
      result.answerChars=candidate.length;
      result.answer=candidate.slice(-options.limit);
      result.answerTruncated=candidate.length>options.limit;
      result.kind='ASSISTANT_DOM_CANDIDATE';
      result.selector=selector;
      result.candidates=pieces.length;
      break;
    }
    if(options.prompt&&options.model==='ChatGPT'&&!result.busy){
      // A final-answer UI marker can be present even when the provider has
      // reflowed/hidden the original prompt or changed its assistant wrappers.
      // Keep this as metadata only: it must NOT become an assistant answer.
      const finishedUi=/ChatGPT var pieļaut kļūdas\.[^\n]*\n\s*Pēdējā atbilde(?:\s|$)/i.test(body)||
        /ChatGPT can make mistakes\.[^\n]*\n\s*(?:Latest answer|Last answer)(?:\s|$)/i.test(body);
      if(finishedUi)result.completionVisible=true;
      // Localized ChatGPT collapses long user prompts behind "Rādīt vairāk".
      // Recover only the LAST user turn followed by a finished assistant turn.
      // This is unverified provider text, not a trusted model-role DOM node.
      const users=[...body.matchAll(/(?:^|\n)(?:Tu teici:|You said:)\s*\n/g)];
      const user=users.at(-1);
      if(user){
        const after=body.slice(user.index+user[0].length);
        const reply=[...after.matchAll(/(?:^|\n)(?:ChatGPT teica:|ChatGPT said:)\s*\n/g)][0];
        const compact=value=>String(value??'').replace(/\s+/gu,' ').trim();
        const expectedPrefix=compact(options.prompt).slice(0,105);
        if(reply&&expectedPrefix.length>=35&&compact(after.slice(0,reply.index)).includes(expectedPrefix)){
          const output=after.slice(reply.index+reply[0].length);
          const endMarks=[...output.matchAll(/\n(?:Vai tev patīk šī personība\?|ChatGPT var pieļaut kļūdas\.|ChatGPT can make mistakes\.|Atbilde pabeigta|Response complete)(?:\n|$)/gi)];
          const cut=endMarks.length?Math.min(...endMarks.map(m=>m.index)):output.length;
          const answer=output.slice(0,cut).trim();
          const footer=output.slice(cut);
          // 2026-11 ChatGPT can drop the old "Atbilde pabeigta"
          // control entirely after finalizing a High-effort response.
          // The live localized UI instead shows:
          // "ChatGPT var pieļaut kļūdas..." then "Pēdējā atbilde"
          // and "Domāšanas līmenis / 6 Augsts".
          // Require an assistant turn, actual footer AND final-answer marker,
          // and no active stop-generation button (checked above).
          const explicitDone=/(?:Atbilde pabeigta|Response complete)/i.test(footer);
          const finishedUi=/ChatGPT var pieļaut kļūdas\.[^\n]*\n\s*Pēdējā atbilde(?:\s|$)/i.test(footer)||
            /ChatGPT can make mistakes\.[^\n]*\n\s*(?:Latest answer|Last answer)(?:\s|$)/i.test(footer);
          result.completionVisible=explicitDone||finishedUi;
          if(result.completionVisible&&answer.length>=50&&answer.length<=options.limit&&answer!==options.prompt){
            result.promptFound=true;result.assistantAfterPrompt=true;
            if(result.kind==='PAGE_TEXT_ONLY'){
              result.answer=answer;result.answerChars=answer.length;
              result.answerTruncated=false;
              result.kind='CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE';
              result.selector='chatgpt:last-user-followed-by-assistant';
              result.text=answer;
            }
          }
        }
      }
    }
    if(options.prompt){
      // The whole-page projection can still help when Perplexity changes its DOM.
      // The prompt-relative tail is explicitly NOT classified as a model answer.
      const pos=body.lastIndexOf(options.prompt);
      // Real Perplexity input can reflow spaces/newlines; do not lose the
      // ORIGINAL line boundaries when matching a whitespace-normalized prompt.
      // The old fallback used the normalized one-line body as "tail" and could
      // never find the newline-anchored "Pabeigts" or composer markers.
      const normalizedPrompt=options.prompt.replace(/\s+/gu,' ').trim();
      const normalizedBoundary=(raw,expected)=>{
        if(!expected)return -1;
        let compact='',ends=[];
        for(let i=0;i<raw.length;i++){
          const c=raw[i];
          if(/\s/u.test(c)){
            if(!compact||compact.at(-1)!==' '){
              if(compact){compact+=' ';ends.push(i+1);}
            }else ends[ends.length-1]=i+1;
          }else{compact+=c;ends.push(i+1);}
        }
        const start=compact.lastIndexOf(expected);
        return start<0?-1:ends[start+expected.length-1];
      };
      const promptEnd=pos>=0?pos+options.prompt.length:
        normalizedBoundary(body,normalizedPrompt);
      if(promptEnd>=0){
        result.promptFound=true;
        // A prior assistant answer elsewhere in this thread must not be
        // accepted as a reply to the current, visibly posted prompt.
        if(result.kind==='ASSISTANT_DOM_CANDIDATE'){
          const compact=value=>String(value??'').replace(/\s+/g,' ').trim();
          const page=compact(body),question=compact(options.prompt),answer=compact(result.answer);
          const questionAt=page.lastIndexOf(question),answerAt=answer?page.lastIndexOf(answer):-1;
          result.assistantAfterPrompt=questionAt>=0&&answerAt>questionAt;
        }
        if(!['ASSISTANT_DOM_CANDIDATE','CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE','GEMINI_STABLE_TURN_TEXT_CANDIDATE'].includes(result.kind)){
          const tail=body.slice(promptEnd);
          // Gemini's authenticated conversation currently renders the newest
          // assistant turn with an explicit "Gemini said" boundary. Older
          // model-response CSS selectors may be absent. Accept only the
          // assistant text IMMEDIATELY after this exact last posted prompt;
          // never a prior assistant or a cited "Gemini said" in user text.
          // This stays unverified provider text, requiring stable observations.
          if(options.model==='Gemini'&&!result.busy){
            const lead=/^\s*Gemini said\s*\n/iu.exec(tail);
            if(lead){
              const following=tail.slice(lead[0].length);
              const next=/\n(?:You said\b|Gemini said\b|Jūs teicāt\b|Gemini atbildēja\b)/iu.exec(following);
              const answer=(next?following.slice(0,next.index):following).trim();
              if(answer.length>=85&&answer.length<=options.limit&&
                 /[.!?…][”"'’)?\]]?$/u.test(answer)&&
                 !/^\s*(?:Thinking|Domā|Generating)\b/iu.test(answer)){
                result.answer=answer;
                result.answerChars=answer.length;
                result.answerTruncated=false;
                result.kind='GEMINI_STABLE_TURN_TEXT_CANDIDATE';
                result.selector='gemini:current-prompt-followed-by-gemini-said';
                result.assistantAfterPrompt=true;
                result.text=answer;
              }
            }
          }
          // Perplexity's current authenticated layout can render its finished
          // assistant text outside the old data-testid selectors. Use a
          // provider-specific, strict completion + exact prompt + composer
          // anchor. Generic text after the prompt is never an assistant answer.
          // This remains UNVERIFIED_PROVIDER_TEXT, not trusted model metadata.
          if(options.model==='Perplexity'&&!result.busy){
            const done=/(?:^|\n)(?:Pabeigts|Completed|Done)\s*\n(?:\s*\d+\s*(?:s|sec|sek\.)\s*\n)?\s*/gi;
            const marks=[...tail.matchAll(done)];
            const marker=marks.at(-1);
            if(marker){
              result.completionVisible=true;
              const remainder=tail.slice(marker.index+marker[0].length);
              const editorMark=/\n(?:Uzdodiet papildjautājumu|Ask a follow-up|Ask anything)\s*(?:\n|$)/i;
              const editor=editorMark.exec(remainder);
              if(editor){
                const area=remainder.slice(0,editor.index).trim();
                const parts=area.split(/\n\s*\n+/).map(s=>s.trim()).filter(Boolean);
                const answerParts=[];
                // Suggestion chips are a trailing paragraph with several
                // short lines and no terminal punctuation: don't relay them.
                for(const part of parts){
                  if(part.length<35||!/[.!?…][”"')\]]?$/u.test(part))break;
                  answerParts.push(part);
                }
                const answer=answerParts.join('\n\n').trim();
                if(answer.length>=80&&answer.length<=options.limit&&answerParts.length<=10){
                  result.answer=answer;
                  result.answerChars=answer.length;
                  result.kind='PERPLEXITY_COMPLETED_TEXT_CANDIDATE';
                  result.selector='perplexity:completed-prompt-and-editor';
                  result.assistantAfterPrompt=true;
                  result.text=answer;
                }
              }
            }
          }
          if(!['PERPLEXITY_COMPLETED_TEXT_CANDIDATE','CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE','GEMINI_STABLE_TURN_TEXT_CANDIDATE'].includes(result.kind)&&tail.trim().length>=5){
            result.text=tail.slice(-options.limit).trimStart();
            result.kind='PAGE_TEXT_AFTER_PROMPT';
            result.bodyTruncated=tail.length>options.limit;
          }
        }
      }
    }
    return result;
  }.toString()+')('+JSON.stringify({model,selectors:selectors[model],prompt,maxChars,limit:maxChars})+')';
}

/** Scoped, read-only check of the exact user-visible prompt before a single approved send.
 * The value stays in the local Electron main process, never goes through Frontier Bus.
 */
export function preparedDraftTextScript({index,expectedName}){
  if(!Number.isInteger(index)||index<0||index>255||
     typeof expectedName!=='string'||!expectedName||expectedName.length>120)
    throw new Error('COORDINATION_DRAFT_FIELD_INVALID');
  return '('+function readPreparedDraft(input){
    const visible=e=>{
      const b=e.getBoundingClientRect(),s=getComputedStyle(e);
      return b.width>2&&b.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&
        !e.closest('[hidden],[aria-hidden="true"],[inert]');
    };
    const nodes=[...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')]
      .filter(e=>!e.disabled&&(visible(e)||(e.tagName==='INPUT'&&e.type==='file')))
      .slice(0,256);
    const e=nodes[input.index];
    if(!e)throw new Error('COORDINATION_DRAFT_FIELD_MISSING');
    const name=String(e.getAttribute('aria-label')||e.labels?.[0]?.innerText||
      (e.id?document.querySelector('label[for="'+CSS.escape(e.id)+'"]')?.innerText:'')||
      e.getAttribute('placeholder')||e.getAttribute('name')||e.id||e.tagName)
      .trim().slice(0,100);
    const type=(e.getAttribute('type')??(e.isContentEditable?'contenteditable':e.tagName)).toLowerCase();
    if(name!==input.expectedName||!['contenteditable','textarea'].includes(type)||
       !visible(e)||e.readOnly)
      throw new Error('COORDINATION_DRAFT_FIELD_CHANGED');
    const value=String(e.value??e.innerText??'');
    if(!value||value.length>2600)throw new Error('COORDINATION_DRAFT_VALUE_INVALID');
    return {name,characters:value.length,text:value};
  }.toString()+')('+JSON.stringify({index,expectedName})+')';
}

