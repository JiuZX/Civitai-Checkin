import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CivitaiClient, CivitaiError, utcDay } from './client.mjs';
import { runTasks, TASKS } from './engine.mjs';

const TASK_LABELS = { dailyBoost: 'Daily Boost', encouragement: 'Image reactions', firstDailyFollow: 'First follows' };

export function formatRunLog(report) {
  const amount = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'UNKNOWN';
  const tasks = report.tasks ?? TASKS.map(({ type }) => ({
    type, status: 'blocked', attemptedOperations: 0, successfulOperations: 0,
    verifiedGain: null, verifiedToday: null, cap: null, unverifiedOperations: 0,
  }));
  const lines = [`Civitai Blue Buzz | ${report.day} UTC | ${String(report.status).toUpperCase()}`];
  for (const task of tasks) {
    lines.push(`[${TASK_LABELS[task.type]}] ${task.status.toUpperCase()}`
      + ` | successful operations ${amount(task.successfulOperations)}/${amount(task.attemptedOperations)}`
      + ` | verified gain ${amount(task.verifiedGain)}`
      + ` | today ${amount(task.verifiedToday)}/${amount(task.cap)}`
      + ` | unverified ${amount(task.unverifiedOperations)}`
      + (task.type === 'dailyBoost' ? '' : ` | removed ${amount(task.removedOperations ?? 0)}`)
      + (task.reason ? ` | reason ${task.reason}` : ''));
  }
  lines.push(`Verified gain for this run: ${amount(report.verifiedGain)} Blue Buzz`);
  lines.push(`Current Blue Buzz: ${amount(report.blueBalance)}`);
  if (report.warnings?.length) lines.push(`Warnings: ${report.warnings.map((warning) => warning.code).join(', ')}`);
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let report;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Interrupted'));
  const redact = (message) => env.CIVITAI_API_KEY?.trim()
    ? String(message).replaceAll(env.CIVITAI_API_KEY.trim(), '[REDACTED]') : String(message);
  try {
    if (args.length) throw new Error('Run npm run checkin without additional arguments');
    const client = new CivitaiClient({ apiKey: env.CIVITAI_API_KEY, signal: controller.signal });
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    report = await runTasks(client, { signal: controller.signal });
  } catch (error) {
    const message = redact(error.message ?? 'Run failed');
    console.error(message);
    report = {
      day: utcDay(),
      status: 'blocked', verifiedGain: 0,
      warnings: [{ code: error instanceof CivitaiError ? error.code : 'CONFIGURATION_OR_READ_ERROR', message }],
    };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  console.log(redact(formatRunLog(report)));
  if (report.status === 'completed') return 0;
  return report.status === 'partial' ? 2 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error('Task run failed');
    process.exitCode = 1;
  });
}