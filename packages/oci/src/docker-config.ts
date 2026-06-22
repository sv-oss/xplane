import { readFileSync } from 'node:fs';

interface DockerConfigFile {
  auths?: Record<
    string,
    {
      auth?: string;
      username?: string;
      password?: string;
    }
  >;
}

/**
 * Resolve basic-auth credentials for `registry` from a Docker config file
 * (typically `~/.docker/config.json` or a mounted ECR-refreshed config).
 *
 * Matches keys in this order:
 *   1. exact `registry` (e.g. `123.dkr.ecr.us-east-1.amazonaws.com`)
 *   2. with scheme prefix (`https://<registry>` or `https://<registry>/v1/`)
 * Returns `undefined` if no entry matches.
 */
export function resolveDockerConfigAuth(
  configPath: string,
  registry: string,
): { username: string; password: string } | undefined {
  const raw = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as DockerConfigFile;
  if (!config.auths) return undefined;

  const candidates = [
    registry,
    `https://${registry}`,
    `https://${registry}/`,
    `https://${registry}/v1/`,
    `https://${registry}/v2/`,
    `http://${registry}`,
    `http://${registry}/`,
  ];

  let entry: { auth?: string; username?: string; password?: string } | undefined;
  for (const key of candidates) {
    if (config.auths[key]) {
      entry = config.auths[key];
      break;
    }
  }
  if (!entry) return undefined;

  if (entry.auth) {
    const decoded = Buffer.from(entry.auth, 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Malformed docker config auth for ${registry}: expected username:password`);
    }
    return {
      username: decoded.slice(0, colonIdx),
      password: decoded.slice(colonIdx + 1),
    };
  }
  if (entry.username !== undefined && entry.password !== undefined) {
    return { username: entry.username, password: entry.password };
  }
  return undefined;
}
