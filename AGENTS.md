# AGENTS.md

This file tells coding agents how to work in this repository. It does not define scope or behavior. Other documents do that.

## Read first, in this order

1. `MVP.md`: scope, axioms, invariants, versioning and scope rules.
2. `STORIES.md`: the golden paths and the acceptance tests.
3. `CONTRIBUTING.md`: the procedure for each change.
4. `docs/adr/`: accepted decisions and their reasons.

If these documents do not answer a question, stop and ask. Do not guess the scope.

## Rules

- Start from an issue. Each change cites its issue, its story and its IDs. A change without an ID is out of scope.
- Commit a failing test before the implementation. Mark it as expected to fail, with the issue number. Then implement, and remove the mark.
- Put correctness, authorization and state transitions in the engine only. The CLI and the GUI use only the public API.
- Prove a behavior through the engine path of a story (CLI and API) before you start the GUI path.
- Change contracts (schemas, OpenAPI, protocol) before the code that serves them, or with that code.
- Make one logical change per commit. Each commit builds and passes all tests.
- Do not skip, disable or relax a test. Do not rewrite `main`. Do not push until the local check is green.
- If a story needs something that `MVP.md` does not contain, propose a scope change. Do not add the scope in code.
- Write in plain, direct English. Do not use em dashes.

## Done

A change is done when it meets `MVP.md` section 11.6. All items, each time.

## Commands

The commands are defined at `0.1.0`: setup, local check, invariant suites, story suites and local stack.
