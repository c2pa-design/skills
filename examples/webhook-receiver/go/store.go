package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	dedupeTTL       = 24 * time.Hour
	dedupeKeyPrefix = "webhook:"
)

type dedupe interface {
	claim(ctx context.Context, id string) (bool, error)
	release(ctx context.Context, id string) error
}

type queue interface {
	enqueue(ctx context.Context, e event) error
}

type redisDedupe struct {
	rdb *redis.Client
}

func (d redisDedupe) claim(ctx context.Context, id string) (bool, error) {
	return d.rdb.SetNX(ctx, dedupeKeyPrefix+id, 1, dedupeTTL).Result()
}

func (d redisDedupe) release(ctx context.Context, id string) error {
	return d.rdb.Del(context.WithoutCancel(ctx), dedupeKeyPrefix+id).Err()
}

type redisQueue struct {
	rdb *redis.Client
	key string
}

func (q redisQueue) enqueue(ctx context.Context, e event) error {
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}

	return q.rdb.LPush(ctx, q.key, payload).Err()
}

type memoryDedupe struct {
	mu   sync.Mutex
	seen map[string]struct{}
}

func newMemoryDedupe() *memoryDedupe {
	return &memoryDedupe{seen: map[string]struct{}{}}
}

func (d *memoryDedupe) claim(_ context.Context, id string) (bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if _, ok := d.seen[id]; ok {
		return false, nil
	}

	d.seen[id] = struct{}{}

	return true, nil
}

func (d *memoryDedupe) release(_ context.Context, id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	delete(d.seen, id)

	return nil
}
