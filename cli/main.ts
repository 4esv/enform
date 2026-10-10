#!/usr/bin/env node
// Issue #38, S01, DX-3: the `enform` bin entry. Node strips the TypeScript
// types, but it does not resolve the `.js` specifier of a TypeScript import to
// its `.ts` source, and the engine writes `.js` specifiers (the nodenext
// convention that `tsc` checks). This entry installs a resolver hook and only
// then loads the command module, so `node cli/main.ts` and the `enform` bin
// run the same code. The hook changes no other specifier.

import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      } catch {
        return nextResolve(specifier, context)
      }
    }
    return nextResolve(specifier, context)
  },
})

const { main } = await import('./commands.js')
process.exitCode = main(process.argv.slice(2))
