export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
export const ms = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} ms`);
