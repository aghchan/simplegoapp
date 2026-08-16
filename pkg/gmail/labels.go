package gmail

import (
	"context"

	gmailapi "google.golang.org/api/gmail/v1"
)

// EnsureLabel is list-then-create and not concurrency-safe; the agent is a
// single sequential process, which is the only intended caller shape.
func (this *service) EnsureLabel(ctx context.Context, name string) (Label, error) {
	response, err := this.api.Users.Labels.List("me").Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail list labels", "error", err)

		return Label{}, classifyErr(err)
	}
	for _, label := range response.Labels {
		if label.Name == name {
			return Label{Id: label.Id, Name: label.Name}, nil
		}
	}

	created, err := this.api.Users.Labels.Create("me", &gmailapi.Label{Name: name}).Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail create label", "error", err, "name", name)

		return Label{}, classifyErr(err)
	}

	return Label{Id: created.Id, Name: created.Name}, nil
}

func (this *service) AddLabel(ctx context.Context, messageId, labelId string) error {
	_, err := this.api.Users.Messages.Modify("me", messageId,
		&gmailapi.ModifyMessageRequest{AddLabelIds: []string{labelId}}).Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail add label", "error", err, "message", messageId)
	}

	return classifyErr(err)
}

func (this *service) RemoveLabel(ctx context.Context, messageId, labelId string) error {
	_, err := this.api.Users.Messages.Modify("me", messageId,
		&gmailapi.ModifyMessageRequest{RemoveLabelIds: []string{labelId}}).Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail remove label", "error", err, "message", messageId)
	}

	return classifyErr(err)
}
