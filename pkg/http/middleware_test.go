package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type recordingLogger struct {
	msgs []string
	kvs  [][]interface{}
}

func (this *recordingLogger) record(msg string, kv []interface{}) {
	this.msgs = append(this.msgs, msg)
	this.kvs = append(this.kvs, kv)
}

func (this *recordingLogger) Info(msg string, kv ...interface{})  { this.record(msg, kv) }
func (this *recordingLogger) Warn(msg string, kv ...interface{})  { this.record(msg, kv) }
func (this *recordingLogger) Error(msg string, kv ...interface{}) { this.record(msg, kv) }
func (this *recordingLogger) Fatal(msg string, kv ...interface{}) { this.record(msg, kv) }

func (this *recordingLogger) value(i int, key string) interface{} {
	kv := this.kvs[i]
	for j := 0; j+1 < len(kv); j += 2 {
		if kv[j] == key {
			return kv[j+1]
		}
	}
	return nil
}

func TestRequestIDGeneratedAndPropagated(t *testing.T) {
	var seen string
	h := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, _ = r.Context().Value(RequestIDKey).(string)
	}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if seen == "" || w.Header().Get("X-Request-Id") != seen {
		t.Fatalf("generated id missing: ctx %q header %q", seen, w.Header().Get("X-Request-Id"))
	}

	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("X-Request-Id", "upstream-id")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if seen != "upstream-id" {
		t.Fatalf("expected propagated id, got %q", seen)
	}
}

func TestRecoverConvertsPanicToProblem(t *testing.T) {
	log := &recordingLogger{}
	h := Recover(log)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 500 || w.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("expected 500 problem, got %d %q", w.Code, w.Header().Get("Content-Type"))
	}
	if len(log.msgs) == 0 {
		t.Fatal("panic was not logged")
	}
}

func TestRecoverRepanicsAbortHandler(t *testing.T) {
	h := Recover(&recordingLogger{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(http.ErrAbortHandler)
	}))

	defer func() {
		if recover() != http.ErrAbortHandler {
			t.Fatal("ErrAbortHandler was swallowed")
		}
	}()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
}

func TestRecoverLeavesCommittedResponsesAlone(t *testing.T) {
	log := &recordingLogger{}
	h := Recover(log)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte(`{"partial":`))
		panic("mid-write")
	}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), "problem") ||
		w.Body.String() != `{"partial":` {
		t.Fatalf("committed response was rewritten: %d %s", w.Code, w.Body.String())
	}
	if len(log.msgs) == 0 {
		t.Fatal("panic was not logged")
	}
}

func TestRequestLoggerDefaultsStatus200(t *testing.T) {
	log := &recordingLogger{}
	h := RequestLogger(log)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
	if len(log.msgs) != 1 {
		t.Fatalf("expected one log line, got %v", log.msgs)
	}
	if status := log.value(0, "status"); status != 200 {
		t.Fatalf("expected status 200, got %v", status)
	}
}

func TestRequestLoggerCapturesStatus(t *testing.T) {
	log := &recordingLogger{}
	h := RequestLogger(log)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
	}))

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/x", nil))
	if len(log.msgs) != 1 || log.msgs[0] != "request" {
		t.Fatalf("expected one request log, got %v", log.msgs)
	}
}

func TestTimeoutReturns504Problem(t *testing.T) {
	h := TimeoutMW(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 504 || w.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("expected 504 problem, got %d %q", w.Code, w.Header().Get("Content-Type"))
	}
}

func TestTimeoutPassesThroughFastHandlers(t *testing.T) {
	h := TimeoutMW(time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Custom", "yes")
		w.WriteHeader(201)
		w.Write([]byte("ok"))
	}))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 201 || w.Body.String() != "ok" || w.Header().Get("X-Custom") != "yes" {
		t.Fatalf("buffered response mangled: %d %q", w.Code, w.Body.String())
	}
}

func TestCORSPreflight(t *testing.T) {
	h := CORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("preflight must not reach handler")
	}))

	r := httptest.NewRequest("OPTIONS", "/v1/orders", nil)
	r.Header.Set("Access-Control-Request-Method", "POST")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") == "" ||
		w.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatalf("preflight not handled: %d %v", w.Code, w.Header())
	}
}

func TestCORSOmitsHeaderWhenOriginEmpty(t *testing.T) {
	t.Setenv("ENV", "PRODUCTION")
	t.Setenv("CORS_ORIGIN", "")

	h := CORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if _, present := w.Header()["Access-Control-Allow-Origin"]; present {
		t.Fatal("empty Allow-Origin header must be omitted")
	}
}

func TestAuthHookDefaultsToNoop(t *testing.T) {
	called := false
	h := Auth()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
	if !called {
		t.Fatal("noop auth blocked the request")
	}
}

func TestAuthHookReplaceable(t *testing.T) {
	SetAuthMiddleware(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(401)
		})
	})
	defer SetAuthMiddleware(nil)

	h := Auth()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("auth middleware should have blocked")
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 401 {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestTimeoutBypassesWebsocketUpgradeCaseInsensitive(t *testing.T) {
	h := TimeoutMW(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(60 * time.Millisecond)
		w.WriteHeader(200)
	}))

	r := httptest.NewRequest("GET", "/ws", nil)
	r.Header.Set("Upgrade", "WebSocket")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("mixed-case Upgrade header must bypass timeout, got %d", w.Code)
	}
}
