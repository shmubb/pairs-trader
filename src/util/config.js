import { readFile } from "node:fs/promises";
import { mergeConfig } from "../core/strategy.js";

/** Load config/default.json, optionally merged with an override file and inline overrides. */
export async function loadConfig(overridePath, inline = {}) {
  let cfg = JSON.parse(await readFile(new URL("../../config/default.json", import.meta.url), "utf8"));
  if (overridePath) cfg = mergeConfig(cfg, JSON.parse(await readFile(overridePath, "utf8")));
  return mergeConfig(cfg, inline);
}

/** Set a nested key from "a.b.c" notation. */
export function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = { ...(o[k] || {}) };
  o[keys[keys.length - 1]] = value;
  return obj;
}
