import os from 'node:os';
import path from 'node:path';

export function connectorPaths(env = process.env) {
  const configuredRoot = env.MNEMOS_CONNECTOR_ROOT?.trim();
  if (configuredRoot && !path.isAbsolute(configuredRoot)) {
    throw new Error('MNEMOS_CONNECTOR_ROOT_MUST_BE_ABSOLUTE');
  }
  const appData = env.LOCALAPPDATA || env.APPDATA || path.join(os.homedir(), '.local', 'share');
  const root = configuredRoot || path.join(appData, 'MNEMOS Browser', 'connectors', 'perplexity');
  const security = path.join(root, 'security');
  const data = path.join(root, 'data');
  return {
    root,
    security,
    credential: path.join(security, 'credential.json'),
    geminiConfig: path.join(security, 'gemini-oauth.json'),
    geminiDatabase: path.join(data, 'gemini-oauth.sqlite'),
    collaborationDatabase: path.join(data, 'collaboration.sqlite'),
  };
}

export function connectorOrigin(env = process.env) {
  const configuredOrigin = env.MNEMOS_CONNECTOR_PUBLIC_ORIGIN?.trim();
  if (!configuredOrigin) return null;
  const url = URL.parse(configuredOrigin);
  if (!url || url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MNEMOS_CONNECTOR_PUBLIC_ORIGIN_MUST_BE_AN_HTTPS_ORIGIN');
  }
  return url.origin;
}

export function requireConnectorOrigin() {
  const origin = connectorOrigin();
  if (!origin) throw new Error('MNEMOS_CONNECTOR_PUBLIC_ORIGIN_REQUIRED');
  return origin;
}
