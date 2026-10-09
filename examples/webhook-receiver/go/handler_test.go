package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	testSecret     = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
	testDeliveryID = "msg_1"
	webhookPath    = "/webhooks/c2pa"
)

var errDown = errors.New("store down")

type fakeQueue struct {
	events []event
	fail   bool
}

func (q *fakeQueue) enqueue(_ context.Context, e event) error {
	if q.fail {
		return errDown
	}

	q.events = append(q.events, e)

	return nil
}

type failingDedupe struct{}

func (failingDedupe) claim(context.Context, string) (bool, error) { return false, errDown }

func (failingDedupe) release(context.Context, string) error { return errDown }

type fixture struct {
	h     *handler
	v     *verifier
	queue *fakeQueue
	now   time.Time
}

type delivery struct {
	id        string
	timestamp string
	signature string
	body      string
}

type vector struct {
	Name      string `json:"name"`
	Secret    string `json:"secret"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Body      string `json:"body"`
	Signature string `json:"signature"`
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	v, err := newVerifier(testSecret)
	require.NoError(t, err)

	f := &fixture{v: v, queue: &fakeQueue{}, now: time.Now()}
	f.h = &handler{
		verifier: v,
		dedupe:   newMemoryDedupe(),
		queue:    f.queue,
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:      func() time.Time { return f.now },
	}

	return f
}

func envelope(typ string) string {
	return `{"id":"0199b1f2-6c1e-7a3b-9d4e-5f6a7b8c9d0e","type":"` + typ +
		`","created_at":"2026-10-09T00:00:00Z","occurred_at":"2026-10-09T00:00:00Z","data":{"x":1}}`
}

func (f *fixture) signed(body string) delivery {
	return f.signedAs(testDeliveryID, body)
}

func (f *fixture) signedAs(id, body string) delivery {
	ts := strconv.FormatInt(f.now.Unix(), 10)

	return delivery{id: id, timestamp: ts, signature: f.v.sign(id, ts, []byte(body)), body: body}
}

func (f *fixture) send(d delivery) int {
	req := httptest.NewRequest(http.MethodPost, webhookPath, strings.NewReader(d.body))
	req.Header.Set("webhook-id", d.id)
	req.Header.Set("webhook-timestamp", d.timestamp)
	req.Header.Set("webhook-signature", d.signature)

	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)

	return rec.Code
}

