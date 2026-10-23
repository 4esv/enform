// Issue #240, SE-1, SE-2, I3, I13, ADR 0003: the mail transport and the
// templates of the outbox. The worker is the only caller: it renders one
// message per outbox row from the row's own payload (recipient, step, reason,
// comment) and the flow/instance link, so a template never reads a form value
// and never leaks a restricted value. The templates are deterministic (I6);
// the only variable outside the row is the public URL that `enform init`
// wrote.
//
// A missing SMTP URL is not an error (SE-1): the worker reports the queued
// work and sends nothing, so a small installation runs without a mail server.
// A configured URL is a real SMTP transport (Mailpit in dev and CI, the
// installation's server in production); there is no fake sink in this path.

import { createTransport, type Transporter } from 'nodemailer'
import { ESCALATION_EMAIL, REMINDER_EMAIL } from '../engine/reminders.js'
import { UNROUTABLE_ALERT } from '../engine/routing.js'
import { SENT_BACK_NOTIFICATION } from '../engine/sendBack.js'
import { ASSIGNMENT_EMAIL } from '../engine/submission.js'
import { TAKEOVER_NOTIFICATION } from '../engine/takeover.js'
import { UNDO_NOTIFICATION } from '../engine/undo.js'
import { WITHDRAW_CANCEL_NOTIFICATION } from '../engine/withdraw.js'
import type { Config } from './config.js'

/** One outbox row as the worker reads it (SE-1, SE-2). */
export type MailEntry = {
  readonly id: string
  readonly effect: string
  readonly payload: Readonly<Record<string, unknown>>
  /**
   * The recipient's email address, resolved from the `principals` projection
   * (ADR 0012). The engine records a principal id in the payload, never a
   * mutable address; the worker resolves it at send time.
   */
  readonly recipient?: string
  readonly instanceId?: string
  readonly flowSlug?: string
}

/** One rendered email: the subject and the two bodies that the transport sends. */
export type RenderedMail = {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html: string
}

/** The one SMTP transport of a worker, and the way to close it (SE-1). */
export type Mailer = {
  readonly send: (entry: MailEntry) => Promise<void>
  readonly verify: () => Promise<void>
  readonly close: () => void
}

/**
 * Create the worker's SMTP transport, or undefined when the configuration has
 * no SMTP URL (SE-1). One transport lives for the life of the worker.
 */
export function createMailer(config: Config): Mailer | undefined {
  const smtpUrl = config.mail.smtpUrl.trim()
  if (smtpUrl === '') return undefined
  const transport: Transporter = createTransport(smtpUrl)
  return {
    send: async (entry) => {
      const rendered = renderMail(entry, config.publicUrl)
      await transport.sendMail({
        from: config.mail.from,
        to: rendered.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      })
    },
    verify: async () => {
      await transport.verify()
    },
    close: () => {
      transport.close()
    },
  }
}

/**
 * Render one outbox row into an email (SE-2). The body uses only the row's
 * payload and the absolute flow/instance link; it carries no form value. The
 * HTML body escapes every value.
 */
export function renderMail(entry: MailEntry, publicUrl: string): RenderedMail {
  const to = textOf(entry.recipient)
  if (to === undefined) {
    throw new Error(`mail: ${entry.effect} has no email address for its recipient`)
  }
  const step = textOf(entry.payload.step)
  const link = linkOf(entry, publicUrl)
  const template = templateOf(entry)
  return {
    to,
    subject: template.subject(step),
    text: [...template.lines(step), `Open the task: ${link}`, '', 'enform'].join('\n'),
    html: [
      '<!doctype html><html><body>',
      ...template.lines(step).map((line) => `<p>${escapeHtml(line)}</p>`),
      `<p><a href="${escapeHtml(link)}">Open the task</a></p>`,
      '<p>enform</p>',
      '</body></html>',
    ].join(''),
  }
}

/**
 * Check the configured SMTP connection for `enform doctor` (DE-5, SE-1). A
 * missing SMTP URL is a passing, optional check: the worker leaves the outbox
 * queued and sends nothing.
 */
export async function checkMail(config: Config): Promise<{ ok: boolean; detail: string }> {
  const smtpUrl = config.mail.smtpUrl.trim()
  if (smtpUrl === '') {
    return { ok: true, detail: 'not configured; the worker leaves the outbox queued' }
  }
  const mailer = createMailer(config)
  if (mailer === undefined) return { ok: true, detail: 'not configured' }
  try {
    await mailer.verify()
    return { ok: true, detail: `${redactUrl(smtpUrl)} as ${config.mail.from}` }
  } catch (error) {
    return { ok: false, detail: messageOf(error) }
  } finally {
    mailer.close()
  }
}

