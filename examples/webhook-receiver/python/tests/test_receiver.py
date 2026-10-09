import http.client
import json
import pathlib
import threading
import time
from http.server import ThreadingHTTPServer

import pytest

from receiver import KNOWN_TYPES, MAX_BODY, Receiver, SecretError, sign, verify, webhook_key
from server import make_handler
from store import MemoryDedupe

SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
KEY = webhook_key(SECRET)
VECTORS = pathlib.Path(__file__).resolve().parents[2] / "vectors.json"
DECOY = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="


class FakeQueue:
    def __init__(self):
        self.events = []
        self.fail = False

    def enqueue(self, event):
        if self.fail:
            raise RuntimeError("queue down")
        self.events.append(event)


class DownDedupe:
    def claim(self, msg_id):
        raise ConnectionError("store down")

    def release(self, msg_id):
        raise ConnectionError("store down")


def envelope(typ):
    return json.dumps(
        {
            "id": "0199b1f2-6c1e-7a3b-9d4e-5f6a7b8c9d0e",
            "type": typ,
            "created_at": "2026-10-09T00:00:00Z",
            "occurred_at": "2026-10-09T00:00:00Z",
            "data": {"x": 1},
        }
    ).encode()


class Env:
    def __init__(self):
        self.now = int(time.time())
        self.queue = FakeQueue()
        self.receiver = Receiver(KEY, MemoryDedupe(), self.queue, now=lambda: self.now)

    def send(self, payload, msg_id="msg_1", ts=None, signature=None):
        ts = str(self.now) if ts is None else ts
        headers = {"webhook-id": msg_id, "webhook-timestamp": ts}
        headers["webhook-signature"] = sign(KEY, msg_id, ts, payload) if signature is None else signature
        return self.receiver.handle({k: v for k, v in headers.items() if v}, payload)


@pytest.fixture
def env():
    return Env()


def test_valid_signature_is_accepted_and_enqueued(env):
    assert env.send(envelope("asset.lost")) == 204
    assert [e["type"] for e in env.queue.events] == ["asset.lost"]


def test_every_documented_event_type_is_enqueued(env):
    for typ in KNOWN_TYPES:
        assert env.send(envelope(typ), msg_id=typ) == 204, typ
    assert len(env.queue.events) == len(KNOWN_TYPES)


def test_tampered_body_is_rejected(env):
    payload = envelope("asset.lost")
    signature = sign(KEY, "msg_1", str(env.now), payload)
    assert env.send(payload.replace(b'"x": 1', b'"x": 2'), signature=signature) == 401
    assert env.queue.events == []


@pytest.mark.parametrize("offset", [-600, 600])
def test_stale_and_future_timestamps_are_rejected(env, offset):
    assert env.send(envelope("ping"), ts=str(env.now + offset)) == 401


@pytest.mark.parametrize("ts", ["abc", "-1", "+1757000000", "1e9", "99999999999999999999", "²", "١٢"])
def test_malformed_timestamps_are_rejected(env, ts):
    assert env.send(envelope("ping"), ts=ts) == 401


@pytest.mark.parametrize("missing", ["msg_id", "ts", "signature"])
def test_missing_headers_are_rejected(env, missing):
    assert env.send(envelope("ping"), **{missing: ""}) == 401


def test_one_valid_signature_among_several_is_accepted(env):
    payload = envelope("ping")
    good = sign(KEY, "msg_1", str(env.now), payload)
    assert env.send(payload, signature=f"{DECOY}  garbage {good}") == 204


def test_signatures_that_all_mismatch_are_rejected(env):
    assert env.send(envelope("ping"), signature=f"{DECOY} v1,") == 401


def test_redelivery_is_acknowledged_without_reprocessing(env):
    payload = envelope("asset.lost")
    assert env.send(payload) == 204
    assert env.send(payload) == 200
    assert len(env.queue.events) == 1


@pytest.mark.parametrize(
    "payload",
    [
        b"not json",
        b"[]",
        b"\xff\xfe",
        b"[" * 100000,
        b'{"id":"e","type":"ping","created_at":"2026-10-09T00:00:00Z","data":{}}',
        b'{"id":"e","type":"ping","created_at":"x","occurred_at":"2026-10-09T00:00:00Z","data":{}}',
        b'{"id":"e","type":"ping","created_at":"2026-10-09T00:00:00Z","occurred_at":"2026-10-09T00:00:00Z","data":null}',
        b'{"type":"ping","created_at":"2026-10-09T00:00:00Z","occurred_at":"2026-10-09T00:00:00Z","data":{}}',
    ],
)
def test_signed_invalid_envelope_is_400_and_does_not_consume_id(env, payload):
    assert env.send(payload) == 400
    assert env.send(envelope("ping")) == 204


def test_unknown_type_is_acknowledged_and_not_enqueued(env):
    assert env.send(envelope("something.new")) == 200
    assert env.queue.events == []


def test_enqueue_failure_releases_id_and_returns_503(env):
    payload = envelope("asset.lost")
    env.queue.fail = True
    assert env.send(payload) == 503
    env.queue.fail = False
    assert env.send(payload) == 204


def test_dedupe_store_failure_returns_503(env):
    env.receiver.dedupe = DownDedupe()
    assert env.send(envelope("asset.lost")) == 503
    assert env.queue.events == []


@pytest.mark.parametrize("secret", [None, "", "whsec_", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "whsec_q-8_Zt3x-Rb1Yk_PQ2mN7wLs-Vh4Jc9A", "whsec_abc", "whsec_éAAA"])
def test_bad_secret_fails(secret):
    with pytest.raises(SecretError):
        webhook_key(secret)


def test_shared_vectors_from_backend_verify():
    vectors = json.loads(VECTORS.read_text())
    assert vectors
    for v in vectors:
        headers = {"webhook-id": v["id"], "webhook-timestamp": v["timestamp"], "webhook-signature": v["signature"]}
        assert verify(webhook_key(v["secret"]), headers, v["body"].encode(), int(v["timestamp"])) is None, v["name"]


@pytest.fixture
def http_server():
    queue = FakeQueue()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Receiver(KEY, MemoryDedupe(), queue)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], queue
    server.shutdown()
    server.server_close()
    thread.join()


def post(port, payload, headers):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.putrequest("POST", "/webhooks/c2pa")
        for k, v in headers.items():
            conn.putheader(k, v)
        conn.endheaders()
        if payload:
            conn.send(payload)
        return conn.getresponse().status
    finally:
        conn.close()


def test_http_server_end_to_end(http_server):
    port, queue = http_server
    payload, ts = envelope("ping"), str(int(time.time()))
    headers = {"content-length": str(len(payload)), "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": sign(KEY, "msg_1", ts, payload)}
    assert post(port, payload, headers) == 204
    assert len(queue.events) == 1


@pytest.mark.parametrize(
    "headers,status",
    [
        ({"content-length": str(MAX_BODY + 1)}, 413),
        ({}, 411),
        ({"content-length": "abc"}, 411),
        ({"content-length": "-1"}, 411),
        ({"transfer-encoding": "chunked"}, 411),
    ],
)
def test_http_server_rejects_bad_framing_before_reading(http_server, headers, status):
    port, queue = http_server
    assert post(port, b"", headers) == status
    assert queue.events == []
