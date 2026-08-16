package gmail

import "context"

// Stubs for methods delivered by later tasks in this plan; each panics so an
// accidental call is loud. Deleted as the real implementations land.
func (this *service) Message(ctx context.Context, id string) (Message, error) {
	panic("pkg/gmail: Message not yet implemented")
}

func (this *service) SendToSelf(ctx context.Context, subject, body string) error {
	panic("pkg/gmail: SendToSelf not yet implemented")
}

func (this *service) EnsureLabel(ctx context.Context, name string) (Label, error) {
	panic("pkg/gmail: EnsureLabel not yet implemented")
}

func (this *service) AddLabel(ctx context.Context, messageId, labelId string) error {
	panic("pkg/gmail: AddLabel not yet implemented")
}

func (this *service) RemoveLabel(ctx context.Context, messageId, labelId string) error {
	panic("pkg/gmail: RemoveLabel not yet implemented")
}
