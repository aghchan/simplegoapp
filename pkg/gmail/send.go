package gmail

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

	gmailapi "google.golang.org/api/gmail/v1"
)

func (this *service) SendToSelf(ctx context.Context, subject, body string) error {
	return this.send(ctx, subject, "text/plain", body)
}

func (this *service) SendHTMLToSelf(ctx context.Context, subject, htmlBody string) error {
	return this.send(ctx, subject, "text/html", htmlBody)
}

func (this *service) send(ctx context.Context, subject, contentType, body string) error {
	address, err := this.selfAddress(ctx)
	if err != nil {
		return err
	}
	address = headerSafe(address)
	subject = headerSafe(subject)

	raw := fmt.Sprintf("To: %s\r\nSubject: %s\r\nContent-Type: %s; charset=utf-8\r\n\r\n%s",
		address, subject, contentType, body)
	encoded := base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString([]byte(raw))

	_, err = this.api.Users.Messages.Send("me", &gmailapi.Message{Raw: encoded}).Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail send to self", "error", err)
	}

	return classifyErr(err)
}

// headerSafe truncates at the first CR or LF so caller-supplied text cannot
// mint extra RFC822 headers — the structural no-third-party guarantee must
// not depend on callers sanitizing their inputs. Truncating rather than
// collapsing to a space also drops the injected continuation outright,
// instead of leaving attacker-controlled text appended to a legitimate
// header's visible value.
func headerSafe(value string) string {
	if idx := strings.IndexAny(value, "\r\n"); idx != -1 {
		value = value[:idx]
	}

	return strings.TrimSpace(value)
}

func (this *service) selfAddress(ctx context.Context) (string, error) {
	this.mu.Lock()
	defer this.mu.Unlock()
	if this.self != "" {
		return this.self, nil
	}

	profile, err := this.api.Users.GetProfile("me").Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail get profile", "error", err)

		return "", classifyErr(err)
	}
	this.self = profile.EmailAddress

	return this.self, nil
}
