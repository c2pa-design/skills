import json
import threading

TTL_SECONDS = 86400
KEY_PREFIX = "webhook:"


class RedisDedupe:
    def __init__(self, client):
        self.client = client

    def claim(self, msg_id: str) -> bool:
        return bool(self.client.set(KEY_PREFIX + msg_id, 1, nx=True, ex=TTL_SECONDS))

    def release(self, msg_id: str) -> None:
        self.client.delete(KEY_PREFIX + msg_id)


class RedisQueue:
    def __init__(self, client, key: str):
        self.client = client
        self.key = key

    def enqueue(self, event: dict) -> None:
        self.client.lpush(self.key, json.dumps(event))


class MemoryDedupe:
    def __init__(self):
        self.seen: set[str] = set()
        self.lock = threading.Lock()

    def claim(self, msg_id: str) -> bool:
        with self.lock:
            if msg_id in self.seen:
                return False
            self.seen.add(msg_id)
            return True

    def release(self, msg_id: str) -> None:
        with self.lock:
            self.seen.discard(msg_id)
