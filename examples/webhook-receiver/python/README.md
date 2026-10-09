# Python receiver

Standard library `http.server` and `redis`. Python 3.10+.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
export C2PA_WEBHOOK_SECRET=whsec_...
export REDIS_URL=redis://localhost:6379/0
python server.py
pytest
```

`receiver.py` signs, verifies and handles the request (`Receiver.handle(headers, body) ->
status`, framework-agnostic: call it from FastAPI with `await request.body()` or from Flask with
`request.get_data()`); `store.py` holds `RedisDedupe`, `RedisQueue` and the test-only
`MemoryDedupe`.