func TestHandler(t *testing.T) {
	t.Run("valid signature is accepted and enqueued", func(t *testing.T) {
		f := newFixture(t)

		code := f.send(f.signed(envelope("asset.lost")))

		assert.Equal(t, http.StatusNoContent, code)
		require.Len(t, f.queue.events, 1)
		assert.Equal(t, "asset.lost", f.queue.events[0].Type)
	})

	t.Run("every documented event type is enqueued", func(t *testing.T) {
		f := newFixture(t)

		for typ := range knownTypes {
			assert.Equal(t, http.StatusNoContent, f.send(f.signedAs(typ, envelope(typ))), typ)
		}

		assert.Len(t, f.queue.events, len(knownTypes))
	})

	t.Run("tampered body is rejected", func(t *testing.T) {
		f := newFixture(t)
		d := f.signed(envelope("asset.lost"))
		d.body = strings.Replace(d.body, `"x":1`, `"x":2`, 1)

		assert.Equal(t, http.StatusUnauthorized, f.send(d))
		assert.Empty(t, f.queue.events)
	})

	t.Run("stale timestamp is rejected", func(t *testing.T) {
		f := newFixture(t)
		d := f.signed(envelope("asset.lost"))
		f.now = f.now.Add(10 * time.Minute)

		assert.Equal(t, http.StatusUnauthorized, f.send(d))
	})

	t.Run("future timestamp is rejected", func(t *testing.T) {
		f := newFixture(t)
		d := f.signed(envelope("asset.lost"))
		f.now = f.now.Add(-10 * time.Minute)

		assert.Equal(t, http.StatusUnauthorized, f.send(d))
	})

	t.Run("malformed timestamps are rejected", func(t *testing.T) {
		f := newFixture(t)

		for _, ts := range []string{"abc", "-1", "+1757000000", "1e9", "99999999999999999999", " 1757000000"} {
			d := f.signed(envelope("ping"))
			d.timestamp = ts
			d.signature = f.v.sign(d.id, ts, []byte(d.body))

			assert.Equal(t, http.StatusUnauthorized, f.send(d), ts)
		}
	})

	t.Run("missing headers are rejected", func(t *testing.T) {
		f := newFixture(t)

		for _, strip := range []func(*delivery){
			func(d *delivery) { d.id = "" },
			func(d *delivery) { d.timestamp = "" },
			func(d *delivery) { d.signature = "" },
		} {
			d := f.signed(envelope("ping"))
			strip(&d)

			assert.Equal(t, http.StatusUnauthorized, f.send(d))
		}
	})

	t.Run("one valid signature among several is accepted", func(t *testing.T) {
		f := newFixture(t)
		d := f.signed(envelope("ping"))
		d.signature = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=  garbage " + d.signature

		assert.Equal(t, http.StatusNoContent, f.send(d))
	})

	t.Run("signatures that all mismatch are rejected", func(t *testing.T) {
		f := newFixture(t)
		d := f.signed(envelope("ping"))
		d.signature = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,"

		assert.Equal(t, http.StatusUnauthorized, f.send(d))
	})

	t.Run("redelivery is acknowledged without reprocessing", func(t *testing.T) {
		f := newFixture(t)
		d := f.signed(envelope("asset.lost"))
		f.send(d)

		code := f.send(d)

		assert.Equal(t, http.StatusOK, code)
		assert.Len(t, f.queue.events, 1)
	})

	t.Run("signed but invalid envelope is 400 and does not consume the id", func(t *testing.T) {
		f := newFixture(t)

		for _, body := range []string{
			"not json",
			`[]`,
			`{"id":"e","type":"ping","created_at":"2026-10-09T00:00:00Z","data":{}}`,
			`{"id":"e","type":"ping","created_at":"x","occurred_at":"2026-10-09T00:00:00Z","data":{}}`,
			`{"id":"e","type":"ping","created_at":"2026-10-09T00:00:00Z","occurred_at":"2026-10-09T00:00:00Z","data":null}`,
			`{"type":"ping","created_at":"2026-10-09T00:00:00Z","occurred_at":"2026-10-09T00:00:00Z","data":{}}`,
		} {
			assert.Equal(t, http.StatusBadRequest, f.send(f.signed(body)), body)
		}

		assert.Equal(t, http.StatusNoContent, f.send(f.signed(envelope("ping"))))
	})

	t.Run("unknown type is acknowledged and not enqueued", func(t *testing.T) {
		f := newFixture(t)

		assert.Equal(t, http.StatusOK, f.send(f.signed(envelope("something.new"))))
		assert.Empty(t, f.queue.events)
	})

	t.Run("enqueue failure releases the id and returns 503", func(t *testing.T) {
		f := newFixture(t)
		d := f.signed(envelope("asset.lost"))
		f.queue.fail = true

		assert.Equal(t, http.StatusServiceUnavailable, f.send(d))

		f.queue.fail = false

		assert.Equal(t, http.StatusNoContent, f.send(d))
	})

	t.Run("dedupe store failure returns 503", func(t *testing.T) {
		f := newFixture(t)
		f.h.dedupe = failingDedupe{}

		assert.Equal(t, http.StatusServiceUnavailable, f.send(f.signed(envelope("asset.lost"))))
		assert.Empty(t, f.queue.events)
	})

	t.Run("body over 1 MiB is rejected", func(t *testing.T) {
		f := newFixture(t)

		assert.Equal(t, http.StatusRequestEntityTooLarge, f.send(f.signed(strings.Repeat("a", maxBody+1))))
	})
}

func TestNewVerifier(t *testing.T) {
	for _, secret := range []string{"", "whsec_", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "whsec_q-8_Zt3x-Rb1Yk_PQ2mN7wLs-Vh4Jc9A", "whsec_abc"} {
		t.Run("rejects "+secret, func(t *testing.T) {
			_, err := newVerifier(secret)

			assert.ErrorIs(t, err, errSecret)
		})
	}
}

func TestSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../vectors.json")
	require.NoError(t, err)

	var vectors []vector
	require.NoError(t, json.Unmarshal(raw, &vectors))
	require.NotEmpty(t, vectors)

	for _, vec := range vectors {
		t.Run(vec.Name, func(t *testing.T) {
			v, verr := newVerifier(vec.Secret)
			require.NoError(t, verr)

			sec, perr := strconv.ParseInt(vec.Timestamp, 10, 64)
			require.NoError(t, perr)

			h := http.Header{}
			h.Set("webhook-id", vec.ID)
			h.Set("webhook-timestamp", vec.Timestamp)
			h.Set("webhook-signature", vec.Signature)

			assert.NoError(t, v.verify(h, []byte(vec.Body), time.Unix(sec, 0)))
		})
	}
}
