import { expect, test } from 'vitest'
import { templateCatalog } from '../server/mail.js'

// Issue #269, SE-2, A4: the catalog of email templates. Each event type that
// SE-2 names has a template with its variables and a preview rendered from
// a sample entry, so an administrator reads what each message says before
// it is sent. The catalog is deterministic (I6): the same public URL gives
// the same previews. Expected to fail until the catalog exists.

const PUBLIC_URL = 'https://forms.example.test'

test.fails('#269 SE-2 the catalog holds one template per event type with its variables and a preview', () => {
  const catalog = templateCatalog(PUBLIC_URL)
  expect(catalog.map((template) => template.effect).sort()).toEqual(
    [
      'send-assignment',
      'send-escalation',
      'send-reminder',
      'send-sent-back',
      'send-takeover',
      'send-undone',
      'send-unroutable',
      'send-withdrawn-cancelled',
    ].sort()
  )
  for (const template of catalog) {
    expect(template.label.length, `${template.effect} has a label`).toBeGreaterThan(3)
    expect(template.variables, `${template.effect} names its variables`).toContain('step')
    expect(template.preview.subject).toMatch(/^enform: /)
    expect(template.preview.text, `${template.effect} previews a body`).toContain(PUBLIC_URL)
    expect(template.preview.text, 'a preview carries no form value').not.toContain(
      'Three extra credits'
    )
  }
  const sentBack = catalog.find((template) => template.effect === 'send-sent-back')
  expect(sentBack?.variables).toEqual(expect.arrayContaining(['comment', 'actor']))
  expect(sentBack?.preview.text).toContain('review')
  // Deterministic (I6): two reads give the same previews.
  expect(templateCatalog(PUBLIC_URL)).toEqual(catalog)
})
