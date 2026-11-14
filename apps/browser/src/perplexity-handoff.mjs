// Explicit, bounded, one-shot project context handoff to the Perplexity web composer.
// This is NOT an MCP connection. It never sends a message or exposes browser secrets.
const CUT = 3600;
const text = (s, n = 160) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const safeTitles = (items, kind, projectId, count = 5) =>
  (items ?? []).filter(item => item.project === projectId && item.kind === kind)
    .slice(0, count).map(item => ({
      title: text(item.title, 145), status: text(item.status, 32)
    }));

export function perplexityAllowedUrl(input, fixtureOrigin = null) {
  try {
    const u = new URL(input);
    if (fixtureOrigin && u.origin === fixtureOrigin && u.pathname.startsWith('/handoff-fixture'))
      return true;
    return u.protocol === 'https:' &&
      (u.hostname === 'perplexity.ai' || u.hostname === 'www.perplexity.ai') &&
      !u.username && !u.password && (!u.port || u.port === '443');
  } catch { return false; }
}

export function buildPerplexityHandoff({core, workspace, projectId, at = new Date().toISOString()}) {
  const current = (workspace?.projects ?? []).find(p => p.id === projectId);
  if (!current) throw new Error('PROJECT_NOT_FOUND');
  const local = (workspace.items ?? []).filter(item => item.project === projectId);
  const data = {
    source: 'MNEMOS Browser local snapshot',
    observedAt: at,
    type: 'User-reviewed one-shot context; NOT a live MCP/API connection',
    application: {
      name: 'MNEMOS',
      description: 'Privately operated local AI/agent orchestration and memory system with a browser front end.',
      browser: 'MNEMOS Browser, Electron/Chromium',
      core: core?.online === true ? {
        status: 'reachable',
        version: text(core.service?.version, 65) || null,
        snapshotAt: text(core.capturedAt, 50) || null
      } : {status:'unavailable at snapshot time'}
    },
    selectedProject: {
      name: text(current.name, 100),
      goals: safeTitles(local,'goal',projectId),
      tasks: safeTitles(local,'task',projectId),
      memoryRecordsNotShared:local.filter(x=>x.kind==='memory').length
    },
    coreProjection:core?.online === true ? {
      goals: (core.goals ?? []).slice(0, 3).map(x => ({title:text(x.title,130),status:text(x.status,25)})),
      tasks: (core.tasks ?? []).slice(0, 3).map(x => ({title:text(x.title,130),status:text(x.status,25)})),
      frontierSessions: Number.isFinite(core.bus?.activeSessions) ? core.bus.activeSessions : null
    } : null
  };
  const serialized=JSON.stringify(data);
  if (serialized.length > CUT) throw new Error('HANDOFF_CONTEXT_TOO_LARGE');
  return [
    'Šis ir mans lokālās MNEMOS sistēmas konteksta izraksts, kuru sagatavoja MNEMOS Browser.',
    'NEDRĪKST apgalvot, ka tev ir tiešs MCP savienojums vai piekļuve MNEMOS rīkiem.',
    'Izmanto šos datus kā lietotāja sniegtu faktu kontekstu, nevis kā tiešu piekļuvi sistēmai.',
    'Paskaidro, ko saprati par manu MNEMOS projektu, un norādi, kas nepieciešams īstai MCP integrācijai.',
    '',
    'MNEMOS_CONTEXT_JSON:',
    serialized
  ].join('\n');
}

// Executed inside the target tab only after user's explicit approval.
// Native webContents.insertText emits a Chromium text-input event for framework editors.
// Does not click Send and refuses to overwrite an existing draft.

export const focusEmptyPerplexityComposer = "(()=>{const eligible=[...document.querySelectorAll('[contenteditable=\"true\"],textarea')].filter(node=>{if(node.closest('[hidden],[aria-hidden=\"true\"]'))return false;const style=getComputedStyle(node),rect=node.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>40&&rect.height>14;});const field=eligible.find(node=>node.getAttribute('role')==='textbox')||eligible.find(node=>node.getAttribute('data-placeholder')!==null)||eligible.find(node=>node.isContentEditable)||eligible.find(node=>node.tagName==='TEXTAREA');if(!field)return {ok:false,error:'PERPLEXITY_COMPOSER_NOT_FOUND'};const existing=(field.tagName==='TEXTAREA'?field.value:field.innerText)||'';if(existing.trim())return {ok:false,error:'PERPLEXITY_DRAFT_NOT_EMPTY'};field.focus();if(document.activeElement!==field)return {ok:false,error:'PERPLEXITY_COMPOSER_FOCUS_FAILED'};return {ok:true,tag:field.tagName};})()";
