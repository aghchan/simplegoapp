package gmail

import "context"

// Stubs for methods delivered by later tasks in this plan; each panics so an
// accidental call is loud. Deleted as the real implementations land.
func (this *service) SendToSelf(ctx context.Context, subject, body string) error {
	panic("pkg/gmail: SendToSelf not yet implemented")
}
