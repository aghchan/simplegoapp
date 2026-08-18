package llm

import (
	"context"
	"fmt"

	"github.com/cloudwego/eino-ext/components/model/claude"
	"github.com/cloudwego/eino/components/model"
)

// anthropic wraps Eino's Claude component, which speaks the Messages API
// through Anthropic's official Go SDK. That SDK owns retry: it backs off on
// 408/409/429/5xx and connection errors and honours Retry-After. Complete's
// context deadline is what bounds the total.
type anthropic struct {
	chat model.BaseChatModel
}

func newAnthropic(config providerConfig) (provider, error) {
	settings := &claude.Config{
		APIKey:    config.apiKey,
		Model:     config.model,
		MaxTokens: constructionMaxTokens,
	}
	// A nil BaseURL means the vendor default; an empty non-nil string would
	// point the client at the empty host instead.
	if config.baseUrl != "" {
		settings.BaseURL = &config.baseUrl
	}

	chat, err := claude.NewChatModel(context.Background(), settings)
	if err != nil {
		return nil, fmt.Errorf("llm: building anthropic client: %w", err)
	}

	return &anthropic{chat: chat}, nil
}

func (this *anthropic) complete(ctx context.Context, req Request) (reply, error) {
	message, err := this.chat.Generate(ctx, einoMessages(req), callOptions(req)...)
	if err != nil {
		return reply{}, err
	}

	return replyFrom(message), nil
}
