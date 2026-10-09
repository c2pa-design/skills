const TTL_SECONDS = 86400;
const KEY_PREFIX = 'webhook:';

export class RedisDedupe {
  constructor(client) {
    this.client = client;
  }

  async claim(id) {
    return (await this.client.set(`${KEY_PREFIX}${id}`, '1', { NX: true, EX: TTL_SECONDS })) === 'OK';
  }

  async release(id) {
    await this.client.del(`${KEY_PREFIX}${id}`);
  }
}

export class RedisQueue {
  constructor(client, key) {
    this.client = client;
    this.key = key;
  }

  async enqueue(event) {
    await this.client.lPush(this.key, JSON.stringify(event));
  }
}

export class MemoryDedupe {
  seen = new Set();

  async claim(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }

  async release(id) {
    this.seen.delete(id);
  }
}
