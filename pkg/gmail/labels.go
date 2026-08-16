package gmail

import (
	"context"

	gmailapi "google.golang.org/api/gmail/v1"
)

// EnsureLabel is list-then-create; if two instances race the create, the
// loser re-lists and adopts the winner's label instead of erroring.
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
		// create-if-absent race (concurrent instance won): re-list and
		// adopt the winner rather than failing the run.
		relisted, listErr := this.api.Users.Labels.List("me").Context(ctx).Do()
		if listErr == nil {
			for _, label := range relisted.Labels {
				if label.Name == name {
					this.logger.Info("label create race recovered", "name", name)

					return Label{Id: label.Id, Name: label.Name}, nil
				}
			}
		}
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
