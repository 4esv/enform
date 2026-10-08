# Contributing to enform

This document gives the procedure for all changes. It applies to people and to coding agents.

## Before you start

1. Read `MVP.md`. It defines the scope, the invariants and the versioning rules.
2. Read `STORIES.md`. It defines the acceptance tests.
3. Read the accepted decisions in `docs/adr/`.

If these documents do not answer your question, ask in an issue. Do not guess the scope.

## Procedure

All work follows the sequence of `MVP.md` section 11.1: issue, failing test, implementation, evidence, push.

### 1. Open an issue

- Cite the story (for example `S10`) and the requirement and invariant IDs (for example `AS-3, I5`).
- State the acceptance criteria. Copy them from the story when the story has them.
- If the work needs scope that `MVP.md` does not contain, open a scope change issue first. Do not start implementation until the scope change is merged.

### 2. Create a branch

```sh
git switch -c <issue-number>-<short-slug>
```

### 3. Commit a failing test

- Write the test that the acceptance criteria require.
- Run it. Make sure that it fails, and that it fails for the expected reason.
- Mark it as expected to fail, with the issue number. Use the expected-failure mark of the test framework. The suite stays green. If an expected failure passes, the suite fails.
- Commit it:

```text
test(engine): takeover is refused before the idle limit

The engine must refuse a takeover while the holder is active, and
must report the remaining time.

Refs: #42, S10, AS-3
```

### 4. Commit the implementation

- Implement the smallest change that makes the test pass.
- Remove the expected-failure mark.
- Run the complete local check. All tests must pass.
- Commit it:

```text
feat(engine): enforce takeover idle limit per step

Refs: #42, S10, AS-3, I5
```

Each commit builds and passes all tests. Each commit contains one logical change. The commit body states the reason. The diff shows the change.

### 5. Record the evidence

In the same branch:

- Update the evidence table in `STORIES.md`: issue, tests, commits, status.
- Add a `CHANGELOG.md` entry under `Unreleased`, if users can see the change.
- Write an ADR, if the change made a decision that is costly to reverse.

### 6. Push

- Run the complete local check before each push. Nothing goes to the remote until it is green.
- Clean up your local commits before the first push. After a push, do not rewrite the branch history unless a reviewer asks for it.
- Open a pull request. It cites the issue and the IDs, and it closes the issue.

## Commit messages

Commit messages use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/). `MVP.md` section 9.6 gives the types, scopes and footers.

## Rules

- Do not skip, disable or relax a test to make a change pass. If a test is incorrect, correct it in its own commit, with its own reason.
- Do not include unrelated changes. Open a new issue for each.
- Do not rewrite `main`.
- Do not add code to the GUI or the CLI that decides correctness or authorization. That code goes in the engine (`MVP.md` axiom A9).

## Local check

The local check command is defined at `0.1.0`. It will run lint, type checks, unit tests, invariant suites and story suites.
