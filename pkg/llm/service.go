// Package llm is a minimal completion client. The model is pinned at
// construction so callers cannot silently change it — a classifier's output
// is only comparable across runs if the model is fixed.
package llm

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

type Turn struct {
	Role    Role
	Content string
}

type Request struct {
	System string
	// Turns are sent in order and must begin with a user turn. Callers
	// placing untrusted text in its own turn depend on that order being
	// preserved; consecutive same-role turns are preserved too, and are
	// what a fenced-content-then-instruction prompt is built on.
	Turns     []Turn
	MaxTokens int
	// Temperature is omitted entirely when nil. Current-generation models
	// reject sampling parameters outright (a non-default value is a 400),
	// so it cannot be sent unconditionally — set it only against a model
	// documented to accept it, and prefer 0 when reproducibility matters.
	Temperature *float64
}

type Service interface {
	Complete(ctx context.Context, req Request) (string, error)
}

// provider owns everything vendor-specific. Each one wraps an Eino chat-model
// component, which owns its transport — including retry, backoff and
// Retry-After. Complete holds only what is common, so a new vendor is one
// file and a case in newProvider, never a change at a call site.
type provider interface {
	complete(ctx context.Context, req Request) (reply, error)
}

type reply struct {
	text string
	// abnormalStop is empty when the reply ended normally. Vendors spell a
	// normal finish differently ("end_turn" vs "stop"), so the provider
	// normalises rather than leaking the vocabulary into Complete.
	abnormalStop string
}

type providerConfig struct {
	apiKey  string
	model   string
	baseUrl string
}

func newProvider(name string, config providerConfig) (provider, error) {
	switch name {
	case "anthropic":
		return newAnthropic(config)
	case "openai":
		return newOpenAI(config)
	case "openrouter":
		return newOpenRouter(config)
	case "":
		return nil, fmt.Errorf("llm: llm_provider must be set (anthropic, openai, or openrouter)")
	default:
		return nil, fmt.Errorf("llm: unknown llm_provider %q (want anthropic, openai, or openrouter)", name)
	}
}

const (
	defaultTimeoutSeconds = 30
	// constructionMaxTokens only satisfies the components' required-at-build
	// field. Every call overrides it from Request.MaxTokens, so this value is
	// never the one actually sent.
	constructionMaxTokens = 1024
	// maxErrorChars bounds a provider error before it reaches a log line.
	// llm_base_url is configurable, so a proxy's HTML page would otherwise
	// land verbatim in the caller's logs.
	maxErrorChars = 2048
)

// NewService requires llm_api_key, llm_model and llm_provider. The provider is
// named explicitly for the same reason the model is pinned: an implicit vendor
// is a silent one, and a key sent to the wrong host is the failure it prevents.
// llm_base_url overrides the provider's endpoint — the test seam, and how a
// self-hosted OpenAI-compatible server is reached.
//
// llm_timeout_seconds (default 30) bounds ONE Complete call in total —
// including every retry the underlying client makes. It is deliberately not a
// per-HTTP-request timeout: a caller running a per-message loop inside a
// scheduler deadline sizes budget × timeout against that deadline, and a
// per-request bound would let backoff multiply past it.
func NewService(config map[string]interface{}, logger logger.Logger) (Service, error) {
	model, _ := config["llm_model"].(string)
	if model == "" {
		return nil, fmt.Errorf("llm: llm_model must be set — the model is pinned, not defaulted")
	}

	apiKey, _ := config["llm_api_key"].(string)
	baseUrl, _ := config["llm_base_url"].(string)
	providerName, _ := config["llm_provider"].(string)

	chosen, err := newProvider(providerName, providerConfig{
		apiKey:  apiKey,
		model:   model,
		baseUrl: strings.TrimSuffix(baseUrl, "/"),
	})
	if err != nil {
		return nil, err
	}

	timeout := defaultTimeoutSeconds
	switch configured := config["llm_timeout_seconds"].(type) {
	case int:
		if configured > 0 {
			timeout = configured
		}
	case float64:
		if configured > 0 {
			timeout = int(configured)
		}
	}

	return &service{
		logger:   logger,
		provider: chosen,
		timeout:  time.Duration(timeout) * time.Second,
	}, nil
}

type service struct {
	logger   logger.Logger
	provider provider
	timeout  time.Duration
}

func (this *service) Complete(ctx context.Context, req Request) (string, error) {
	// The deadline covers the provider's internal retries, not just one HTTP
	// request. Without it a run of 429s would back off past the caller's own
	// scheduler deadline, and being slow but working is a failure mode here,
	// not a success.
	ctx, cancel := context.WithTimeout(ctx, this.timeout)
	defer cancel()

	parsed, err := this.provider.complete(ctx, req)
	if err != nil {
		this.logger.Error("llm complete", "error", truncate(err.Error()))

		return "", err
	}

	// A truncated or refused reply arrives as an ordinary short answer. Without
	// this the caller sees only "unparseable" and cannot tell a MaxTokens that
	// is too small from a model that answered badly — different fixes.
	if parsed.abnormalStop != "" {
		this.logger.Error("llm complete: reply did not end normally", "stop_reason", parsed.abnormalStop)
	}

	return parsed.text, nil
}

func truncate(text string) string {
	if len(text) <= maxErrorChars {
		return text
	}

	return text[:maxErrorChars] + "…(truncated)"
}

// normalFinish spells the same outcome differently per vendor; both are
// listed because a provider swap must not turn every healthy reply into a
// logged anomaly.
func normalFinish(reason string) bool {
	return reason == "" || reason == "stop" || reason == "end_turn"
}
