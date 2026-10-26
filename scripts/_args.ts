export function parseArgs(argv: string[]): { flags: Set<string>; values: Map<string, string[]> } {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.add(key);
    else { values.set(key, [...(values.get(key) ?? []), next]); i++; }
  }
  return { flags, values };
}
