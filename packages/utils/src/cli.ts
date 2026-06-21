#!/usr/bin/env node
import { createRequire } from 'node:module';
import { defineCommand, runMain } from 'citty';
import {
  type GetStatusCommandArgs,
  type GetStatusFormat,
  runGetStatusCommand,
} from './cli/get-status.js';
import { runWatchCommand, type WatchCommandArgs } from './cli/watch.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const watch = defineCommand({
  meta: {
    name: 'watch',
    description: 'Subscribe to a Crossplane XR and block until it becomes Ready',
  },
  args: {
    target: {
      type: 'positional',
      required: true,
      description: 'kubectl-style target: <resource[.group][.version]>/<name>',
    },
    namespace: {
      type: 'string',
      alias: 'n',
      description: 'Namespace (required for namespaced XRs)',
    },
    kubeconfig: { type: 'string', description: 'Path to kubeconfig' },
    context: { type: 'string', description: 'Override the active kubeconfig context' },
    timeout: {
      type: 'string',
      description: 'Maximum time to wait for Ready, e.g. "30s", "5m", "1h"',
    },
    mode: { type: 'string', description: 'Force renderer mode: "tty" or "ci" (default: auto)' },
    'no-events': {
      type: 'boolean',
      description: 'Disable subscribing to Kubernetes Events for the XR',
    },
    heartbeat: {
      type: 'string',
      description: 'CI mode: heartbeat interval for liveness lines (default "30s", "0" to disable)',
    },
    'show-events': {
      type: 'boolean',
      description: 'CI mode: include Kubernetes Events inline (off by default)',
    },
    'snapshot-every': {
      type: 'string',
      description:
        'CI mode: every N idle heartbeats, expand the liveness line into a snapshot of unready + blocked resources (default 10, 0 to disable)',
    },
    'no-color': {
      type: 'boolean',
      description: 'CI mode: strip ANSI colour escapes from rendered output',
    },
  },
  async run({ args }) {
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    process.on('SIGTERM', () => controller.abort());

    const cmdArgs: WatchCommandArgs = { target: String(args.target) };
    if (typeof args.namespace === 'string') cmdArgs.namespace = args.namespace;
    if (typeof args.kubeconfig === 'string') cmdArgs.kubeconfig = args.kubeconfig;
    if (typeof args.context === 'string') cmdArgs.context = args.context;
    if (typeof args.timeout === 'string') cmdArgs.timeout = args.timeout;
    if (typeof args.mode === 'string') cmdArgs.mode = args.mode;
    if (args['no-events']) cmdArgs.disableEvents = true;
    if (typeof args.heartbeat === 'string') cmdArgs.heartbeat = args.heartbeat;
    if (args['show-events']) cmdArgs.showEvents = true;
    if (typeof args['snapshot-every'] === 'string') {
      const n = Number.parseInt(args['snapshot-every'], 10);
      if (Number.isFinite(n) && n >= 0) cmdArgs.snapshotEveryHeartbeats = n;
    }
    if (args['no-color']) cmdArgs.noColor = true;

    const result = await runWatchCommand(cmdArgs, { signal: controller.signal });
    if (result.code !== 0) {
      if (result.error) process.stderr.write(`${result.error}\n`);
      process.exit(result.code);
    }
    process.exit(0);
  },
});

const getStatus = defineCommand({
  meta: {
    name: 'get-status',
    description: 'Fetch a Crossplane XR and print its .status',
  },
  args: {
    target: {
      type: 'positional',
      required: true,
      description: 'kubectl-style target: <resource[.group][.version]>/<name>',
    },
    namespace: {
      type: 'string',
      alias: 'n',
      description: 'Namespace (required for namespaced XRs)',
    },
    kubeconfig: { type: 'string', description: 'Path to kubeconfig' },
    context: { type: 'string', description: 'Override the active kubeconfig context' },
    format: {
      type: 'string',
      alias: 'o',
      description: 'Output format: "dot" (default) or "json"',
    },
    compact: {
      type: 'boolean',
      description: 'JSON mode: emit compact (single-line) JSON instead of pretty-printed',
    },
    'include-xplane': {
      type: 'boolean',
      description: 'Include the framework-managed status.xplane subtree (excluded by default)',
    },
    'include-conditions': {
      type: 'boolean',
      description: 'Include status.conditions (excluded by default)',
    },
  },
  async run({ args }) {
    const cmdArgs: GetStatusCommandArgs = { target: String(args.target) };
    if (typeof args.namespace === 'string') cmdArgs.namespace = args.namespace;
    if (typeof args.kubeconfig === 'string') cmdArgs.kubeconfig = args.kubeconfig;
    if (typeof args.context === 'string') cmdArgs.context = args.context;
    if (typeof args.format === 'string') {
      if (args.format !== 'dot' && args.format !== 'json') {
        process.stderr.write(`Invalid --format "${args.format}" (expected "dot" or "json")\n`);
        process.exit(2);
      }
      cmdArgs.format = args.format as GetStatusFormat;
    }
    if (args.compact) cmdArgs.pretty = false;
    if (args['include-xplane']) cmdArgs.includeXplane = true;
    if (args['include-conditions']) cmdArgs.includeConditions = true;

    const result = await runGetStatusCommand(cmdArgs);
    if (result.code !== 0) {
      process.stderr.write(`${result.error}\n`);
      process.exit(result.code);
    }
    process.exit(0);
  },
});

const main = defineCommand({
  meta: {
    name: 'xplane-utils',
    version,
    description: 'Utilities for Crossplane compositions built with xplane',
  },
  subCommands: { watch, 'get-status': getStatus },
});

void runMain(main);
