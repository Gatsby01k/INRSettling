// Verifying an INRSettle webhook — Go 1.20+
//
// Three rules, and each one is a vulnerability if you skip it:
//
//	1. Compare in constant time. == on a hex digest leaks the answer one byte
//	   at a time to anyone who can send you requests and time them.
//	2. Reject a timestamp outside five minutes in EITHER direction. A stale
//	   timestamp is exactly what a replay looks like; checking only the future
//	   side leaves the replay window open forever.
//	3. Treat event.id as an idempotency key. Redelivery is expected, not a
//	   fault, and events can arrive out of order — created_at orders them.
//
// For anything irreversible on your side, re-read the settlement over the API
// rather than trusting the payload alone.

package inrsettle

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

const ToleranceSeconds = 300

// VerifySignature reports whether the delivery is authentic.
// secrets holds one secret, or two during a rotation overlap.
func VerifySignature(rawBody string, signatureHeader string, secrets []string, nowSeconds int64) bool {
	if nowSeconds == 0 {
		nowSeconds = time.Now().Unix()
	}

	var timestamp int64 = -1
	presented := []string{}

	for _, part := range strings.Split(signatureHeader, ",") {
		key, value, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch key {
		case "t":
			if n, err := strconv.ParseInt(value, 10, 64); err == nil {
				timestamp = n
			}
		case "v1":
			if _, err := hex.DecodeString(value); err == nil && value != "" {
				presented = append(presented, strings.ToLower(value))
			}
		}
	}
	if timestamp < 0 || len(presented) == 0 {
		return false
	}

	// Rule 2 — both directions.
	drift := nowSeconds - timestamp
	if drift < 0 {
		drift = -drift
	}
	if drift > ToleranceSeconds {
		return false
	}

	signedPayload := strconv.FormatInt(timestamp, 10) + "." + rawBody
	for _, secret := range secrets {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(signedPayload))
		expected := hex.EncodeToString(mac.Sum(nil))
		for _, candidate := range presented {
			// Rule 1 — constant time.
			if hmac.Equal([]byte(expected), []byte(candidate)) {
				return true
			}
		}
	}
	return false
}

// net/http, for example. Read the body BEFORE decoding it: the signature covers
// the raw body bytes, so a decoder that has re-serialised them will not verify.
//
//	func handler(w http.ResponseWriter, r *http.Request) {
//		body, _ := io.ReadAll(r.Body)
//		if !VerifySignature(string(body), r.Header.Get("INRSettle-Signature"),
//			[]string{os.Getenv("INRSETTLE_WEBHOOK_SECRET")}, 0) {
//			http.Error(w, "bad signature", http.StatusBadRequest)
//			return
//		}
//		var event Event
//		json.Unmarshal(body, &event)
//		if alreadyHandled(event.ID) { // rule 3
//			w.WriteHeader(http.StatusOK)
//			return
//		}
//		handle(event)
//		w.WriteHeader(http.StatusOK)
//	}
