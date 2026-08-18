package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type sentMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

type sentRequest struct {
	Model       string        `json:"model"`
	MaxTokens   int           `json:"max_tokens"`
	Temperature *float64      `json:"temperature"`
	System      any           `json:"system"`
	Messages    []sentMessage `json:"messages"`
	Path        string        `json:"-"`
}

// text flattens a content field that may be a plain string or a block array,
// so assertions read the same whichever shape the vendor client emits.
func (this sentMessage) text() string {
	switch content := this.Content.(type) {
	case string:
		return content
	case []any:
		var out strings.Builder
		for _, block := range content {
			if entry, ok := block.(map[string]any); ok {
				if value, ok := entry["text"].(string); ok {
					out.WriteString(value)
				}
			}
		}

		return out.String()
	}

	return ""
}

func (this sentRequest) systemText() string {
	return sentMessage{Content: this.System}.text()
}

const anthropicReply = `{"id":"msg_1","type":"message","role":"assistant","model":"m",` +
	`"content":[{"type":"text","text":%q}],"stop_reason":%q,` +
	`"usage":{"input_tokens":1,"output_tokens":1}}`

// newAnthropicServer records every request and replies with the given status
// and body, so tests assert on the real wire payload the vendor client emits
// rather than on our own intent.
func newAnthropicServer(t *testing.T, respond func(n int) (int, string)) (*httptest.Server, *[]sentRequest) {
	t.Helper()

	got := &[]sentRequest{}
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var parsed sentRequest
		json.Unmarshal(body, &parsed)
		parsed.Path = r.URL.Path
		*got = append(*got, parsed)

		status, payload := respond(int(atomic.AddInt32(&calls, 1)))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, payload)
	}))
	t.Cleanup(server.Close)

	return server, got
}

func newServiceAt(t *testing.T, url string, log logger.Logger, extra map[string]interface{}) Service {
	t.Helper()

	config := map[string]interface{}{
		"llm_provider": "anthropic",
		"llm_api_key":  "test-key",
		"llm_model":    "claude-haiku-4-5-20251001",
		"llm_base_url": url,
	}
	for key, value := range extra {
		config[key] = value
	}

	built, err := NewService(config, log)
	if err != nil {
		t.Fatalf("constructing service: %v", err)
	}

	return built
}

func okReply(text string) func(int) (int, string) {
	return func(int) (int, string) {
		return 200, fmt.Sprintf(anthropicReply, text, "end_turn")
	}
}

