// Run jobs across worker threads. Each job is {fn: "module#export", args}.
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";

const WORKER_SRC = `
import { parentPort } from "node:worker_threads";
const mods = new Map();
parentPort.on("message", async ({ id, mod, fn, args }) => {
  try {
    if (!mods.has(mod)) mods.set(mod, await import(mod));
    const out = await mods.get(mod)[fn](...args);
    parentPort.postMessage({ id, out });
  } catch (e) {
    parentPort.postMessage({ id, err: String(e && e.stack || e) });
  }
});
`;

export async function runPool(jobs, { threads = availableParallelism(), onDone } = {}) {
  const url = "data:text/javascript," + encodeURIComponent(WORKER_SRC);
  const workers = Array.from({ length: Math.min(threads, jobs.length) }, () => new Worker(new URL(url)));
  const results = new Array(jobs.length);
  let next = 0, done = 0;
  await Promise.all(workers.map((w) => new Promise((resolve) => {
    const feed = () => {
      if (next >= jobs.length) { w.terminate(); resolve(); return; }
      const id = next++;
      w.postMessage({ id, ...jobs[id] });
    };
    w.on("message", ({ id, out, err }) => {
      results[id] = err ? { error: err } : out;
      done++;
      if (onDone) onDone(done, jobs.length, results[id], jobs[id]);
      feed();
    });
    w.on("error", (e) => { console.error(e); resolve(); });
    feed();
  })));
  return results;
}
