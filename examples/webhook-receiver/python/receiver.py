import base64
import binascii
import hashlib
import hmac
import json
import logging
import re
import time
from datetime import datetime
from typing import Callable, Mapping, Protocol

TOLERANCE_SECONDS = 300
MAX_BODY = 1 << 20
SECRET_PREFIX = "whsec_"
TIMESTAMP = re.compile(r"[0-9]{1,12}")
RFC3339 = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})")

KNOWN_TYPES = frozenset(
    {
        "ping",
        "verification.completed",
        "monitor.run.completed",
        "monitor.regression",
        "usage.threshold",
        "asset.lost",
        "asset.stripped_copy_seen",
        "digest.ready",
        "evidence_pack.ready",
    }
)

log = logging.getLogger("c2pa.webhooks")


class SecretError(ValueError):
    pass


def webhook_key(secret: str | None) -> bytes:
    if secret and secret.startswith(SECRET_PREFIX) and len(secret) > len(SECRET_PREFIX):
        try:
            return base64.b64decode(secret[len(SECRET_PREFIX) :], validate=True)
        except (binascii.Error, ValueError):
            pass
    raise SecretError("C2PA_WEBHOOK_SECRET is not whsec_ + standard base64")


def sign(key: bytes, msg_id: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(key, f"{msg_id}.{timestamp}.".encode() + body, hashlib.sha256).digest()
    return "v1," + base64.b64encode(mac).decode()


def verify(key: bytes, headers: Mapping[str, str], body: bytes, now: float) -> str | None:
    msg_id = headers.get("webhook-id")
    ts = headers.get("webhook-timestamp")
    signatures = headers.get("webhook-signature")
    if not msg_id or not ts or not signatures:
        return "missing headers"
    if not TIMESTAMP.fullmatch(ts) or abs(now - int(ts)) > TOLERANCE_SECONDS:
        return "timestamp outside tolerance"
    want = sign(key, msg_id, ts, body).encode()
    for candidate in signatures.split():
        if hmac.compare_digest(candidate.encode(), want):
            return None
    return "no matching signature"


def _is_time(value: object) -> bool:
    if not isinstance(value, str) or not RFC3339.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def parse_envelope(body: bytes) -> dict | None:
    try:
        event = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None
    if not isinstance(event, dict):
        return None
    if not all(isinstance(event.get(k), str) and event[k] for k in ("id", "type")):
        return None
    if not _is_time(event.get("created_at")) or not _is_time(event.get("occurred_at")):
        return None
    if not isinstance(event.get("data"), dict):
        return None
    return event


class Dedupe(Protocol):
    def claim(self, msg_id: str) -> bool: ...
    def release(self, msg_id: str) -> None: ...


class Queue(Protocol):
    def enqueue(self, event: dict) -> None: ...


class Receiver:
    def __init__(self, key: bytes, dedupe: Dedupe, queue: Queue, now: Callable[[], float] = time.time):
        self.key = key
        self.dedupe = dedupe
        self.queue = queue
        self.now = now

    def handle(self, headers: Mapping[str, str], body: bytes) -> int:
        headers = {k.lower(): v for k, v in headers.items()}
        reason = verify(self.key, headers, body, self.now())
        if reason:
            log.warning("webhook rejected reason=%s", reason)
            return 401

        delivery_id = headers["webhook-id"]
        event = parse_envelope(body)
        if event is None:
            log.warning("webhook body unparseable webhook_id=%s", delivery_id)
            return 400
        meta = f"webhook_id={delivery_id} id={event['id']} type={event['type']}"

        try:
            fresh = self.dedupe.claim(delivery_id)
        except Exception as err:
            log.error("webhook dedupe failed %s error=%s", meta, err)
            return 503
        if not fresh:
            log.info("webhook duplicate %s", meta)
            return 200

        if event["type"] not in KNOWN_TYPES:
            log.info("webhook ignored %s", meta)
            return 200

        try:
            self.queue.enqueue(event)
        except Exception as err:
            log.error("webhook enqueue failed %s error=%s", meta, err)
            try:
                self.dedupe.release(delivery_id)
            except Exception as release_err:
                log.error("webhook dedupe release failed %s error=%s", meta, release_err)
            return 503

        log.info("webhook accepted %s", meta)
        return 204