func TestCompleteSendsPinnedModelSystemAndTurns(t *testing.T) {
	server, got := newAnthropicServer(t, okReply("hello back"))
	service := newServiceAt(t, server.URL, logger.NewService(), nil)

	text, err := service.Complete(context.Background(), Request{
		System:    "you are a classifier",
		Turns:     []Turn{{Role: RoleUser, Content: "classify this"}},
		MaxTokens: 64,
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
	if sent.systemText() != "you are a classifier" {
		t.Fatalf("system %q — a system prompt must reach the vendor's system field, not a turn", sent.systemText())
	}
	if len(sent.Messages) != 1 || sent.Messages[0].Role != "user" || sent.Messages[0].text() != "classify this" {
		t.Fatalf("turns not forwarded: %+v", sent.Messages)
	}
}

// THE security-critical property. The classifier fences untrusted email in one
// user turn and puts its instruction in the NEXT user turn, so the instruction
// sits outside the attacker-controlled span. A client that merged adjacent
// same-role turns would move it inside — silently, with every test still green
// except this one.
func TestCompletePreservesConsecutiveUserTurns(t *testing.T) {
	server, got := newAnthropicServer(t, okReply("ok"))
	service := newServiceAt(t, server.URL, logger.NewService(), nil)

	_, err := service.Complete(context.Background(), Request{
		Turns: []Turn{
			{Role: RoleUser, Content: "FENCE\nuntrusted body\nFENCE"},
			{Role: RoleUser, Content: "Emit the verdict for the content above."},
		},
		MaxTokens: 32,
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}

	sent := (*got)[0]
	if len(sent.Messages) != 2 {
		t.Fatalf("got %d turns, want 2 — adjacent user turns were merged: %+v", len(sent.Messages), sent.Messages)
	}
	if !strings.Contains(sent.Messages[0].text(), "untrusted body") {
		t.Fatalf("first turn should carry the fenced body: %q", sent.Messages[0].text())
	}
	if !strings.Contains(sent.Messages[1].text(), "Emit the verdict") {
		t.Fatalf("instruction must stay in its own turn AFTER the body: %q", sent.Messages[1].text())
	}
}

func TestCompletePreservesTurnOrderAndRoles(t *testing.T) {
	server, got := newAnthropicServer(t, okReply("ok"))
	service := newServiceAt(t, server.URL, logger.NewService(), nil)

	_, err := service.Complete(context.Background(), Request{
		Turns: []Turn{
			{Role: RoleUser, Content: "first"},
			{Role: RoleAssistant, Content: "second"},
			{Role: RoleUser, Content: "third"},
		},
		MaxTokens: 32,
	})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}

	sent := (*got)[0]
	if len(sent.Messages) != 3 {
		t.Fatalf("got %d turns, want 3", len(sent.Messages))
	}
	if sent.Messages[0].text() != "first" || sent.Messages[1].text() != "second" || sent.Messages[2].text() != "third" {
		t.Fatalf("turn order lost: %+v", sent.Messages)
	}
	if sent.Messages[1].Role != "assistant" {
		t.Fatalf("role %q, want assistant", sent.Messages[1].Role)
	}
}

// MaxTokens has to be per-call: the classifier's retry raises the ceiling
// 200 -> 400, and a construction-time cap would make that retry byte-identical
// to the attempt that just failed.
func TestCompleteSendsPerCallMaxTokens(t *testing.T) {
	server, got := newAnthropicServer(t, okReply("ok"))
	service := newServiceAt(t, server.URL, logger.NewService(), nil)

	for _, want := range []int{200, 400} {
		if _, err := service.Complete(context.Background(), Request{
			Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: want,
		}); err != nil {
			t.Fatalf("complete: %v", err)
		}
	}

	if (*got)[0].MaxTokens != 200 || (*got)[1].MaxTokens != 400 {
		t.Fatalf("max_tokens %d then %d, want 200 then 400 — per-call value ignored",
			(*got)[0].MaxTokens, (*got)[1].MaxTokens)
	}
}

func TestCompleteOmitsTemperatureWhenUnset(t *testing.T) {
	server, got := newAnthropicServer(t, okReply("ok"))
	service := newServiceAt(t, server.URL, logger.NewService(), nil)

	if _, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if (*got)[0].Temperature != nil {
		t.Fatalf("temperature must be absent when unset, got %v", *(*got)[0].Temperature)
	}
}

func TestCompleteSendsExplicitTemperature(t *testing.T) {
	server, got := newAnthropicServer(t, okReply("ok"))
	service := newServiceAt(t, server.URL, logger.NewService(), nil)

	zero := 0.0
	if _, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16, Temperature: &zero,
	}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if (*got)[0].Temperature == nil || *(*got)[0].Temperature != 0 {
		t.Fatalf("temperature %v, want the caller's explicit 0", (*got)[0].Temperature)
	}
}

// THE bug this change exists to close. A 429 used to become a hard error,
// which the caller turned into "no verdict" — and because that path fails
// open, a transient overload was indistinguishable from a quiet inbox.
func TestCompleteRetriesOnRateLimit(t *testing.T) {
	server, got := newAnthropicServer(t, func(n int) (int, string) {
		if n == 1 {
			return 429, `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`
		}

		return 200, fmt.Sprintf(anthropicReply, "recovered", "end_turn")
	})
	service := newServiceAt(t, server.URL, logger.NewService(), nil)

	text, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	})
	if err != nil {
		t.Fatalf("a retryable 429 must not surface as an error: %v", err)
	}
	if text != "recovered" {
		t.Fatalf("text %q, want the retried reply", text)
	}
	if len(*got) < 2 {
		t.Fatalf("got %d requests, want a retry after the 429", len(*got))
	}
}

// The timeout is a TOTAL budget, not a per-request one. A wedged endpoint
// that keeps returning 429 must give up inside it — the caller sizes
// budget × timeout against a scheduler deadline, and backoff must not
// multiply past that.
func TestCompleteStopsRetryingWithinTotalTimeout(t *testing.T) {
	server, _ := newAnthropicServer(t, func(int) (int, string) {
		return 429, `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`
	})
	service := newServiceAt(t, server.URL, logger.NewService(),
		map[string]interface{}{"llm_timeout_seconds": 1})

	started := time.Now()
	if _, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	}); err == nil {
		t.Fatalf("persistent 429 must eventually return an error")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("took %v — retries escaped the 1s total budget", elapsed)
	}
}

func TestCompleteReturnsErrorOnNonRetryableStatus(t *testing.T) {
	server, _ := newAnthropicServer(t, func(int) (int, string) {
		return 400, `{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}`
	})
	service := newServiceAt(t, server.URL, logger.NewService(), nil)

	if _, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	}); err == nil {
		t.Fatalf("expected an error on 400")
	}
}

