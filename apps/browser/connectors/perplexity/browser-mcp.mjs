/**
 * MCP exposure of the already logged-in MNEMOS Browser session.
 * NO cookie export, raw JS, filesystem, playwright CDP, or unbounded submissions.
 * All calls return asynchronous receipts. Reading and ordinary draft/navigation actions
 * do not prompt. Exact trusted AI-chat prompts may be delegated without an extra prompt;
 * other form submissions need explicit owner confirmation;
 * file attachment needs a native OS file choice (which may auto-upload).
 */
export function registerBrowserTools({server,z,getGateway}){
  const register=(name,title,description,inputSchema,create,readOnly)=>{
    server.registerTool(name,{title,description,inputSchema,
      annotations:{readOnlyHint:readOnly,openWorldHint:false,destructiveHint:false}},
    async args=>{
      try {
        const result=await create(args);
        return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
      }catch(e){return {isError:true,content:[{type:'text',text:String(e?.message??e).slice(0,180)}]};}
    });
  };
  const tabId=z.string().uuid();
  const origin=z.string().url().max(260);
  const label=z.string().min(1).max(120);
  const index=z.number().int().min(0).max(255);
  const common='Targets the USER-AUTHENTICATED MNEMOS Browser tab, NOT a headless browser. Returns a requestToken; call mnemos_browser_result to check. Remote changes require a scoped Core grant. Reading does not require a grant. Trusted ChatGPT/Gemini/Perplexity prompt controls may submit without an extra dialog after the browser validates the filled composer. Other form submissions require explicit owner confirmation. Attaching a file requires selecting it in the native OS picker. ';
  register('mnemos_browser_tabs','List authenticated MNEMOS Browser tabs',
    common+'List non-private tab IDs and origin-safe URLs. No session cookies or stored secrets.',
    {},()=>getGateway().request({operation:'tabs.list'}),true);
  register('mnemos_browser_read','Read chat answers or describe form controls',
    common+'mode=answer reads one 6k-character page of the latest visible ChatGPT/Gemini/Perplexity assistant DOM candidate, or a clearly labeled fallback page-text slice. Use answerOffset to retrieve further pages up to 32768 characters. Not fact-checked; response provenance may be uncertain. mode=describe returns bounded control metadata without input values; mode=inspect returns first 6000 visible characters.',
    {tabId,expectedOrigin:origin,mode:z.enum(['describe','inspect','answer']).default('describe'),
      answerOffset:z.number().int().min(0).max(32768).default(0),
      answerLength:z.number().int().min(1).max(7000).default(6000),
      fieldOffset:z.number().int().min(0).max(256).default(0),
      buttonOffset:z.number().int().min(0).max(256).default(0),
      limit:z.number().int().min(1).max(64).default(16)},
    a=>getGateway().request({operation:a.mode==='inspect'?'tab.inspect':a.mode==='answer'?'tab.answer':'tab.describe',
      tabId:a.tabId,expectedOrigin:a.expectedOrigin,
      ...(a.mode==='inspect'?{}:a.mode==='answer'?
        {offset:a.answerOffset,length:a.answerLength}:
        {fieldOffset:a.fieldOffset,buttonOffset:a.buttonOffset,limit:a.limit})}),true);
  register('mnemos_browser_fill','Fill an EMPTY form input without submitting',
    common+'Use index and expectedName obtained from mnemos_browser_read. No passwords, verification, payment details, hidden or pre-filled controls. Filling does NOT submit the form.',
    {tabId,expectedOrigin:origin,index,expectedName:label,value:z.string().min(1).max(2500)},
    a=>getGateway().request({operation:'tab.fill',...a}),false);
  register('mnemos_browser_attach','Attach one user-selected file to a form',
    common+'HIGH IMPACT: the user MUST choose the file in the native Windows Open dialog. The file picker is the consent gate; no extra modal is shown. The remote AI cannot specify any local path or receive the file contents. A site MAY auto-upload the file on selection. Only PDF/DOC/DOCX/TXT/RTF/ODT/PNG/JPEG up to 15 MiB. Use index and expectedName from mnemos_browser_read. External server acceptance is NOT verified.',
    {tabId,expectedOrigin:origin,index,expectedName:label},
    a=>getGateway().request({operation:'tab.attach',...a}),false);
  register('mnemos_browser_choose','Choose an option in a dropdown',
    common+'Use an index, expectedName and exact option value from mnemos_browser_read. No owner confirmation required. Does not explicitly submit the form.',
    {tabId,expectedOrigin:origin,index,expectedName:label,value:z.string().max(90)},
    a=>getGateway().request({operation:'tab.choose',...a}),false);
  register('mnemos_browser_toggle','Set checkbox/radio without a confirmation dialog',
    common+'Use field index and expectedName from mnemos_browser_read. The checked state must be boolean; radio buttons can only be checked, not unchecked. Does not submit.',
    {tabId,expectedOrigin:origin,index,expectedName:label,checked:z.boolean()},
    a=>getGateway().request({operation:'tab.toggle',...a}),false);
  register('mnemos_browser_click','Click a non-submit button or link',
    common+'No confirmation for non-submit controls. The operation can navigate or change website state; it does NOT certify the external action succeeded. For submit buttons use mnemos_browser_submit.',
    {tabId,expectedOrigin:origin,index,expectedText:label},
    a=>getGateway().request({operation:'tab.click',...a}),false);
  register('mnemos_browser_submit','Submit a verified AI prompt or owner-approved external form',
    common+'HIGH IMPACT: Trusted AI-chat prompt submission is delegated if a known model-chat page has one filled composer and one exact send button. Other submissions require native human confirmation. Result means input dispatched, not service acceptance. Never auto-retry.',
    {tabId,expectedOrigin:origin,index,expectedText:label},
    a=>getGateway().request({operation:'tab.submit',...a}),false);
  register('mnemos_browser_open','Open a new HTTPS tab without confirmation',common+
    'Opens one HTTPS tab in a project with an active Core grant. Defaults to mnemos.',
    {url:z.string().url().max(900),project:z.string().regex(/^[a-zA-Z0-9_-]{1,90}$/).optional()},
    a=>getGateway().request({operation:'tab.open',url:a.url,project:a.project}),false);
  register('mnemos_browser_select','Select an existing tab without confirmation',common+
    'Switches the active tab in the visible MNEMOS Browser.',
    {tabId},a=>getGateway().request({operation:'tab.select',tabId:a.tabId}),false);
  register('mnemos_browser_result','Check authenticated browser action outcome',
    'Poll one requestToken returned by mnemos_browser_* tools. A pending response means the browser has not executed it yet, or a submission is awaiting confirmation. A submitted=true result means only submission was triggered, not necessarily accepted.',
    {requestToken:z.string().min(130).max(190)},
    a=>getGateway().result(a.requestToken),true);
}
