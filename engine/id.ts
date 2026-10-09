// Issue #7, I1, I6, ADR 0004: UUIDv7 client operation IDs.

/** A source of random bytes, injected so that a test is repeatable (I6). */
export type RandomBytes = (length: number) => Uint8Array

/**
 * A UUIDv7 (RFC 9562) from an injected Unix-millisecond time and random
 * source. ADR 0004 requires a UUIDv7 for every client operation ID.
 *
 * `crypto.randomUUID()` is not used: it makes a version 4 UUID, and it reads
 * the system clock and a random source, which I6 forbids. The injected pair
 * keeps the caller in control and makes a test repeatable.
 */
export function uuidv7(at: number, random: RandomBytes): string {
  const bytes = new Uint8Array(16)
  const time = BigInt(Math.trunc(at))
  bytes[0] = Number((time >> 40n) & 0xffn)
  bytes[1] = Number((time >> 32n) & 0xffn)
  bytes[2] = Number((time >> 24n) & 0xffn)
  bytes[3] = Number((time >> 16n) & 0xffn)
  bytes[4] = Number((time >> 8n) & 0xffn)
  bytes[5] = Number(time & 0xffn)
  bytes.set(random(10), 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return format(bytes)
}

function format(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const groups = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ]
  return groups.join('-')
}
