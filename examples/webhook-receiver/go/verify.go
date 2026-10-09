package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	secretPrefix = "whsec_"
	tolerance    = 5 * time.Minute
)

var (
	errSecret    = errors.New("C2PA_WEBHOOK_SECRET is not whsec_ + standard base64")
	errHeaders   = errors.New("missing webhook headers")
	errTimestamp = errors.New("timestamp outside tolerance")
	errSignature = errors.New("no matching signature")

	timestampPattern = regexp.MustCompile(`^[0-9]{1,12}$`)
)

type verifier struct {
	key []byte
}

func newVerifier(secret string) (*verifier, error) {
	raw, ok := strings.CutPrefix(secret, secretPrefix)
	if !ok || raw == "" {
		return nil, errSecret
	}

	key, err := base64.StdEncoding.Strict().DecodeString(raw)
	if err != nil {
		return nil, errSecret
	}

	return &verifier{key: key}, nil
}

func (v *verifier) sign(id, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, v.key)
	mac.Write([]byte(id + "." + timestamp + "."))
	mac.Write(body)

	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func (v *verifier) verify(h http.Header, body []byte, now time.Time) error {
	id, ts, signatures := h.Get("webhook-id"), h.Get("webhook-timestamp"), h.Get("webhook-signature")
	if id == "" || ts == "" || signatures == "" {
		return errHeaders
	}

	if !timestampPattern.MatchString(ts) {
		return errTimestamp
	}

	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return errTimestamp
	}

	if diff := now.Sub(time.Unix(sec, 0)); diff > tolerance || diff < -tolerance {
		return errTimestamp
	}

	want := []byte(v.sign(id, ts, body))
	for _, candidate := range strings.Fields(signatures) {
		if hmac.Equal([]byte(candidate), want) {
			return nil
		}
	}

	return errSignature
}
