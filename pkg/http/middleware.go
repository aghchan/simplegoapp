package http

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/aghchan/simplegoapp/pkg/http/apierror"
	"github.com/aghchan/simplegoapp/pkg/logger"
)

type Middleware func(http.Handler) http.Handler

type ctxKey string

const RequestIDKey ctxKey = "request_id"

// Chain wraps h with mws, first entry outermost.
func Chain(h http.Handler, mws ...Middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			b := make([]byte, 8)
			rand.Read(b)
			id = hex.EncodeToString(b)
		}

		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), RequestIDKey, id)))
	})
}

func Recover(log logger.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sw := &statusWriter{ResponseWriter: w}
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				if rec == http.ErrAbortHandler {
					panic(rec)
				}

				log.Error(
					"panic recovered",
					"panic", rec,
					"stack", string(debug.Stack()),
					"request_id", r.Context().Value(RequestIDKey),
				)
				if sw.status == 0 {
					apierror.Write(w, r, apierror.Internal("internal server error"))
				}
			}()
			next.ServeHTTP(sw, r)
		})
	}
}

// statusWriter records the status code; Hijack passes through for websockets.
// Flusher/Pusher are not passed through; streaming handlers are unsupported.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (this *statusWriter) WriteHeader(code int) {
	this.status = code
	this.ResponseWriter.WriteHeader(code)
}

func (this *statusWriter) Write(b []byte) (int, error) {
	if this.status == 0 {
		this.status = 200
	}
	return this.ResponseWriter.Write(b)
}

func (this *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return this.ResponseWriter.(http.Hijacker).Hijack()
}

func RequestLogger(log logger.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			status := sw.status
			if status == 0 {
				status = 200
			}
			log.Info(
				"request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", status,
				"duration_ms", time.Since(start).Milliseconds(),
				"request_id", r.Context().Value(RequestIDKey),
			)
		})
	}
}

// bufferedWriter holds the response so a timeout can never race a
// half-written body.
type bufferedWriter struct {
	header http.Header
	buf    bytes.Buffer
	status int
}

func (this *bufferedWriter) Header() http.Header  { return this.header }
func (this *bufferedWriter) WriteHeader(code int) { this.status = code }
func (this *bufferedWriter) Write(b []byte) (int, error) {
	if this.status == 0 {
		this.status = 200
	}
	return this.buf.Write(b)
}

func (this *bufferedWriter) flush(w http.ResponseWriter) {
	for k, vs := range this.header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	if this.status == 0 {
		this.status = 200
	}
	w.WriteHeader(this.status)
	w.Write(this.buf.Bytes())
}

// TimeoutMW buffers responses and emits a 504 problem on deadline; websocket
// upgrades bypass it (buffering breaks hijacking). Handler goroutines keep
// running after a timeout until they observe ctx cancellation.
func TimeoutMW(d time.Duration) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
				next.ServeHTTP(w, r)
				return
			}

			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()

			buffered := &bufferedWriter{header: http.Header{}}
			done := make(chan interface{}, 1)
			go func() {
				defer func() { done <- recover() }()
				next.ServeHTTP(buffered, r.WithContext(ctx))
			}()

			select {
			case p := <-done:
				if p != nil {
					panic(p)
				}
				buffered.flush(w)
			case <-ctx.Done():
				apierror.Write(w, r, apierror.Timeout())
			}
		})
	}
}

func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := os.Getenv("CORS_ORIGIN")
		if os.Getenv("ENV") != "PRODUCTION" {
			origin = "*"
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}

		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

var authMiddleware Middleware

// SetAuthMiddleware installs the app's auth layer. Call before NewApp only:
// the hook is read once at startup and is not synchronized.
func SetAuthMiddleware(mw Middleware) { authMiddleware = mw }

func Auth() Middleware {
	return func(next http.Handler) http.Handler {
		if authMiddleware == nil {
			return next
		}
		return authMiddleware(next)
	}
}
