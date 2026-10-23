import { expect, test } from 'vitest'
import { principalOfTarget, targetOf } from './builder.js'

// Issue #252, S08, AS-1, I12: the builder target input names a user, a starter,
// a directory group or a team, and it normalizes each to the target the engine
// publishes (AS-1). A group grant names `group:<id>`, which is the principal
// that the group resolver and `grantsFor` use (I10, I8).

test('#252 the builder normalizes group and team targets', () => {
  expect(targetOf('group:5f1c')).toEqual({ group: '5f1c' })
  expect(targetOf('team:registrar-office')).toEqual({ team: 'registrar-office' })
  expect(targetOf('user:person-1')).toEqual({ user: 'person-1' })
  expect(targetOf('person-1')).toEqual({ user: 'person-1' })
  expect(targetOf('starter')).toEqual({ starter: 'starter' })

  expect(principalOfTarget('group:5f1c')).toBe('group:5f1c')
  expect(principalOfTarget('team:registrar-office')).toBe('team:registrar-office')
  expect(principalOfTarget('user:person-1')).toBe('person-1')
  expect(principalOfTarget('person-1')).toBe('person-1')
})
