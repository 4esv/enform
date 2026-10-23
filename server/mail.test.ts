import { expect, test } from 'vitest'
import { SENT_BACK_NOTIFICATION } from '../engine/sendBack.js'
import { ASSIGNMENT_EMAIL } from '../engine/submission.js'
import { defaultConfig } from './config.js'
import { checkMail, renderMail } from './mail.js'

// Issue #240, SE-2: the templates are deterministic and escaped. Each entry
// renders from its own payload and the flow/instance link, never from a form
// value, and the HTML body escapes every value.

/** The public URL that `enform init` writes (SE-2). */
const PUBLIC_URL = 'https://forms.example.test'

test('#240 SE-2 the assignment template carries the recipient, the step and the link', () => {
  const mail = renderMail(
    {
      id: 'op-1:0',
      effect: ASSIGNMENT_EMAIL,
      recipient: 'okafor@example.test',
      payload: { to: 'principal-1', step: 'advisor' },
      instanceId: 'instance-1',
      flowSlug: 'course overload',
    },
    PUBLIC_URL
  )
  expect(mail.to).toBe('okafor@example.test')
  expect(mail.subject).toBe('enform: task assigned (advisor)')
  expect(mail.text).toContain('advisor step')
  expect(mail.text).toContain(
    'https://forms.example.test/app/?flow=course%20overload&instance=instance-1'
  )
  expect(mail.html).toContain('course%20overload&amp;instance=instance-1')
})

test('#240 SE-2 the sent-back template escapes the comment in the HTML body', () => {
  const mail = renderMail(
    {
      id: 'op-2:0',
      effect: SENT_BACK_NOTIFICATION,
      recipient: 'sam@example.test',
      payload: { to: 'principal-2', step: 'request', comment: '<script>alert(1)</script>' },
      instanceId: 'instance-2',
      flowSlug: 'flow-2',
    },
    PUBLIC_URL
  )
  expect(mail.subject).toBe('enform: task sent back (request)')
  expect(mail.text).toContain('<script>alert(1)</script>')
  expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(mail.html).not.toContain('<script>alert(1)</script>')
})

test('#240 SE-2 an unknown operation renders a generic message without its payload', () => {
  const mail = renderMail(
    {
      id: 'op-3:0',
      effect: 'send-something-new',
      recipient: 'person@example.test',
      payload: { to: 'principal-3', secret: 'restricted value' },
    },
    PUBLIC_URL
  )
  expect(mail.subject).toBe('enform: notification')
  expect(mail.text).toContain('send-something-new')
  expect(mail.text).not.toContain('restricted value')
})

test('#240 SE-1 a row without a resolved email address is refused', () => {
  expect(() =>
    renderMail(
      { id: 'op-4:0', effect: ASSIGNMENT_EMAIL, payload: { to: 'principal-4', step: 'request' } },
      PUBLIC_URL
    )
  ).toThrow(/no email address/)
})

test('#240 SE-1 doctor reports a missing SMTP configuration as optional', async () => {
  const check = await checkMail(defaultConfig)
  expect(check.ok).toBe(true)
  expect(check.detail).toContain('not configured')
})
