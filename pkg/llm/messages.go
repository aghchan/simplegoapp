package llm

import (
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

// einoMessages maps a Request onto Eino's message slice. Leading system
// messages are lifted into the vendor's own system field by the components,
// so the system prompt never competes with user content.
//
// Turn order is copied verbatim. Consecutive same-role turns are preserved:
// a prompt that fences untrusted content in one user turn and puts its
// instruction in the next depends on that, and collapsing them would move
// the instruction inside the attacker-controlled span.
func einoMessages(req Request) []*schema.Message {
	messages := make([]*schema.Message, 0, len(req.Turns)+1)
	if req.System != "" {
		messages = append(messages, schema.SystemMessage(req.System))
	}
	for _, turn := range req.Turns {
		if turn.Role == RoleAssistant {
			messages = append(messages, schema.AssistantMessage(turn.Content, nil))

			continue
		}
		messages = append(messages, schema.UserMessage(turn.Content))
	}

	return messages
}

// callOptions carries the per-call values. MaxTokens must be per-call, not
// construction-time: the classifier retries an unparseable reply with a
// higher ceiling, and a construction-time cap would make that retry identical
// to the attempt that just failed.
func callOptions(req Request) []model.Option {
	options := []model.Option{model.WithMaxTokens(req.MaxTokens)}
	if req.Temperature != nil {
		options = append(options, model.WithTemperature(float32(*req.Temperature)))
	}

	return options
}

// replyFrom reads the one field every vendor reports differently.
func replyFrom(message *schema.Message) reply {
	if message == nil {
		return reply{}
	}

	var finish string
	if message.ResponseMeta != nil {
		finish = message.ResponseMeta.FinishReason
	}
	if normalFinish(finish) {
		finish = ""
	}

	return reply{text: message.Content, abnormalStop: finish}
}
