import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OciAuth } from '@xplane/oci';

export interface OciAuthArgs {
  username?: string;
  password?: string;
  token?: string;
  'docker-config'?: string;
}

/**
 * Resolve OCI auth from CLI flags with auto-detection.
 *
 * Precedence:
 *   1. `--username` + `--password`       → basic
 *   2. `--token`                         → bearer
 *   3. `--docker-config <path>`          → docker config at the given path
 *   4. `$DOCKER_CONFIG/config.json`      → auto-detected docker config
 *   5. `~/.docker/config.json`           → auto-detected docker config
 *   6. anonymous
 *
 * Modes (1)–(3) are mutually exclusive.
 */
export function resolveOciAuth(args: OciAuthArgs): OciAuth | undefined {
  const hasBasic = !!(args.username || args.password);
  const hasToken = !!args.token;
  const hasDocker = !!args['docker-config'];
  const explicit = [hasBasic, hasToken, hasDocker].filter(Boolean).length;
  if (explicit > 1) {
    throw new Error(
      'OCI auth flags are mutually exclusive: choose one of ' +
        '(--username + --password), --token, or --docker-config',
    );
  }
  if (hasBasic) {
    if (!args.username || !args.password) {
      throw new Error('Basic auth requires both --username and --password');
    }
    return { type: 'basic', username: args.username, password: args.password };
  }
  if (hasToken) {
    return { type: 'bearer', token: args.token as string };
  }
  if (hasDocker) {
    const configPath = args['docker-config'] as string;
    if (!fs.existsSync(configPath)) {
      throw new Error(`Docker config not found: ${configPath}`);
    }
    return { type: 'dockerConfig', configPath };
  }
  // Auto-detect a docker config in the usual locations.
  const candidates = [
    process.env.DOCKER_CONFIG ? path.join(process.env.DOCKER_CONFIG, 'config.json') : undefined,
    path.join(os.homedir(), '.docker', 'config.json'),
  ].filter((p): p is string => typeof p === 'string');
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { type: 'dockerConfig', configPath: p };
    }
  }
  return undefined;
}
