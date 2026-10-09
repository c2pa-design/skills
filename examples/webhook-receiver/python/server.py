import logging
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis

from receiver import MAX_BODY, Receiver, webhook_key
from store import RedisDedupe, RedisQueue

REQUEST_TIMEOUT_SECONDS = 10


def make_handler(receiver: Receiver):
    class Handler(BaseHTTPRequestHandler):
        timeout = REQUEST_TIMEOUT_SECONDS

        def do_POST(self):
            if self.path.split("?")[0] != "/webhooks/c2pa":
                return self.reply(404)
            if self.headers.get("transfer-encoding"):
                return self.reply(411)
            length = self.headers.get("content-length", "")
            if not length.isascii() or not length.isdigit():
                return self.reply(411)
            if int(length) > MAX_BODY:
                return self.reply(413)
            body = self.rfile.read(int(length))
            if len(body) != int(length):
                return self.reply(400)
            self.reply(receiver.handle(dict(self.headers.items()), body))

        def reply(self, status: int):
            self.send_response(status)
            self.send_header("content-length", "0")
            if status >= 400:
                self.send_header("connection", "close")
                self.close_connection = True
            self.end_headers()

        def log_message(self, *args):
            pass

    return Handler


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    key = webhook_key(os.environ.get("C2PA_WEBHOOK_SECRET"))
    client = redis.Redis.from_url(os.environ.get("REDIS_URL") or "redis://localhost:6379/0")
    queue = RedisQueue(client, os.environ.get("C2PA_WEBHOOK_QUEUE") or "c2pa:webhooks")
    server = ThreadingHTTPServer(("", int(os.environ.get("PORT") or "8000")), make_handler(Receiver(key, RedisDedupe(client), queue)))
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        client.close()


if __name__ == "__main__":
    main()
