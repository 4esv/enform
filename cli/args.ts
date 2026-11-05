// Issue #38, #258, DX-3: the command line of `enform`. The positionals name
// the group, the action and the subject; the flags carry the values that are
// not positional. `--json` is removed before the parse, and every command
// reports one JSON object with it or a plain line without.

/** The flags that take no value, so the next argument is a positional. */
export const BOOLEAN_FLAGS = new Set([
  '--no-open',
  '--no-serve',
  '--status',
  '--auto-migrate',
  '--yes',
  '--available',
  '--mine',
  '--started',
  '--with-changes',
])

/** One parsed command line: the positionals and the flag values, in order. */
export type Args = {
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, readonly string[]>
}

/** Whether a value-less flag is present. */
export function has(args: Args, key: string): boolean {
  return args.flags.has(key)
}

/** Split the command line into positionals and flags. `--json` is already removed. */
export function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg, ['true'])
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`)
    }
    index += 1
    const values = flags.get(arg) ?? []
    values.push(value)
    flags.set(arg, values)
  }
  return { positionals, flags }
}

/** The one value of a required flag, or an error that names the usage. */
export function flag(args: Args, key: string, usage: string): string {
  const values = args.flags.get(key)
  if (values === undefined || values.length === 0) {
    throw new Error(`missing ${key}: usage is ${usage}`)
  }
  if (values.length > 1) throw new Error(`${key} is given more than once: usage is ${usage}`)
  return values[0]
}

/** The one value of an optional flag, or undefined. */
export function optionalFlag(args: Args, key: string): string | undefined {
  const values = args.flags.get(key)
  return values === undefined || values.length === 0 ? undefined : values[0]
}

/** The value of a required positional, or an error that names the usage. */
export function required(value: string | undefined, usage: string): string {
  if (value === undefined) throw new Error(`missing argument: usage is ${usage}`)
  return value
}

/** Write the outcome: one JSON object with `--json`, a plain line otherwise. */
export function report(json: boolean, value: Record<string, unknown>, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${text}\n`)
}
