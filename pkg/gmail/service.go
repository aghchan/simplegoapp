package gmail

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	gmailapi "google.golang.org/api/gmail/v1"
	"google.golang.org/api/option"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type MessageRef struct {
	Id       string
	ThreadId string
}

type Message struct {
	Id       string
	ThreadId string
	From     string
	To       string
	Subject  string
	Body     string
	LabelIds []string
	Received time.Time
}

type Label struct {
	Id   string
	Name string
}

type Service interface {
	Search(ctx context.Context, query string) ([]MessageRef, error)
	Message(ctx context.Context, id string) (Message, error)
	// SendToSelf is the only send that exists: the recipient is always the
	// authenticated account, so no caller can address a third party.
	SendToSelf(ctx context.Context, subject, body string) error
	EnsureLabel(ctx context.Context, name string) (Label, error)
	AddLabel(ctx context.Context, messageId, labelId string) error
	RemoveLabel(ctx context.Context, messageId, labelId string) error
}

// NewService requires config keys gmail_credentials_path (OAuth desktop
// client JSON; consent screen must be published to production or refresh
// tokens die every 7 days) and gmail_token_path (cache written by Authorize).
// gmail_base_url overrides the API endpoint and skips auth — the test seam.
func NewService(
	config map[string]interface{},
	logger logger.Logger,
) (Service, error) {
	baseUrl, _ := config["gmail_base_url"].(string)
	if baseUrl != "" {
		api, err := gmailapi.NewService(context.Background(),
			option.WithoutAuthentication(), option.WithEndpoint(baseUrl))
		if err != nil {
			return nil, err
		}

		return &service{logger: logger, api: api}, nil
	}

	credentialsPath := config["gmail_credentials_path"].(string)
	tokenPath := config["gmail_token_path"].(string)

	oauthConfig, err := oauthConfigFromFile(credentialsPath)
	if err != nil {
		return nil, err
	}
	token, err := tokenFromFile(tokenPath)
	if err != nil {
		return nil, fmt.Errorf(
			"gmail: no cached token at %s — run the authorize command first: %w", tokenPath, err)
	}

	api, err := gmailapi.NewService(context.Background(),
		option.WithTokenSource(oauthConfig.TokenSource(context.Background(), token)))
	if err != nil {
		return nil, err
	}

	return &service{logger: logger, api: api}, nil
}

type service struct {
	logger logger.Logger

	api *gmailapi.Service

	//lint:ignore U1000 will cache the authenticated address for SendToSelf
	mu sync.Mutex
	//lint:ignore U1000 will cache the authenticated address for SendToSelf
	self string
}

func oauthConfigFromFile(path string) (*oauth2.Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("gmail: reading credentials: %w", err)
	}

	return google.ConfigFromJSON(raw, gmailapi.GmailModifyScope, gmailapi.GmailSendScope)
}

func tokenFromFile(path string) (*oauth2.Token, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	token := &oauth2.Token{}
	if err := json.Unmarshal(raw, token); err != nil {
		return nil, err
	}

	return token, nil
}
