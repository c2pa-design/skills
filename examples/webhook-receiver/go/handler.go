package main

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"
)

const maxBody = 1 << 20

type event struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	CreatedAt  time.Time       `json:"created_at"`
	OccurredAt time.Time       `json:"occurred_at"`
	Data       json.RawMessage `json:"data"`
}

func (e event) valid() bool {
	return e.ID != "" && e.Type != "" && !e.CreatedAt.IsZero() && !e.OccurredAt.IsZero() &&
		len(e.Data) > 0 && e.Data[0] == '{'
}

var knownTypes = map[string]struct{}{
	"ping":                     {},
	"verification.completed":   {},
	"monitor.run.completed":    {},
	"monitor.regression":       {},
	"usage.threshold":          {},
	"asset.lost":               {},
	"asset.stripped_copy_seen": {},
	"digest.ready":             {},
	"evidence_pack.ready":      {},
}

type handler struct {
	verifier *verifier
	dedupe   dedupe
	queue    queue
	log      *slog.Logger
	now      func() time.Time
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		if maxErr := new(http.MaxBytesError); errors.As(err, &maxErr) {
			http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
			return
		}

		http.Error(w, "unreadable body", http.StatusBadRequest)

		return
	}

	if err = h.verifier.verify(r.Header, body, h.now()); err != nil {
		h.log.Warn("webhook rejected", "reason", err.Error())
		http.Error(w, "invalid signature", http.StatusUnauthorized)

		return
	}

	deliveryID := r.Header.Get("webhook-id")

	var e event
	if err = json.Unmarshal(body, &e); err != nil || !e.valid() {
		h.log.Warn("webhook body unparseable", "webhook_id", deliveryID)
		http.Error(w, "invalid body", http.StatusBadRequest)

		return
	}

	h.process(w, r, deliveryID, e)
}

func (h *handler) process(w http.ResponseWriter, r *http.Request, deliveryID string, e event) {
	ctx := r.Context()
	logger := h.log.With("webhook_id", deliveryID, "id", e.ID, "type", e.Type)

	fresh, err := h.dedupe.claim(ctx, deliveryID)
	if err != nil {
		logger.Error("webhook dedupe failed", "error", err.Error())
		http.Error(w, "retry", http.StatusServiceUnavailable)

		return
	}

	if !fresh {
		logger.Info("webhook duplicate")
		w.WriteHeader(http.StatusOK)

		return
	}

	if _, ok := knownTypes[e.Type]; !ok {
		logger.Info("webhook ignored")
		w.WriteHeader(http.StatusOK)

		return
	}

	if err = h.queue.enqueue(ctx, e); err != nil {
		logger.Error("webhook enqueue failed", "error", err.Error())

		if releaseErr := h.dedupe.release(ctx, deliveryID); releaseErr != nil {
			logger.Error("webhook dedupe release failed", "error", releaseErr.Error())
		}

		http.Error(w, "retry", http.StatusServiceUnavailable)

		return
	}

	logger.Info("webhook accepted")
	w.WriteHeader(http.StatusNoContent)
}
