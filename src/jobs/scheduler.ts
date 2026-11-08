import { expireLapsedPlans } from "../billing/plan-expiry";
import { runAutoRenew } from "../billing/jobs/auto-renew.job";
import { runRenewalReminders } from "../billing/jobs/renewal-reminders.job";
import { runUsageAlerts } from "../billing/jobs/usage-alerts.job";
import { runIdleFreeDeviceCleanup } from "./idle-free-devices.job";

type Job = { name: string; everyMs: number; run: () => Promise<unknown> };

const MINUTE = 60_000;

/** Order matters on each tick: renew from wallets before reminders, expire last. */
const JOBS: Job[] = [
  { name: "auto-renew", everyMs: 30 * MINUTE, run: () => runAutoRenew() },
  { name: "renewal-reminders", everyMs: 30 * MINUTE, run: () => runRenewalReminders() },
  { name: "plan-expiry", everyMs: 15 * MINUTE, run: () => expireLapsedPlans() },
  { name: "usage-alerts", everyMs: 60 * MINUTE, run: () => runUsageAlerts() },
  { name: "idle-free-devices", everyMs: 6 * 60 * MINUTE, run: () => runIdleFreeDeviceCleanup() },
];

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

async function runOnce(job: Job): Promise<void> {
  // Skip a tick if the previous run of the same job is still going.
  if (running.has(job.name)) return;
  running.add(job.name);
  try {
    await job.run();
  } catch (err) {
    console.error(`[jobs] ${job.name} failed:`, err);
  } finally {
    running.delete(job.name);
  }
}

/** Starts background jobs: each runs shortly after boot, then on its interval. */
export function startBackgroundJobs(): void {
  if (timers.length) return;
  JOBS.forEach((job, i) => {
    timers.push(setTimeout(() => void runOnce(job), 20_000 + i * 5_000));
    const t = setInterval(() => void runOnce(job), job.everyMs);
    t.unref();
    timers.push(t);
  });
  console.log(`[jobs] started: ${JOBS.map((j) => j.name).join(", ")}`);
}

export function stopBackgroundJobs(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}
