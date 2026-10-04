// npm run reset [-- --stock 500]
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: { stock: { type: 'string', default: '500' }, url: { type: 'string', default: process.env.API_URL ?? 'http://localhost:3000' } },
  });
  const res = await fetch(`${values.url}/api/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initialStock: Number(values.stock) }),
  });
  if (!res.ok) throw new Error(`reset failed: ${res.status} ${await res.text()}`);
  console.log(`Demo reset: initial stock ${values.stock} for both modes.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
