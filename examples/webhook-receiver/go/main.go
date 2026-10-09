package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	readHeaderTimeout = 5 * time.Second
	requestTimeout    = 10 * time.Second
	idleTimeout       = 60 * time.Second
	shutdownTimeout   = 15 * time.Second
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	if err := run(logger); err != nil {
		logger.Error("webhook receiver stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	v, err := newVerifier(os.Getenv("C2PA_WEBHOOK_SECRET"))
	if err != nil {
		return err
	}

	opts, err := redis.ParseURL(env("REDIS_URL", "redis://localhost:6379/0"))
	if err != nil {
		return err
	}

	rdb := redis.NewClient(opts)
	defer rdb.Close()

	mux := http.NewServeMux()
	mux.Handle("POST /webhooks/c2pa", http.TimeoutHandler(&handler{
		verifier: v,
		dedupe:   redisDedupe{rdb: rdb},
		queue:    redisQueue{rdb: rdb, key: env("C2PA_WEBHOOK_QUEUE", "c2pa:webhooks")},
		log:      logger,
		now:      time.Now,
	}, requestTimeout, "timeout"))

	srv := &http.Server{
		Addr:              ":" + env("PORT", "8000"),
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       requestTimeout,
		WriteTimeout:      requestTimeout + time.Second,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    1 << 16,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", srv.Addr)
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err = <-serveErr:
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err = srv.Shutdown(shutdownCtx); err != nil {
		return err
	}

	if err = <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return err
	}

	return nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}

	return fallback
}
