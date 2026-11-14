import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const refName = (ref) => {
  const match = /^vault:(?:env|dpapi)\.([a-z0-9._-]+)$/i.exec(String(ref ?? ''));
  return match?.[1] ?? null;
};

function run(command, args, { input = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(Buffer.concat(err).toString('utf8').trim() || `${command} exited ${code}`)); else resolve(Buffer.concat(out).toString('utf8')); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

export class EnvironmentSecretResolver {
  constructor({ env = process.env } = {}) { this.env = env; }
  async resolve(ref) {
    const name = refName(ref);
    if (!name || !String(ref).startsWith('vault:env.')) return null;
    return this.env[name] || null;
  }
}

export class WindowsDpapiSecretStore {
  constructor({ root, powershell = process.env.ComSpec ? 'powershell.exe' : 'pwsh' } = {}) {
    if (!root) throw new Error('DPAPI secret store requires root');
    this.root = root;
    this.powershell = powershell;
  }

  file(name) { return path.join(this.root, `${name}.dpapi`); }

  async put(name, value) {
    if (process.platform !== 'win32') throw new Error('Windows DPAPI store is only available on Windows');
    if (!/^[a-z0-9._-]+$/i.test(name) || !value) throw new Error('Invalid DPAPI secret entry');
    await fs.mkdir(this.root, { recursive: true });
    const script = `Add-Type -AssemblyName System.Security;$b=[Console]::OpenStandardInput();$m=New-Object IO.MemoryStream;$b.CopyTo($m);$p=[System.Security.Cryptography.ProtectedData]::Protect($m.ToArray(),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)`;
    const protectedValue = (await run(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { input: Buffer.from(value, 'utf8') })).trim();
    await fs.writeFile(this.file(name), protectedValue, { encoding: 'utf8', mode: 0o600 });
    return `vault:dpapi.${name}`;
  }

  async resolve(ref) {
    const name = refName(ref);
    if (!name || !String(ref).startsWith('vault:dpapi.')) return null;
    if (process.platform !== 'win32') return null;
    const encoded = (await fs.readFile(this.file(name), 'utf8')).trim();
    const script = `Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd().Trim();$p=[Convert]::FromBase64String($s);$u=[System.Security.Cryptography.ProtectedData]::Unprotect($p,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($u)`;
    return run(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { input: encoded });
  }
}

export class CompositeSecretResolver {
  constructor(resolvers = []) { this.resolvers = resolvers; }
  async resolve(ref) {
    for (const resolver of this.resolvers) {
      const value = await resolver.resolve(ref).catch(() => null);
      if (value) return value;
    }
    throw new Error(`Secret reference is not resolvable: ${ref}`);
  }
}

export function discoverCredentialEnvironment(env = process.env) {
  const known = [
    ['AIMLAPI_KEY', 'aimlapi'], ['BYNARA_ROUTER_API_KEY', 'bynara-router'], ['ALIBABA_MODEL_STUDIO_API_KEY', 'alibaba-model-studio'],
    ['DASHSCOPE_API_KEY', 'alibaba-model-studio'], ['OPENAI_API_KEY', 'openai'], ['ANTHROPIC_API_KEY', 'anthropic'],
    ['GEMINI_API_KEY', 'google-gemini'], ['GOOGLE_API_KEY', 'google-gemini'], ['XAI_API_KEY', 'xai'], ['OPENROUTER_API_KEY', 'openrouter'],
    ['MISTRAL_API_KEY', 'mistral'], ['DEEPSEEK_API_KEY', 'deepseek'], ['TOGETHER_API_KEY', 'together'], ['FIREWORKS_API_KEY', 'fireworks'],
    ['GROQ_API_KEY', 'groq'], ['CEREBRAS_API_KEY', 'cerebras'], ['PERPLEXITY_API_KEY', 'perplexity'], ['REPLICATE_API_TOKEN', 'replicate']
  ];
  return known.filter(([name]) => Boolean(env[name])).map(([name, providerId]) => ({ envName: name, providerId, credentialRef: `vault:env.${name}`, configured: true }));
}