/** One template: a subject and the body lines that it builds from the row. */
type Template = {
  readonly subject: (step: string | undefined) => string
  readonly lines: (step: string | undefined) => readonly string[]
}

/**
 * The template of one connector operation (SE-2). The eight event types that
 * SE-2 names each have a template; an unknown operation gets a generic
 * notification that carries no payload value.
 */
function templateOf(entry: MailEntry): Template {
  const stepSuffix = (step: string | undefined): string => (step === undefined ? '' : ` (${step})`)
  if (entry.effect === ASSIGNMENT_EMAIL) {
    return {
      subject: (step) => `enform: task assigned${stepSuffix(step)}`,
      lines: (step) => [
        `A task is waiting for you${step === undefined ? '' : ` at the ${step} step`}.`,
      ],
    }
  }
  if (entry.effect === SENT_BACK_NOTIFICATION) {
    return {
      subject: (step) => `enform: task sent back${stepSuffix(step)}`,
      lines: (step) => [
        `A task was sent back to you${step === undefined ? '' : ` at the ${step} step`}.`,
        ...reasonLine(entry, 'comment'),
        ...actorLine(entry),
      ],
    }
  }
  if (entry.effect === TAKEOVER_NOTIFICATION) {
    return {
      subject: (step) => `enform: task taken over${stepSuffix(step)}`,
      lines: (step) => [
        `Your task${step === undefined ? '' : ` at the ${step} step`} was taken over.`,
        ...reasonLine(entry, 'reason'),
        ...actorLine(entry),
      ],
    }
  }
  if (entry.effect === WITHDRAW_CANCEL_NOTIFICATION) {
    return {
      subject: (step) => `enform: task withdrawn or cancelled${stepSuffix(step)}`,
      lines: (step) => [
        `A task${step === undefined ? '' : ` at the ${step} step`} was withdrawn or cancelled.`,
        ...reasonLine(entry, 'reason'),
        ...actorLine(entry),
      ],
    }
  }
  if (entry.effect === UNDO_NOTIFICATION) {
    return {
      subject: () => 'enform: change undone',
      lines: () => ['A change that reached you was undone.', ...reasonLine(entry, 'reason')],
    }
  }
  if (entry.effect === REMINDER_EMAIL) {
    return {
      subject: (step) => `enform: reminder${stepSuffix(step)}`,
      lines: (step) => [
        `A task is still waiting${step === undefined ? '' : ` at the ${step} step`}.`,
      ],
    }
  }
  if (entry.effect === ESCALATION_EMAIL) {
    return {
      subject: (step) => `enform: escalation${stepSuffix(step)}`,
      lines: (step) => [
        `A task${step === undefined ? '' : ` at the ${step} step`} reached its deadline.`,
      ],
    }
  }
  if (entry.effect === UNROUTABLE_ALERT) {
    return {
      subject: (step) => `enform: task is unroutable${stepSuffix(step)}`,
      lines: (step) => [
        `A task${step === undefined ? '' : ` at the ${step} step`} resolved to nobody and is in the Unroutable queue.`,
      ],
    }
  }
  return {
    subject: (step) => `enform: notification${stepSuffix(step)}`,
    lines: () => [`enform recorded the notification ${entry.effect} for you.`],
  }
}

/** The absolute flow and instance link that every template carries (SE-2). */
function linkOf(entry: MailEntry, publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '')
  if (entry.flowSlug === undefined || entry.instanceId === undefined) return `${base}/app/`
  const query = `flow=${encodeURIComponent(entry.flowSlug)}&instance=${encodeURIComponent(entry.instanceId)}`
  return `${base}/app/?${query}`
}

/** The reason or comment of one row as one body line, when the row carries one. */
function reasonLine(entry: MailEntry, key: string): readonly string[] {
  const value = textOf(entry.payload[key])
  return value === undefined ? [] : [`Reason: ${value}`]
}

/** The actor of one row as one body line, when the row carries one. */
function actorLine(entry: MailEntry): readonly string[] {
  const actor = textOf(entry.payload.actor)
  return actor === undefined ? [] : [`By: ${actor}`]
}

/** Read one non-empty string field, or undefined. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Escape one value for the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Hide the credentials of an SMTP URL before `doctor` prints it. */
function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.password !== '') url.password = '***'
    if (url.username !== '') url.username = '***'
    return url.toString()
  } catch {
    return 'the configured SMTP URL'
  }
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
