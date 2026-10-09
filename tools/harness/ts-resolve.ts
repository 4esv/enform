import { registerHooks } from 'node:module'

// Issue #25: node type-strips TypeScript, but it does not resolve the `.js`
// specifier of a TypeScript import to its `.ts` source. The engine writes `.js`
// specifiers (the nodenext convention that `tsc` checks); this hook maps them
// back to `.ts` so that `node` can load the harness CLI and the engine modules
// it imports. It is harness infrastructure, so the release build is untouched,
// and it changes no other specifier.

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
