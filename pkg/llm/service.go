// Package llm is a minimal completion client. It pins the model and
// temperature at construction so callers cannot silently change either —
// a classifier's output is only comparable across runs if both are fixed.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	Turns       []Turn
	MaxTokens   int
	Temperature float64
}

type Service interface {
	Complete(ctx context.Context, req Request) (string, error)
}

// NewService requires llm_api_key and llm_model. llm_base_url overrides the
// endpoint (the test seam). requestTimeout bounds a single call — an
// unbounded one would stall a caller running on a scheduler deadline.
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

	return &service{
		logger:  logger,
		apiKey:  apiKey,
		model:   model,
		baseUrl: baseUrl,
		client:  &http.Client{Timeout: 30 * time.Second},
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
		"model":       this.model,
		"max_tokens":  req.MaxTokens,
		"temperature": req.Temperature,
		"messages":    turns,
	}
	if req.System != "" {
		payload["system"] = req.System
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

	raw, err := io.ReadAll(response.Body)
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
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", err
	}

	var text bytes.Buffer
	for _, block := range parsed.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}

	return text.String(), nil
}
