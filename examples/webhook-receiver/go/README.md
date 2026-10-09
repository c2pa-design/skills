# Go receiver

`net/http`, the standard library and `github.com/redis/go-redis/v9` (tests add `testify`). Go 1.24+.

```bash
export C2PA_WEBHOOK_SECRET=whsec_...
export REDIS_URL=redis://localhost:6379/0
go run .
go test ./...
```

`verify.go` signs and verifies, `handler.go` is the endpoint, `store.go` holds the `Dedupe` and
`queue` interfaces with Redis implementations and the test-only `memoryDedupe`. `main.go` sets
server timeouts and shuts down on `SIGTERM`, closing the Redis client.