// Truncation and refusal both arrive as an ordinary short answer; the stop
// reason is what distinguishes a MaxTokens that is too small from a model
// that answered badly.
func TestCompleteLogsAbnormalStopReason(t *testing.T) {
	captured := &capturingLogger{}
	server, _ := newAnthropicServer(t, func(int) (int, string) {
		return 200, fmt.Sprintf(anthropicReply, `{"relev`, "max_tokens")
	})
	service := newServiceAt(t, server.URL, captured, nil)

	if _, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	}); err != nil {
		t.Fatalf("a truncated reply is still a successful call: %v", err)
	}
	if !captured.sawStopReason("max_tokens") {
		t.Fatalf("abnormal stop reason not logged: %+v", captured.entries)
	}
}

func TestCompleteDoesNotLogNormalStopReason(t *testing.T) {
	captured := &capturingLogger{}
	server, _ := newAnthropicServer(t, okReply("ok"))
	service := newServiceAt(t, server.URL, captured, nil)

	if _, err := service.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if len(captured.entries) != 0 {
		t.Fatalf("a normal finish must not log: %+v", captured.entries)
	}
}

func TestNewServiceRequiresModel(t *testing.T) {
	if _, err := NewService(map[string]interface{}{
		"llm_api_key": "test-key", "llm_model": "",
	}, logger.NewService()); err == nil {
		t.Fatalf("an unpinned model must be a construction error")
	}
}

// A typo must not silently fall through to a default — that would send the key
// and prompt to a vendor the operator did not choose.
func TestNewServiceRejectsUnknownProvider(t *testing.T) {
	_, err := NewService(map[string]interface{}{
		"llm_provider": "antropic", "llm_api_key": "k", "llm_model": "m",
	}, logger.NewService())
	if err == nil {
		t.Fatalf("an unknown provider must be a construction error")
	}
	if !strings.Contains(err.Error(), "antropic") {
		t.Fatalf("error should name the rejected value: %v", err)
	}
}

// The vendor is named explicitly for the same reason the model is pinned: an
// implicit one is a silent one.
func TestNewServiceRequiresProvider(t *testing.T) {
	_, err := NewService(map[string]interface{}{
		"llm_api_key": "k", "llm_model": "m",
	}, logger.NewService())
	if err == nil {
		t.Fatalf("an unset provider must be a construction error, not a default")
	}
	if !strings.Contains(err.Error(), "llm_provider") {
		t.Fatalf("error should name the missing key: %v", err)
	}
}

func TestNewServiceBuildsSelectedProvider(t *testing.T) {
	for name, want := range map[string]string{
		"anthropic":  "*llm.anthropic",
		"openai":     "*llm.openaiCompatible",
		"openrouter": "*llm.openaiCompatible",
	} {
		built, err := NewService(map[string]interface{}{
			"llm_provider": name, "llm_api_key": "k", "llm_model": "m",
		}, logger.NewService())
		if err != nil {
			t.Fatalf("provider %q: %v", name, err)
		}
		if got := fmt.Sprintf("%T", built.(*service).provider); got != want {
			t.Fatalf("provider %q built %s, want %s", name, got, want)
		}
	}
}

// openrouter exists as its own provider precisely so the endpoint cannot be
// forgotten: naming it must be sufficient to reach OpenRouter and not OpenAI.
func TestOpenRouterSuppliesItsOwnEndpoint(t *testing.T) {
	var path, host string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, host = r.URL.Path, r.Host
		io.WriteString(w, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
	}))
	t.Cleanup(server.Close)

	// Without an override the provider must target OpenRouter's own host.
	built, err := NewService(map[string]interface{}{
		"llm_provider": "openrouter", "llm_api_key": "k", "llm_model": "openai/gpt-oss-120b",
	}, logger.NewService())
	if err != nil {
		t.Fatalf("constructing: %v", err)
	}
	if got := built.(*service).provider.(*openaiCompatible); got == nil {
		t.Fatalf("openrouter must reuse the openai wire shape")
	}
	if got := openRouterConfig(providerConfig{}).baseUrl; got != "https://openrouter.ai/api/v1" {
		t.Fatalf("default baseUrl %q — naming the provider must be enough to reach OpenRouter", got)
	}

	// An explicit base URL still wins, or there would be no test seam.
	overridden, err := NewService(map[string]interface{}{
		"llm_provider": "openrouter", "llm_api_key": "k",
		"llm_model": "openai/gpt-oss-120b", "llm_base_url": server.URL,
	}, logger.NewService())
	if err != nil {
		t.Fatalf("constructing: %v", err)
	}
	if _, err := overridden.Complete(context.Background(), Request{
		Turns: []Turn{{Role: RoleUser, Content: "x"}}, MaxTokens: 16,
	}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if path != "/chat/completions" {
		t.Fatalf("path %q, want the chat-completions endpoint", path)
	}
	if !strings.HasPrefix(host, "127.0.0.1") {
		t.Fatalf("host %q — llm_base_url must override the baked-in endpoint", host)
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
