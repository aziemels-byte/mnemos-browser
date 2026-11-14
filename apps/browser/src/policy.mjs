import net from 'node:net';

export const APP_ORIGIN = 'mnemos://app';
export const APP_URL = `${APP_ORIGIN}/index.html`;
export const WEB_PREFERENCES = Object.freeze({
  sandbox: true, contextIsolation: true, nodeIntegration: false,
  nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
  webviewTag: false, spellcheck: false, navigateOnDragDrop: false
});
export const PROVIDERS = Object.freeze([
  { id: 'ollama', name: 'Ollama', mode: 'local-api', available: true, paid: false },
  { id: 'chatgpt', name: 'ChatGPT', mode: 'manual-web', url: 'https://chatgpt.com/', available: true, paid: false },
  { id: 'claude', name: 'Claude', mode: 'manual-web', url: 'https://claude.ai/', available: true, paid: false },
  { id: 'gemini', name: 'Gemini', mode: 'manual-web', url: 'https://gemini.google.com/', available: true, paid: false },
  { id: 'perplexity', name: 'Perplexity', mode: 'manual-web', url: 'https://www.perplexity.ai/', available: true, paid: false },
  { id: 'openai-api', name: 'OpenAI API', mode: 'official-api', available: false, paid: true, reason: 'Šajā versijā nav aktivizēts' },
  { id: 'anthropic-api', name: 'Anthropic API', mode: 'official-api', available: false, paid: true, reason: 'Šajā versijā nav aktivizēts' },
  { id: 'gemini-api', name: 'Gemini API', mode: 'official-api', available: false, paid: true, reason: 'Šajā versijā nav aktivizēts' }
]);
export function isPrivateHost(input) {
  const host = String(input).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (net.isIPv4(host)) {
    const [a,b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(host)) {
    if (host.startsWith('::ffff:')) {
      const tail = host.slice(7);
      if (tail.includes('.')) return isPrivateHost(tail);
      const parts = tail.split(':');
      if (parts.length === 2) { const n = (parseInt(parts[0],16)*65536)+parseInt(parts[1],16); return isPrivateHost([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.')); }
    }
    return host === '::' || host === '::1' || /^(fc|fd|fe[89ab]|ff)/i.test(host);
  }
  return false;
}
export function validateWebURL(input, { fixtureOrigin = null } = {}) {
  let url;
  try { url = new URL(String(input)); } catch { throw new Error('Nederīga tīmekļa adrese'); }
  if (url.username || url.password) throw new Error('Adrese ar paroli nav atļauta');
  if (fixtureOrigin && url.origin === fixtureOrigin && url.protocol === 'http:') return url.href;
  if (url.protocol !== 'https:') throw new Error('Atļautas tikai HTTPS tīmekļa adreses');
  if (isPrivateHost(url.hostname)) throw new Error('Tīmekļa cilnēm nav piekļuves lokālajam tīklam');
  if (url.port && url.port !== '443') throw new Error('Nestandarta tīkla ports nav atļauts');
  return url.href;
}
export function omniboxURL(input, options) {
  const value = String(input ?? '').trim().slice(0, 4096);
  if (!value) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return validateWebURL(value, options);
  if (!/\s/.test(value) && (value.includes('.') || value === 'localhost')) return validateWebURL(`https://${value}`, options);
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}
export function assertShellSender(event, shell) {
  if (event.sender !== shell || event.senderFrame !== shell.mainFrame || event.senderFrame?.url !== APP_URL) throw new Error('IPC_ACCESS_DENIED');
}
export function validateId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,90}$/.test(id)) throw new Error('Nederīgs identifikators');
  return id;
}
export function text(value, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Nederīgs teksta garums');
  return value.trim();
}
export function canLoadLocalModel({freeBytes,totalBytes,guard,fixture=false}) {
  if(guard?.allowModelLoad===false||guard?.level==='CRITICAL')return false;
  return fixture || (Number.isFinite(freeBytes)&&Number.isFinite(totalBytes)&&freeBytes>Math.max(1.5*1024**3,totalBytes*.1));
}
