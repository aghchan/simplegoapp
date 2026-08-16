package linear

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

const dateLayout = "2006-01-02"

var (
	ErrNotFound    = errors.New("linear: not found")
	ErrRateLimited = errors.New("linear: rate limited")
	ErrUnorganized = errors.New("linear: workspace is missing a required workflow state")
)

type Issue struct {
	Id          string
	Identifier  string
	Title       string
	Description string
	State       string
	DueDate     *time.Time
	Project     string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type IssueInput struct {
	Title       string
	Description string
	State       string
	DueDate     *time.Time
	Project     string
}

// IssuePatch applies only its non-nil fields.
type IssuePatch struct {
	Title       *string
	Description *string
	State       *string
	DueDate     *time.Time
}

type IssueQuery struct {
	State  string
	Limit  int
	Cursor string
}

type IssuePage struct {
	Issues     []Issue
	NextCursor string
}

type Team struct {
	Id   string
	Key  string
	Name string
}

type Attachment struct {
	Id    string
	Url   string
	Title string
}

type Service interface {
	CreateIssue(ctx context.Context, input IssueInput) (Issue, error)
	UpdateIssue(ctx context.Context, id string, patch IssuePatch) (Issue, error)
	Issue(ctx context.Context, id string) (Issue, error)
	Issues(ctx context.Context, query IssueQuery) (IssuePage, error)
	StateNames(ctx context.Context) ([]string, error)
	CreateComment(ctx context.Context, issueId, body string) error
	// Attachments and AttachURL carry the agent's thread⇄issue links.
	// attachmentCreate is idempotent per (issue, url) on Linear's side.
	Attachments(ctx context.Context, issueId string) ([]Attachment, error)
	AttachURL(ctx context.Context, issueId, url, title string) error
	// Teams is the only call that works without a configured team id, which is
	// what makes it usable for discovering one during setup.
	Teams(ctx context.Context) ([]Team, error)
}

type StateInput struct {
	Name string
	// Type drives Linear's board grouping and what counts as active work:
	// backlog, unstarted, started, completed, canceled.
	Type  string
	Color string
}

// Admin covers one-time workspace setup. It is deliberately outside Service so
// the running app cannot reshape the workspace it reads from.
type Admin interface {
	CreateState(ctx context.Context, state StateInput) (string, error)
}

func NewAdmin(
	config map[string]interface{},
	logger logger.Logger,
) Admin {
	return NewService(config, logger).(*service)
}

// NewService requires config keys linear_api_key (a personal API key, sent
// unprefixed per Linear's docs) and linear_team_id. linear_base_url is
// optional and exists so tests can point at a local server.
func NewService(
	config map[string]interface{},
	logger logger.Logger,
) Service {
	baseUrl, _ := config["linear_base_url"].(string)
	if baseUrl == "" {
		baseUrl = "https://api.linear.app/graphql"
	}

	return &service{
		logger:  logger,
		apiKey:  config["linear_api_key"].(string),
		teamId:  config["linear_team_id"].(string),
		baseUrl: baseUrl,
		client:  &http.Client{Timeout: 15 * time.Second},
	}
}

type service struct {
	logger logger.Logger

	apiKey  string
	teamId  string
	baseUrl string
	client  *http.Client

	mu     sync.RWMutex
	states map[string]string
}

type graphqlRequest struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables,omitempty"`
}

type graphqlResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// query executes one GraphQL document and decodes data into out. Linear
// reports application errors in a 200 body, so the status check alone is not
// enough to call a call successful.
func (this *service) query(ctx context.Context, document string, variables map[string]interface{}, out interface{}) error {
	body, err := json.Marshal(graphqlRequest{Query: document, Variables: variables})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, this.baseUrl, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", this.apiKey)

	resp, err := this.client.Do(req)
	if err != nil {
		this.logger.Error("calling linear", "error", err)

		return err
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if resp.StatusCode == http.StatusTooManyRequests {
		this.logger.Error("linear rate limited", "status", resp.StatusCode)

		return ErrRateLimited
	}
	if resp.StatusCode != http.StatusOK {
		this.logger.Error(
			"linear returned an error status",
			"status", resp.StatusCode,
			"body", truncate(string(payload)),
		)

		return fmt.Errorf("linear: unexpected status %d", resp.StatusCode)
	}

	var envelope graphqlResponse
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return err
	}
	if len(envelope.Errors) > 0 {
		messages := make([]string, len(envelope.Errors))
		for i, e := range envelope.Errors {
			messages[i] = e.Message
		}
		joined := strings.Join(messages, "; ")
		this.logger.Error("linear graphql error", "error", joined)

		return fmt.Errorf("linear: %s", joined)
	}

	return json.Unmarshal(envelope.Data, out)
}

func truncate(s string) string {
	if len(s) > 300 {
		return s[:300]
	}

	return s
}

func formatDate(t *time.Time) interface{} {
	if t == nil {
		return nil
	}

	return t.Format(dateLayout)
}

func parseTimestamp(s string) time.Time {
	parsed, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}

	return parsed
}

func parseDate(s *string) *time.Time {
	if s == nil || *s == "" {
		return nil
	}

	parsed, err := time.Parse(dateLayout, *s)
	if err != nil {
		return nil
	}

	return &parsed
}
