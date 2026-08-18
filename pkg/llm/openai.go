package llm

import (
	"context"
	"fmt"

	openaiext "github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/model"
)

// openaiCompatible wraps Eino's OpenAI component, which speaks
// /v1/chat/completions. It is not tied to OpenAI itself — Groq, Together,
// OpenRouter, Ollama, vLLM and LM Studio serve the same shape, and
// llm_base_url is what picks between them.
type openaiCompatible struct {
	chat model.BaseChatModel
}

func newOpenAI(config providerConfig) (provider, error) {
	maxTokens := constructionMaxTokens
	chat, err := openaiext.NewChatModel(context.Background(), &openaiext.ChatModelConfig{
		APIKey:    config.apiKey,
		Model:     config.model,
		BaseURL:   config.baseUrl,
		MaxTokens: &maxTokens,
	})
	if err != nil {
		return nil, fmt.Errorf("llm: building openai client: %w", err)
	}

	return &openaiCompatible{chat: chat}, nil
}

func (this *openaiCompatible) complete(ctx context.Context, req Request) (reply, error) {
	message, err := this.chat.Generate(ctx, einoMessages(req), callOptions(req)...)
	if err != nil {
		return reply{}, err
	}

	return replyFrom(message), nil
}
