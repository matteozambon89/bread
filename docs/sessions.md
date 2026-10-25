# Sessions

A session is a durable conversation thread: it stores the message history that gets replayed into
each run. Sessions persist through the configured [store](./store.md) (PostgreSQL by default).

## Using sessions

Pass a `session` to `bread.run()`. Omit the id to start a fresh one; reuse an id to continue:

```ts
// start / continue a session, tagged for later lookup
bread.run('writer', { topic: 'bread' }, {
  session: { id: 'user-42', tags: { user: '42', plan: 'pro' } },
})
```

Over HTTP the body field is the same: `{ "input": {...}, "session": { "id": "user-42" } }`.

## Managing sessions

The instance exposes the store at `bread.store`:

```ts
await bread.store.listSessions({ tags: { user: '42' } })
await bread.store.getSession('user-42')
await bread.store.getMessages('user-42')
await bread.store.deleteSession('user-42')
await bread.store.cleanupSessions({ olderThanMs: 30 * 24 * 60 * 60 * 1000, tags: { plan: 'free' } })
```

From the CLI:

```bash
bread sessions list --tag user=42
bread sessions cleanup --older-than 30 --tag plan=free
```

## ⚠️ Cleanup with a SQLite store

With the Postgres store, `bread sessions cleanup` and a running server share the database safely.
With a SQLite store (`@breadai/store-sqlite`), the CLI opens its **own writable**
connection to the same file as a running `bread dev`/`bread start` server, and concurrent writes can
raise `SQLITE_BUSY`. Run cleanup when the server is stopped, or schedule it during a quiet window.
(WAL mode reduces but does not eliminate the contention.)

## Ownership

A session may carry a `principal` (`iss`, `sub`, and an optional `tenant`). `run` stamps
`RunOptions.principal` when it creates the session. It does not read a principal from tags
or from the request body.

`principalVisible(stored, caller)`, exported from `@breadai/core`, is the only ownership check:

- No caller is unscoped. Every row is visible, including a row with no principal.
- A caller matches `iss` and `sub` only. `tenant` is not compared.
- A row with no principal is hidden from a caller.

Unauthenticated loopback `POST /agents/:id/run` and `POST /pipelines/:id/run` stamp
`{ iss: "https://bread.local/cli", sub: "local" }`, the same principal `bread chat` and
`bread invoke` pass. On open, only that principal claims a null stored principal and
writes it onto the row. Any other caller still gets `SESSION_NOT_FOUND`.
`principalVisible` does not treat the null row as visible before that claim.

`run` throws `SESSION_NOT_FOUND` before `agent:run:start` when the requested session fails
that check. It does not create another session on top of the hidden row, and it does not run
`beforeRun`.

HTTP `GET /sessions`, `GET /sessions/:id`, `DELETE /sessions/:id`, and `POST /sessions/cleanup`
use the same check when `identity.principal` is set. A hidden get is `404`. A hidden delete
returns `{ "ok": true }` and does not delete the row. That delete is one store write on the
id, a non-null principal, and matching `iss` and `sub`, so a row removed and recreated under
another principal is left in place. Cleanup passes the caller into
`cleanupSessions` and returns that count. Age, tags, and the caller are one store predicate.
With no principal those routes stay unscoped.

When `identity.principal` is set, `POST /resume/:checkpointId` returns
`404 { "error": "Checkpoint not found" }` unless the stored principal is visible and `runVisible`
passes for the suspended run. A missing checkpoint is the same `404`.
In-process `bread.resume` stays keyed by checkpoint id, restores the stored principal, and takes
no principal argument.

`GET /runs/:runId/stream` and `POST /runs/:runId/cancel` apply the same check to the run's
owner with `runVisible`: the principal the run is live under on this replica, otherwise the
principal on its `agent:run:start` crumb. A run the caller cannot see is the same `404` as an
unknown run. When auth is configured, a caller with no principal, such as an API key, is `403`
on both routes, as on run start and resume.

`bread.store` does not apply the check. `bread sessions` reads and deletes through the store, so
a CLI list or cleanup is unscoped.

### Upgrading from an unscoped release

Sessions, checkpoints, and runs created before principals existed have no stored principal.
After the upgrade:

- An authenticated caller gets `404` on those sessions and their runs, and `404` on resuming
  their checkpoints. They are left out of `GET /sessions` and `POST /sessions/cleanup`.
- The local CLI principal claims a null session when it opens it, so `bread chat` and
  `bread invoke` keep working on their own history.
- `bread sessions` reads through the store with no caller, so it can still list and clean up
  those rows.

To hand old sessions to their users, set the `principal` column (JSON with `iss` and `sub`) on
the session rows before you turn on auth, for example from a tag you already keep. There is no
HTTP claim route, because any caller could claim an unowned row through it. Runs that were
already logged keep their unstamped `agent:run:start`, so their streams stay `404` to
authenticated callers.
