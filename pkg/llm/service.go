// Package llm is a minimal completion client. The model is pinned at
// construction so callers cannot silently change it — a classifier's output
// is only comparable across runs if the model is fixed.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	// Turns are sent in order. Callers placing untrusted text in its own
	// turn depend on that order being preserved.
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

const (
	defaultTimeoutSeconds = 30
	// maxErrorBodyBytes bounds what a non-200 body contributes to an error
	// string. llm_base_url is configurable, so a proxy returning an HTML
	// page would otherwise land verbatim in the caller's logs.
	maxErrorBodyBytes = 8 << 10
)

// NewService requires llm_api_key and llm_model. llm_base_url overrides the
// endpoint (the test seam). llm_timeout_seconds bounds a single call —
// callers running a per-message loop inside a scheduler deadline need this
// low enough that budget × timeout still fits the deadline.
func NewService(config map[string]interface{}, logger logger.Logger) (Service, error) {
	apiKey, _ := config["llm_api_key"].(string)
	model, _ := config["llm_model"].(string)
	baseUrl, _ := config["llm_base_url"].(string)

	if model == "" {
		return nil, fmt.Errorf("llm: llm_model must be set — the model is pinned, not defaulted")
	}
	if baseUrl == "" {
		baseUrl = "https://api.anthropic.com"
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
		logger:  logger,
		apiKey:  apiKey,
		model:   model,
		baseUrl: strings.TrimSuffix(baseUrl, "/"),
		client:  &http.Client{Timeout: time.Duration(timeout) * time.Second},
	}, nil
}

type service struct {
	logger logger.Logger

	apiKey  string
	model   string
	baseUrl string
	client  *http.Client
}

func (this *service) Complete(ctx context.Context, req Request) (string, error) {
	turns := make([]map[string]string, 0, len(req.Turns))
	for _, turn := range req.Turns {
		turns = append(turns, map[string]string{"role": string(turn.Role), "content": turn.Content})
	}

	payload := map[string]interface{}{
		"model":      this.model,
		"max_tokens": req.MaxTokens,
		"messages":   turns,
	}
	if req.System != "" {
		payload["system"] = req.System
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, this.baseUrl+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-api-key", this.apiKey)
	request.Header.Set("anthropic-version", "2023-06-01")

	response, err := this.client.Do(request)
	if err != nil {
		this.logger.Error("llm complete", "error", err)

		return "", err
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, maxErrorBodyBytes))
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		this.logger.Error("llm complete", "status", response.StatusCode)

		return "", fmt.Errorf("llm: status %d: %s", response.StatusCode, string(raw))
	}

	var parsed struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", err
	}

	// A truncated or refused reply is a 200 carrying partial text. Without
	// this the caller sees only "unparseable" and cannot tell a MaxTokens
	// that is too small from a model that answered badly — different fixes.
	if parsed.StopReason != "" && parsed.StopReason != "end_turn" {
		this.logger.Error("llm complete: reply did not end normally", "stop_reason", parsed.StopReason)
	}

	var text bytes.Buffer
	for _, block := range parsed.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}

	return text.String(), nil
}
