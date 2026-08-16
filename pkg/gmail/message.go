package gmail

import (
	"context"
	"encoding/base64"
	"time"

	gmailapi "google.golang.org/api/gmail/v1"
)

// searchPageCap bounds runaway queries; the agent's filtered searches return
// far fewer than this.
const searchPageCap = 10

func (this *service) Search(ctx context.Context, query string) ([]MessageRef, error) {
	refs := []MessageRef{}
	pageToken := ""
	for page := 0; page < searchPageCap; page++ {
		call := this.api.Users.Messages.List("me").Q(query).Context(ctx)
		if pageToken != "" {
			call = call.PageToken(pageToken)
		}
		response, err := call.Do()
		if err != nil {
			this.logger.Error("gmail search", "error", err, "query", query)

			return nil, err
		}

		for _, message := range response.Messages {
			refs = append(refs, MessageRef{Id: message.Id, ThreadId: message.ThreadId})
		}
		if response.NextPageToken == "" {
			break
		}
		pageToken = response.NextPageToken
	}

	return refs, nil
}

func (this *service) Message(ctx context.Context, id string) (Message, error) {
	raw, err := this.api.Users.Messages.Get("me", id).Format("full").Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail get message", "error", err, "id", id)

		return Message{}, err
	}

	message := Message{
		Id:       raw.Id,
		ThreadId: raw.ThreadId,
		LabelIds: raw.LabelIds,
		Received: time.UnixMilli(raw.InternalDate),
	}
	if raw.Payload != nil {
		for _, header := range raw.Payload.Headers {
			switch header.Name {
			case "From":
				message.From = header.Value
			case "To":
				message.To = header.Value
			case "Subject":
				message.Subject = header.Value
			}
		}
		message.Body = plainText(raw.Payload)
	}

	return message, nil
}

// plainText walks the MIME tree for the first text/plain part; ATS mail is
// reliably multipart/alternative with a plain variant.
func plainText(part *gmailapi.MessagePart) string {
	if part.MimeType == "text/plain" && part.Body != nil && part.Body.Data != "" {
		decoded, err := base64.URLEncoding.WithPadding(base64.NoPadding).DecodeString(part.Body.Data)
		if err != nil {
			return ""
		}

		return string(decoded)
	}
	for _, child := range part.Parts {
		if text := plainText(child); text != "" {
			return text
		}
	}

	return ""
}
