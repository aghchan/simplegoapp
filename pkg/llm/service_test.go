package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type recordedRequest struct {
	Model       string  `json:"model"`
	MaxTokens   int     `json:"max_tokens"`
	Temperature float64 `json:"temperature"`
	System      string  `json:"system"`
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

func TestCompleteSendsPinnedModelAndTemperature(t *testing.T) {
	service, got := newTestService(t, func(r recordedRequest) (int, string) {
		return 200, `{"content":[{"type":"text","text":"hello back"}]}`
	})

	text, err := service.Complete(context.Background(), Request{
		System:      "you are a classifier",
		Turns:       []Turn{{Role: RoleUser, Content: "classify this"}},
		MaxTokens:   64,
		Temperature: 0,
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
	if sent.Temperature != 0 {
		t.Fatalf("temperature %v, want 0 — a classifier needs reproducibility", sent.Temperature)
	}
	if sent.System != "you are a classifier" {
		t.Fatalf("system %q", sent.System)
	}
	if len(sent.Messages) != 1 || sent.Messages[0].Role != "user" || sent.Messages[0].Content != "classify this" {
		t.Fatalf("turns not forwarded: %+v", sent.Messages)
	}
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
