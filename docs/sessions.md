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
With a SQLite store (`@bread/store-sqlite`), the CLI opens its **own writable**
connection to the same file as a running `bread dev`/`bread start` server, and concurrent writes can
raise `SQLITE_BUSY`. Run cleanup when the server is stopped, or schedule it during a quiet window.
(WAL mode reduces but does not eliminate the contention.)
