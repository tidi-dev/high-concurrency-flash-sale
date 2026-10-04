// CLI load generator: runs in its own process, so it can push harder than the dashboard button.
//
//   npm run load:redis -- --users 20000 --concurrency 500
//   npm run load:naive -- --users 2000 --reset --stock 500
//
// Options: --mode naive|flash  --users N  --concurrency N  --url http://localhost:3000
//          --reset (reset the demo first)  --stock N (with --reset)  --no-report (don't post results to the dashboard)
import { parseArgs } from 'node:util';
import type { Mode } from '@flash/shared';
import { runLoad } from '../src/loadgen/run-load';

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'flash' },
      users: { type: 'string', default: '2000' },
      concurrency: { type: 'string', default: '100' },
      url: { type: 'string', default: process.env.API_URL ?? 'http://localhost:3000' },
      reset: { type: 'boolean', default: false },
      stock: { type: 'string', default: '500' },
      'no-report': { type: 'boolean', default: false },
    },
  });
  const mode = values.mode as Mode;
  if (mode !== 'naive' && mode !== 'flash') throw new Error('--mode must be naive or flash');
  const users = Number(values.users);
  const concurrency = Number(values.concurrency);
  const url = values.url!;

  if (values.reset) {
    const res = await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initialStock: Number(values.stock) }) });
    if (!res.ok) throw new Error(`reset failed: ${res.status} ${await res.text()}`);
    console.log(`reset: initial stock ${values.stock}`);
  }

  console.log(`→ ${users} ${mode === 'naive' ? 'NAIVE (Mode A)' : 'REDIS (Mode B)'} buy requests, ${concurrency} concurrent, against ${url}`);
  let lastPrint = 0;
  const result = await runLoad({
    baseUrl: url,
    mode,
    users,
    concurrency,
    onProgress: (done) => {
      if (Date.now() - lastPrint > 500) {
        lastPrint = Date.now();
        process.stdout.write(`\r  ${done}/${users}`);
      }
    },
  });
  process.stdout.write('\r');

  console.table({
    duration: `${result.durationMs} ms`,
    throughput: `${result.throughputRps} req/s`,
    'avg latency': `${result.latency.avg} ms`,
    'p50 latency': `${result.latency.p50} ms`,
    'p95 latency': `${result.latency.p95} ms`,
    'p99 latency': `${result.latency.p99} ms`,
    'max latency': `${result.latency.max} ms`,
    errors: result.errors,
  });
  console.log('outcomes:', result.outcomes);

  const state = (await (await fetch(`${url}/api/state`)).json()) as {
    naive: { orders: number; oversold: number; product: { stock: number; initialStock: number } };
    flash: { redis: { stock: number }; product: { dbStock: number }; queue: { waiting: number } };
  };
  if (mode === 'naive') {
    console.log(`PostgreSQL: stock=${state.naive.product.stock}, orders=${state.naive.orders}, OVERSOLD=${state.naive.oversold}`);
  } else {
    console.log(`Redis stock=${state.flash.redis.stock}, PostgreSQL stock=${state.flash.product.dbStock}, queue waiting=${state.flash.queue.waiting}`);
  }

  if (!values['no-report']) {
    await fetch(`${url}/api/simulations/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
