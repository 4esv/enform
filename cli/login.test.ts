import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

// Issue #258, DX-3, S01, ID-6, ADR 0012: `enform login`. The CLI signs in
// through the identity provider's OAuth device authorization flow: it asks
// the server which provider and client to use, requests a device code,
// shows the person the verification URL and the user code, polls the token
// endpoint until the person approved, and stores the credential per server
// with its refresh token. A scripted sign-in takes a username and a password
// (the local directory, ID-6) for the tests and for automation. A stored
// credential past its expiry is refreshed before a command uses it. The
// checks run against a stub provider, so they read no real identity
// provider.

type Credential = {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
  readonly tokenEndpoint: string
  readonly clientId: string
}

type Login = {
  deviceLogin: (options: {
    server: string
    fetch: typeof fetch
    now: () => number
    sleep: (ms: number) => Promise<void>
    write: (line: string) => void
  }) => Promise<Credential>
  passwordLogin: (options: {
    server: string
    username: string
    password: string
    fetch: typeof fetch
    now: () => number
  }) => Promise<Credential>
  freshCredential: (
    credential: Credential,
    options: { fetch: typeof fetch; now: () => number }
  ) => Promise<Credential>
  readCredential: (path: string, server: string) => Credential | undefined
  writeCredential: (path: string, server: string, credential: Credential) => void
}

/** The module under test, resolved at run time: the file must type-check while the module is absent (#258). */
const LOGIN_MODULE = './login.js'

async function loginModule(): Promise<Login> {
  return (await import(LOGIN_MODULE)) as unknown as Login
}

/** The stub: the enform server's auth description and the provider's two endpoints. */
let server: Server
let base = ''
let tokenPolls = 0
let refreshes = 0

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const body = await new Promise<string>((resolve) => {
      let text = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        text += chunk
      })
      req.on('end', () => resolve(text))
    })
    const form = new URLSearchParams(body)
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (url === '/api/v1/auth/cli') {
      return json(200, {
        clientId: 'enform-cli',
        deviceAuthorizationEndpoint: `${base}/device`,
        tokenEndpoint: `${base}/token`,
      })
    }
    if (url === '/device') {
      if (form.get('client_id') !== 'enform-cli') return json(400, { error: 'invalid_client' })
      return json(200, {
        device_code: 'dev-1',
        user_code: 'ABCD-EFGH',
        verification_uri: `${base}/verify`,
        verification_uri_complete: `${base}/verify?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 0,
      })
    }
    if (url === '/token') {
      const grant = form.get('grant_type')
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        tokenPolls += 1
        if (form.get('device_code') !== 'dev-1') return json(400, { error: 'invalid_grant' })
        if (tokenPolls < 3) return json(400, { error: 'authorization_pending' })
        return json(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 300,
          token_type: 'Bearer',
        })
      }
      if (grant === 'password') {
        if (form.get('username') !== 'sam' || form.get('password') !== 'pw') {
          return json(401, { error: 'invalid_grant' })
        }
        return json(200, {
          access_token: 'access-pw',
          refresh_token: 'refresh-pw',
          expires_in: 300,
        })
      }
      if (grant === 'refresh_token') {
        refreshes += 1
        if (form.get('refresh_token') !== 'refresh-1') return json(400, { error: 'invalid_grant' })
        return json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 300 })
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    json(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

test('#258 login signs in through the device flow and stores the credential per server', async () => {
  const { deviceLogin, readCredential, writeCredential } = await loginModule()
  const lines: string[] = []
  const credential = await deviceLogin({
    server: base,
    fetch,
    now: () => 1_000_000,
    sleep: async () => {},
    write: (line) => lines.push(line),
  })
  // The person sees where to go and which code to confirm (S01, SSO device flow).
  expect(lines.join('\n')).toContain('ABCD-EFGH')
  expect(lines.join('\n')).toContain(`${base}/verify`)
  // The CLI polled until the person approved, then kept the tokens.
  expect(tokenPolls).toBe(3)
  expect(credential).toEqual({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1_000_000 + 300_000,
    tokenEndpoint: `${base}/token`,
    clientId: 'enform-cli',
  })
  // The credential is stored per server, and read back for that server only.
  const path = join(mkdtempSync(join(tmpdir(), 'enform-login-')), 'credentials.json')
  writeCredential(path, base, credential)
  expect(readCredential(path, base)).toEqual(credential)
  expect(readCredential(path, 'http://other.test')).toBeUndefined()
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ [base]: credential })
})

test('#258 a scripted login takes a username and a password, and a stale credential is refreshed', async () => {
  const { passwordLogin, freshCredential } = await loginModule()
  const signedIn = await passwordLogin({
    server: base,
    username: 'sam',
    password: 'pw',
    fetch,
    now: () => 0,
  })
  expect(signedIn.accessToken).toBe('access-pw')
  await expect(
    passwordLogin({ server: base, username: 'sam', password: 'wrong', fetch, now: () => 0 })
  ).rejects.toThrow(/sign-in/)

  // A credential that is still fresh is answered as it is; one past its
  // expiry is refreshed through the refresh token (ADR 0012).
  const stale: Credential = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 100_000,
    tokenEndpoint: `${base}/token`,
    clientId: 'enform-cli',
  }
  // Fresh means more than the ten-second margin before the expiry, so a
  // command in flight does not outlive its token.
  expect(await freshCredential(stale, { fetch, now: () => 50_000 })).toEqual(stale)
  const refreshed = await freshCredential(stale, { fetch, now: () => 200_000 })
  expect(refreshes).toBe(1)
  expect(refreshed).toEqual({
    ...stale,
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: 500_000,
  })
  // A credential whose refresh token is gone cannot be refreshed: the person
  // signs in again, and the message says so.
  await expect(
    freshCredential({ ...stale, refreshToken: 'gone' }, { fetch, now: () => 200_000 })
  ).rejects.toThrow(/enform login/)
})
