// Tiny `--key value` / `--flag` parser so the CLIs need no dependencies.
export function parseArgs(argv, defaults = {}) {
  const out = { ...defaults, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    let key, val;
    if (eq > 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
    else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { val = next; i++; }
      else val = true;
    }
    if (key.startsWith("no-")) { out[key.slice(3)] = false; continue; }
    if (typeof val === "string" && val !== "" && !isNaN(Number(val))) val = Number(val);
    out[key] = val;
  }
  return out;
}
