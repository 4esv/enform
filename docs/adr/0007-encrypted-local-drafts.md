# 0007: Encrypted local drafts

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-08 |
| Refs | I11, I15, RT-3, A7 |

## Context

I11 requires that drafts in the browser are encrypted with a key the session controls, and that sign-out or the idle timeout deletes them. I15 requires that no acknowledged edit is lost and that the interface always shows the difference between "Saved on this device" and "Synced". RT-3 makes drafts local first: the browser saves each edit to encrypted storage, then sends it to the server as an idempotent operation. RT-4 requires the interface to show local state immediately after a refresh, then reconcile with the server. A7 holds that work is never lost.

## Decision

Draft edits are encrypted in the browser with AES-256-GCM under a session-scoped key held in sessionStorage, stored as ciphertext in IndexedDB, and the key and ciphertext are destroyed on sign-out or after a 30-minute idle timeout. The plaintext edit reaches the server only as an idempotent operation.

## Alternatives

- **A third-party crypto library such as libsodium.** Rejected: Web Crypto is browser-native with no dependency, and GCM gives authenticated encryption.
- **Storing the key in localStorage.** Rejected: it persists past sign-out, which violates I11.
- **Storing the key in IndexedDB beside the ciphertext.** Rejected: one compromise would read both the key and the ciphertext.
- **Encrypting the server-side copy under the client key.** Rejected: the server must evaluate rules and rebuild state from the log (I4, I6), and D3 makes the server log canonical.

## Consequences

- Easier: encryption is browser-native and authenticated, and the local-first sync marker is honest.
- Harder: key lifecycle management, and the 30-minute idle-timeout timer.
- Constraint: the server receives plaintext only as an idempotent operation, and client-side encryption protects the local-first copy.
