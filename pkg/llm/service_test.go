package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type recordedRequest struct {
	Model       string   `json:"model"`
	MaxTokens   int      `json:"max_tokens"`
	Temperature *float64 `json:"temperature"`
	System      string   `json:"system"`
	Messages    []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

func newTestService(t *testing.T, respond func(r recordedRequest) (int, string)) (Service, *[]recordedRequest) {
	t.Helper()

	got := &[]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if key := r.Header.Get("x-api-key"); key != "test-key" {
			t.Errorf("x-api-key %q, want test-key", key)
		}
		if version := r.Header.Get("anthropic-version"); version == "" {
			t.Errorf("anthropic-version header missing")
		}
		body, _ := io.ReadAll(r.Body)
		var parsed recordedRequest
		json.Unmarshal(body, &parsed)
		*got = append(*got, parsed)

		status, payload := respond(parsed)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, payload)
	}))
	t.Cleanup(server.Close)

	service, err := NewService(map[string]interface{}{
		"llm_api_key":  "test-key",
		"llm_model":    "claude-haiku-4-5-20251001",
		"llm_base_url": server.URL,
	}, logger.NewService())
	if err != nil {
		t.Fatalf("constructing service: %v", err)
	}

	return service, got
}

func TestCompleteSendsPinnedModel(t *testing.T) {
	service, got := newTestService(t, func(r recordedRequest) (int, string) {
		return 200, `{"content":[{"type":"text","text":"hello back"}],"stop_reason":"end_turn"}`
	})

	zero := 0.0
	text, err := service.Complete(context.Background(), Request{
		System:      "you are a classifier",
		Turns:       []Turn{{Role: RoleUser, Content: "classify this"}},
		MaxTokens:   64,
		Temperature: &zero,
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if text != "hello back" {
		t.Fatalf("text %q", text)
	}

	sent := (*got)[0]
	if sent.Model != "claude-haiku-4-5-20251001" {
		t.Fatalf("model %q, want the pinned config value", sent.Model)
	}
	if sent.Temperature == nil || *sent.Temperature != 0 {
		t.Fatalf("temperature %v, want the caller's explicit 0", sent.Temperature)
	}
	if sent.System != "you are a classifier" {
		t.Fatalf("system %q", sent.System)
	}
	if len(sent.Messages) != 1 || sent.Messages[0].Role != "user" || sent.Messages[0].Content != "classify this" {
		t.Fatalf("turns not forwarded: %+v", sent.Messages)
	}
}

// Current-generation models reject sampling parameters outright, so an
// unset temperature must not appear in the payload at all.
func TestCompleteOmitsTemperatureWhenUnset(t *testing.T) {
	service, got := newTestService(t, func(r recordedRequest) (int, string) {
		return 200, `{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}`
	})

	_, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if (*got)[0].Temperature != nil {
		t.Fatalf("temperature must be absent when unset, got %v", *(*got)[0].Temperature)
	}
}

// A truncated or refused reply is a 200 carrying partial text. The caller
// only sees "unparseable"; the stop reason is what distinguishes a MaxTokens
// that is too small from a model that answered badly.
func TestCompleteLogsAbnormalStopReason(t *testing.T) {
	captured := &capturingLogger{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"content":[{"type":"text","text":"{\"relev"}],"stop_reason":"max_tokens"}`)
	}))
	t.Cleanup(server.Close)

	service, err := NewService(map[string]interface{}{
		"llm_api_key": "test-key", "llm_model": "m", "llm_base_url": server.URL,
	}, captured)
	if err != nil {
		t.Fatalf("constructing: %v", err)
	}

	if _, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	}); err != nil {
		t.Fatalf("a truncated reply is still a successful call: %v", err)
	}
	if !captured.sawStopReason("max_tokens") {
		t.Fatalf("abnormal stop reason not logged: %+v", captured.entries)
	}
}

func TestNewServiceTrimsTrailingSlashFromBaseUrl(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		io.WriteString(w, `{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}`)
	}))
	t.Cleanup(server.Close)

	service, err := NewService(map[string]interface{}{
		"llm_api_key": "k", "llm_model": "m", "llm_base_url": server.URL + "/",
	}, logger.NewService())
	if err != nil {
		t.Fatalf("constructing: %v", err)
	}
	if _, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 8,
	}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if path != "/v1/messages" {
		t.Fatalf("path %q, want no double slash", path)
	}
}

// The caller runs a per-message loop inside a scheduler deadline, so
// budget × timeout has to fit — which means the timeout must be tunable
// without a new release of this package.
func TestNewServiceAcceptsConfiguredTimeout(t *testing.T) {
	built, err := NewService(map[string]interface{}{
		"llm_api_key": "k", "llm_model": "m", "llm_timeout_seconds": 5,
	}, logger.NewService())
	if err != nil {
		t.Fatalf("constructing: %v", err)
	}
	if got := built.(*service).client.Timeout; got != 5*time.Second {
		t.Fatalf("timeout %v, want the configured 5s", got)
	}
}

type capturingLogger struct {
	logger.Logger
	entries []string
}

func (this *capturingLogger) Error(msg string, keysAndValues ...interface{}) {
	this.entries = append(this.entries, fmt.Sprint(append([]interface{}{msg}, keysAndValues...)...))
}

func (this *capturingLogger) sawStopReason(reason string) bool {
	for _, entry := range this.entries {
		if strings.Contains(entry, reason) {
			return true
		}
	}

	return false
}

// Multiple turns must survive in order — the classifier places untrusted
// content in its own turn and the instruction after it, so order is
// load-bearing, not cosmetic.
func TestCompletePreservesTurnOrder(t *testing.T) {
	service, got := newTestService(t, func(r recordedRequest) (int, string) {
		return 200, `{"content":[{"type":"text","text":"ok"}]}`
	})

	_, err := service.Complete(context.Background(), Request{
		Turns: []Turn{
			{Role: RoleUser, Content: "first"},
			{Role: RoleAssistant, Content: "second"},
			{Role: RoleUser, Content: "third"},
		},
		MaxTokens: 16,
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}

	sent := (*got)[0]
	if len(sent.Messages) != 3 {
		t.Fatalf("got %d turns, want 3", len(sent.Messages))
	}
	if sent.Messages[0].Content != "first" || sent.Messages[1].Content != "second" || sent.Messages[2].Content != "third" {
		t.Fatalf("turn order lost: %+v", sent.Messages)
	}
	if sent.Messages[1].Role != "assistant" {
		t.Fatalf("role %q, want assistant", sent.Messages[1].Role)
	}
}

func TestCompleteConcatenatesTextBlocks(t *testing.T) {
	service, _ := newTestService(t, func(r recordedRequest) (int, string) {
		return 200, `{"content":[{"type":"text","text":"part one "},{"type":"text","text":"part two"}]}`
	})

	text, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if text != "part one part two" {
		t.Fatalf("text %q", text)
	}
}

func TestCompleteReturnsErrorOnNon200(t *testing.T) {
	service, _ := newTestService(t, func(r recordedRequest) (int, string) {
		return 429, `{"error":{"type":"rate_limit_error","message":"slow down"}}`
	})

	_, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	})
	if err == nil {
		t.Fatalf("expected an error on 429")
	}
	if !strings.Contains(err.Error(), "429") {
		t.Fatalf("error should name the status: %v", err)
	}
}

func TestNewServiceRequiresModel(t *testing.T) {
	_, err := NewService(map[string]interface{}{
		"llm_api_key": "test-key",
		"llm_model":   "",
	}, logger.NewService())
	if err == nil {
		t.Fatalf("an unpinned model must be a construction error")
	}
}
