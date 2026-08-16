# PM Agent Part A — Upstream Components (pkg/gmail + pkg/linear additions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the framework components the PM agent needs — a Gmail client
(message-granular, send-to-self-only) and Linear attachment/comment reads —
tested against fake HTTP servers, then tag `v0.2.0` and bump the recruiter
consumer.

**Architecture:** Two `pkg/` components in simplegoapp following the house
Service pattern (interface + unexported struct + `NewService`, vendor types
never leak, receivers named `this`). `pkg/gmail` wraps
`google.golang.org/api/gmail/v1` behind package-owned structs with a
config-driven base-URL test seam (the `pkg/linear` pattern). `pkg/linear`
gains issue attachments (read + idempotent URL attach) and comment reads.
Design authority: recruiter repo `docs/superpowers/specs/2026-08-15-pm-agent-v1-design.md`.

**Tech Stack:** Go 1.25, `google.golang.org/api/gmail/v1`,
`golang.org/x/oauth2` + `golang.org/x/oauth2/google`, `httptest` fakes.

**House rules (apply to every task):** receivers named `this`; comments only
for non-obvious constraints; `gofmt` + `staticcheck` clean (ST1006 excluded
by staticcheck.conf); tests co-located in the package.

---

## File structure

```
simplegoapp/
├── pkg/linear/
│   ├── service.go        # Modify: add Attachment/Comment types + Service methods
│   ├── issues.go         # Modify: implement Attachments/AttachURL/Comments
│   ├── service_test.go   # Modify: fake-server tests for the new methods
│   └── CLAUDE.md         # Modify: document the new contracts
├── pkg/gmail/
│   ├── service.go        # Create: types, Service interface, NewService, OAuth wiring
│   ├── message.go        # Create: Search/Message (payload walking, base64url)
│   ├── labels.go         # Create: EnsureLabel/AddLabel/RemoveLabel
│   ├── send.go           # Create: SendToSelf (profile fetch, RFC 2822 compose)
│   ├── authorize.go      # Create: interactive consent helper (manual verify)
│   ├── service_test.go   # Create: fake Gmail HTTP server + all behavior tests
│   └── CLAUDE.md         # Create: contracts + sharp edges
└── docs/BEST_PRACTICES.md  # Modify: add gmail to the wrapper list
```

Dependency note: `go get google.golang.org/api@latest golang.org/x/oauth2@latest`
happens in Task 3 Step 1; both are Apache-2.0.

---

### Task 1: pkg/linear — Attachments (read + idempotent attach)

**Files:**
- Modify: `pkg/linear/service.go` (Service interface + types)
- Modify: `pkg/linear/issues.go` (implementations)
- Modify: `pkg/linear/service_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `pkg/linear/service_test.go`:

```go
func TestAttachmentsReadsIssueAttachments(t *testing.T) {
	service, _ := newTestService(t, func(call recordedCall) string {
		return `{"data":{"issue":{"attachments":{"nodes":[
			{"id":"att-1","url":"https://mail.google.com/mail/u/0/#all/t1","title":"Gmail thread"}]}}}}`
	})

	attachments, err := service.Attachments(context.Background(), "issue-1")
	if err != nil {
		t.Fatalf("attachments: %v", err)
	}
	if len(attachments) != 1 || attachments[0].Url != "https://mail.google.com/mail/u/0/#all/t1" {
		t.Fatalf("unexpected attachments: %+v", attachments)
	}
}

func TestAttachmentsNotFoundOnNullIssue(t *testing.T) {
	service, _ := newTestService(t, func(call recordedCall) string {
		return `{"data":{"issue":null}}`
	})

	_, err := service.Attachments(context.Background(), "missing")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

func TestAttachURLSendsCreateMutation(t *testing.T) {
	service, calls := newTestService(t, func(call recordedCall) string {
		return `{"data":{"attachmentCreate":{"success":true}}}`
	})

	err := service.AttachURL(context.Background(), "issue-1",
		"https://mail.google.com/mail/u/0/#all/t1", "Gmail thread")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}

	sent := (*calls)[0]
	if !strings.Contains(sent.Query, "attachmentCreate") {
		t.Fatalf("wrong mutation: %s", sent.Query)
	}
	input := sent.Variables["input"].(map[string]interface{})
	if input["issueId"] != "issue-1" || input["url"] != "https://mail.google.com/mail/u/0/#all/t1" {
		t.Fatalf("input not forwarded: %+v", input)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/simplegoapp && go test ./pkg/linear/ -run 'TestAttach' -v`
Expected: FAIL — `service.Attachments undefined` (compile error).

- [ ] **Step 3: Add types and interface methods**

In `pkg/linear/service.go`, after the `Team` type:

```go
type Attachment struct {
	Id    string
	Url   string
	Title string
}
```

Add to the `Service` interface (after `CreateComment`):

```go
	// Attachments and AttachURL carry the agent's thread⇄issue links.
	// attachmentCreate is idempotent per (issue, url) on Linear's side.
	Attachments(ctx context.Context, issueId string) ([]Attachment, error)
	AttachURL(ctx context.Context, issueId, url, title string) error
```

- [ ] **Step 4: Implement in `pkg/linear/issues.go`**

Append:

```go
func (this *service) Attachments(ctx context.Context, issueId string) ([]Attachment, error) {
	var result struct {
		Issue *struct {
			Attachments struct {
				Nodes []Attachment `json:"nodes"`
			} `json:"attachments"`
		} `json:"issue"`
	}
	document := `query($id: String!) { issue(id: $id) { attachments { nodes { id url title } } } }`

	err := this.query(ctx, document, map[string]interface{}{"id": issueId}, &result)
	if err != nil {
		if isMissing(err) {
			return nil, ErrNotFound
		}

		return nil, err
	}
	if result.Issue == nil {
		return nil, ErrNotFound
	}

	return result.Issue.Attachments.Nodes, nil
}

func (this *service) AttachURL(ctx context.Context, issueId, url, title string) error {
	var result struct {
		AttachmentCreate struct {
			Success bool `json:"success"`
		} `json:"attachmentCreate"`
	}
	document := `mutation($input: AttachmentCreateInput!) {
		attachmentCreate(input: $input) { success }
	}`
	variables := map[string]interface{}{
		"input": map[string]interface{}{"issueId": issueId, "url": url, "title": title},
	}

	if err := this.query(ctx, document, variables, &result); err != nil {
		return err
	}
	if !result.AttachmentCreate.Success {
		return fmt.Errorf("linear: attachment create rejected")
	}

	return nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/linear/ -count=1`
Expected: PASS (all, including the pre-existing suite — the fake service in
recruiter isn't in this repo, so nothing else needs updating yet).

- [ ] **Step 6: Commit**

```bash
git add pkg/linear && git commit -m "pkg/linear: issue attachments (read + idempotent URL attach)"
```

---

### Task 2: pkg/linear — Comments read (for comment-marker idempotency)

**Files:**
- Modify: `pkg/linear/service.go`, `pkg/linear/issues.go`, `pkg/linear/service_test.go`, `pkg/linear/CLAUDE.md`

- [ ] **Step 1: Write the failing test**

Append to `pkg/linear/service_test.go`:

```go
func TestCommentsReadsBodiesNewestFirst(t *testing.T) {
	service, calls := newTestService(t, func(call recordedCall) string {
		return `{"data":{"issue":{"comments":{"nodes":[
			{"id":"c2","body":"newer"},{"id":"c1","body":"older"}]}}}}`
	})

	comments, err := service.Comments(context.Background(), "issue-1")
	if err != nil {
		t.Fatalf("comments: %v", err)
	}
	if len(comments) != 2 || comments[0].Body != "newer" {
		t.Fatalf("unexpected comments: %+v", comments)
	}
	if !strings.Contains((*calls)[0].Query, "last:") {
		t.Fatalf("query should page from the newest end: %s", (*calls)[0].Query)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/linear/ -run TestComments -v`
Expected: FAIL — `service.Comments undefined`.

- [ ] **Step 3: Implement**

`pkg/linear/service.go` — type after `Attachment`, method after `AttachURL` in the interface:

```go
type Comment struct {
	Id   string
	Body string
}
```

```go
	// Comments returns the newest 50 comment bodies — enough for the
	// agent's marker check without paging an entire history.
	Comments(ctx context.Context, issueId string) ([]Comment, error)
```

`pkg/linear/issues.go`:

```go
func (this *service) Comments(ctx context.Context, issueId string) ([]Comment, error) {
	var result struct {
		Issue *struct {
			Comments struct {
				Nodes []Comment `json:"nodes"`
			} `json:"comments"`
		} `json:"issue"`
	}
	document := `query($id: String!) { issue(id: $id) { comments(last: 50) { nodes { id body } } } }`

	err := this.query(ctx, document, map[string]interface{}{"id": issueId}, &result)
	if err != nil {
		if isMissing(err) {
			return nil, ErrNotFound
		}

		return nil, err
	}
	if result.Issue == nil {
		return nil, ErrNotFound
	}

	nodes := result.Issue.Comments.Nodes
	for i, j := 0, len(nodes)-1; i < j; i, j = i+1, j-1 {
		nodes[i], nodes[j] = nodes[j], nodes[i]
	}

	return nodes, nil
}
```

(`comments(last: 50)` returns oldest→newest within the window; the reversal
gives callers newest-first, matching the test.)

- [ ] **Step 4: Run tests, update CLAUDE.md, commit**

Run: `go test ./pkg/linear/ -count=1` — expected PASS.

Add to `pkg/linear/CLAUDE.md` under Contracts:

```markdown
- `Attachments`/`AttachURL` — thread⇄issue links; `attachmentCreate` is
  idempotent per (issue, url). `Comments` returns the newest 50, newest
  first — sized for marker checks, not history export.
```

```bash
git add pkg/linear && git commit -m "pkg/linear: newest-first comment reads"
```

---

### Task 3: pkg/gmail — scaffolding, fake server, Search

**Files:**
- Create: `pkg/gmail/service.go`, `pkg/gmail/message.go`, `pkg/gmail/service_test.go`

- [ ] **Step 1: Add dependencies**

```bash
cd ~/workspace/simplegoapp && go get google.golang.org/api@latest golang.org/x/oauth2@latest && go mod tidy
```

- [ ] **Step 2: Write the failing Search test with the fake-server harness**

Create `pkg/gmail/service_test.go`:

```go
package gmail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

// fakeGmail routes Gmail REST paths to canned handlers and records requests.
type fakeGmail struct {
	server   *httptest.Server
	requests []*http.Request
	bodies   []map[string]interface{}
	handle   map[string]func(r *http.Request) (int, string)
}

func newFakeGmail(t *testing.T) *fakeGmail {
	t.Helper()
	fake := &fakeGmail{handle: map[string]func(*http.Request) (int, string){}}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		fake.requests = append(fake.requests, r)
		fake.bodies = append(fake.bodies, body)

		handler, ok := fake.handle[r.URL.Path]
		if !ok {
			t.Errorf("unhandled fake path: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		status, payload := handler(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(payload))
	}))
	t.Cleanup(fake.server.Close)

	return fake
}

func newTestService(t *testing.T, fake *fakeGmail) Service {
	t.Helper()
	service, err := NewService(map[string]interface{}{
		"gmail_credentials_path": "",
		"gmail_token_path":       "",
		"gmail_base_url":         fake.server.URL + "/",
	}, logger.NewService())
	if err != nil {
		t.Fatalf("constructing service: %v", err)
	}

	return service
}

func TestSearchReturnsMessageRefsAcrossPages(t *testing.T) {
	fake := newFakeGmail(t)
	page := 0
	fake.handle["/users/me/messages"] = func(r *http.Request) (int, string) {
		if got := r.URL.Query().Get("q"); got != "newer_than:14d" {
			t.Errorf("query not forwarded: %q", got)
		}
		page++
		if page == 1 {
			return 200, `{"messages":[{"id":"m1","threadId":"t1"}],"nextPageToken":"p2"}`
		}
		return 200, `{"messages":[{"id":"m2","threadId":"t1"}]}`
	}

	refs, err := newTestService(t, fake).Search(context.Background(), "newer_than:14d")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(refs) != 2 || refs[0].Id != "m1" || refs[1].Id != "m2" {
		t.Fatalf("unexpected refs: %+v", refs)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./pkg/gmail/ -v`
Expected: FAIL to compile — package doesn't exist yet.

- [ ] **Step 4: Create `pkg/gmail/service.go`**

```go
package gmail

import (
	"context"
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

	mu   sync.Mutex
	self string
}

func oauthConfigFromFile(path string) (*oauth2.Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("gmail: reading credentials: %w", err)
	}

	return google.ConfigFromJSON(raw, gmailapi.GmailModifyScope, gmailapi.GmailSendScope)
}
```

- [ ] **Step 5: Create `pkg/gmail/message.go` with Search**

```go
package gmail

import "context"

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
```

`tokenFromFile` is referenced by service.go but written in Task 6 with
Authorize — for now add a stub at the bottom of `service.go` so the package
compiles, replaced in Task 6:

```go
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
```

(Add `"encoding/json"` to service.go's imports. This is the final version —
Task 6 only adds Authorize alongside it.)

- [ ] **Step 6: Run test to verify it passes**

Run: `go test ./pkg/gmail/ -count=1 -v`
Expected: PASS (`TestSearchReturnsMessageRefsAcrossPages`).

- [ ] **Step 7: Commit**

```bash
git add pkg/gmail go.mod go.sum && git commit -m "pkg/gmail: service scaffolding and paged Search"
```

---

### Task 4: pkg/gmail — Message (payload walking, plain-text extraction)

**Files:**
- Modify: `pkg/gmail/message.go`, `pkg/gmail/service_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/gmail/service_test.go`:

```go
func TestMessageExtractsPlainTextFromNestedMultipart(t *testing.T) {
	fake := newFakeGmail(t)
	// "hello world" base64url; nested multipart/alternative inside mixed —
	// the shape real ATS mail arrives in.
	fake.handle["/users/me/messages/m1"] = func(r *http.Request) (int, string) {
		return 200, `{
			"id":"m1","threadId":"t1","labelIds":["INBOX","Label_7"],
			"internalDate":"1786745190000",
			"payload":{
				"mimeType":"multipart/mixed",
				"headers":[
					{"name":"From","value":"Lauren Watrous <lauren@metriport.com>"},
					{"name":"To","value":"alanghchan@gmail.com"},
					{"name":"Subject","value":"Interview with Metriport"}],
				"parts":[{
					"mimeType":"multipart/alternative",
					"parts":[
						{"mimeType":"text/plain","body":{"data":"aGVsbG8gd29ybGQ"}},
						{"mimeType":"text/html","body":{"data":"PGI-aHRtbDwvYj4"}}]}]}}`
	}

	message, err := newTestService(t, fake).Message(context.Background(), "m1")
	if err != nil {
		t.Fatalf("message: %v", err)
	}
	if message.Body != "hello world" {
		t.Fatalf("body %q, want plain text part", message.Body)
	}
	if message.From != "Lauren Watrous <lauren@metriport.com>" || message.Subject != "Interview with Metriport" {
		t.Fatalf("headers lost: %+v", message)
	}
	if len(message.LabelIds) != 2 || message.ThreadId != "t1" {
		t.Fatalf("metadata lost: %+v", message)
	}
	if message.Received.IsZero() {
		t.Fatalf("internalDate not parsed")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/gmail/ -run TestMessageExtracts -v`
Expected: FAIL — `Message undefined` (method not yet written).

- [ ] **Step 3: Implement in `pkg/gmail/message.go`**

Append:

```go
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
```

Imports for message.go become:

```go
import (
	"context"
	"encoding/base64"
	"time"

	gmailapi "google.golang.org/api/gmail/v1"
)
```

- [ ] **Step 4: Run tests, commit**

Run: `go test ./pkg/gmail/ -count=1` — expected PASS (both tests).

```bash
git add pkg/gmail && git commit -m "pkg/gmail: full message reads with plain-text extraction"
```

---

### Task 5: pkg/gmail — labels

**Files:**
- Create: `pkg/gmail/labels.go`
- Modify: `pkg/gmail/service_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `pkg/gmail/service_test.go`:

```go
func TestEnsureLabelReturnsExistingByName(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/users/me/labels"] = func(r *http.Request) (int, string) {
		if r.Method == http.MethodPost {
			t.Errorf("must not create when the label exists")
		}
		return 200, `{"labels":[{"id":"Label_7","name":"recruiter-processed"}]}`
	}

	label, err := newTestService(t, fake).EnsureLabel(context.Background(), "recruiter-processed")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if label.Id != "Label_7" {
		t.Fatalf("wrong label: %+v", label)
	}
}

func TestEnsureLabelCreatesWhenMissing(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/users/me/labels"] = func(r *http.Request) (int, string) {
		if r.Method == http.MethodPost {
			return 200, `{"id":"Label_9","name":"recruiter-unmatched"}`
		}
		return 200, `{"labels":[]}`
	}

	label, err := newTestService(t, fake).EnsureLabel(context.Background(), "recruiter-unmatched")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if label.Id != "Label_9" {
		t.Fatalf("wrong label: %+v", label)
	}
}

func TestAddLabelSendsModify(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/users/me/messages/m1/modify"] = func(r *http.Request) (int, string) {
		return 200, `{"id":"m1"}`
	}

	if err := newTestService(t, fake).AddLabel(context.Background(), "m1", "Label_7"); err != nil {
		t.Fatalf("add label: %v", err)
	}

	last := fake.bodies[len(fake.bodies)-1]
	added, _ := last["addLabelIds"].([]interface{})
	if len(added) != 1 || added[0] != "Label_7" {
		t.Fatalf("modify body wrong: %+v", last)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/gmail/ -run 'TestEnsureLabel|TestAddLabel' -v`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Create `pkg/gmail/labels.go`**

```go
package gmail

import (
	"context"

	gmailapi "google.golang.org/api/gmail/v1"
)

func (this *service) EnsureLabel(ctx context.Context, name string) (Label, error) {
	response, err := this.api.Users.Labels.List("me").Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail list labels", "error", err)

		return Label{}, err
	}
	for _, label := range response.Labels {
		if label.Name == name {
			return Label{Id: label.Id, Name: label.Name}, nil
		}
	}

	created, err := this.api.Users.Labels.Create("me", &gmailapi.Label{Name: name}).Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail create label", "error", err, "name", name)

		return Label{}, err
	}

	return Label{Id: created.Id, Name: created.Name}, nil
}

func (this *service) AddLabel(ctx context.Context, messageId, labelId string) error {
	_, err := this.api.Users.Messages.Modify("me", messageId,
		&gmailapi.ModifyMessageRequest{AddLabelIds: []string{labelId}}).Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail add label", "error", err, "message", messageId)
	}

	return err
}

func (this *service) RemoveLabel(ctx context.Context, messageId, labelId string) error {
	_, err := this.api.Users.Messages.Modify("me", messageId,
		&gmailapi.ModifyMessageRequest{RemoveLabelIds: []string{labelId}}).Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail remove label", "error", err, "message", messageId)
	}

	return err
}
```

- [ ] **Step 4: Run tests, commit**

Run: `go test ./pkg/gmail/ -count=1` — expected PASS.

```bash
git add pkg/gmail && git commit -m "pkg/gmail: ensure/add/remove labels"
```

---

### Task 6: pkg/gmail — SendToSelf + Authorize

**Files:**
- Create: `pkg/gmail/send.go`, `pkg/gmail/authorize.go`
- Modify: `pkg/gmail/service_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `pkg/gmail/service_test.go` (add `"encoding/base64"` and
`"strings"` to its imports):

```go
func TestSendToSelfAddressesTheAuthenticatedUserOnly(t *testing.T) {
	fake := newFakeGmail(t)
	profileCalls := 0
	fake.handle["/users/me/profile"] = func(r *http.Request) (int, string) {
		profileCalls++
		return 200, `{"emailAddress":"alan@example.com"}`
	}
	fake.handle["/users/me/messages/send"] = func(r *http.Request) (int, string) {
		return 200, `{"id":"sent-1"}`
	}

	service := newTestService(t, fake)
	if err := service.SendToSelf(context.Background(), "Morning brief", "hello"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := service.SendToSelf(context.Background(), "Again", "world"); err != nil {
		t.Fatalf("second send: %v", err)
	}
	if profileCalls != 1 {
		t.Fatalf("profile fetched %d times, want cached after 1", profileCalls)
	}

	var sendBody map[string]interface{}
	for _, body := range fake.bodies {
		if _, ok := body["raw"]; ok {
			sendBody = body
			break
		}
	}
	raw, _ := base64.URLEncoding.WithPadding(base64.NoPadding).DecodeString(sendBody["raw"].(string))
	message := string(raw)
	if !strings.Contains(message, "To: alan@example.com\r\n") {
		t.Fatalf("recipient not the authenticated user:\n%s", message)
	}
	if !strings.Contains(message, "Subject: Morning brief\r\n") || !strings.Contains(message, "hello") {
		t.Fatalf("subject/body missing:\n%s", message)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/gmail/ -run TestSendToSelf -v`
Expected: FAIL — `SendToSelf` undefined.

- [ ] **Step 3: Create `pkg/gmail/send.go`**

```go
package gmail

import (
	"context"
	"encoding/base64"
	"fmt"

	gmailapi "google.golang.org/api/gmail/v1"
)

func (this *service) SendToSelf(ctx context.Context, subject, body string) error {
	address, err := this.selfAddress(ctx)
	if err != nil {
		return err
	}

	raw := fmt.Sprintf("To: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s",
		address, subject, body)
	encoded := base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString([]byte(raw))

	_, err = this.api.Users.Messages.Send("me", &gmailapi.Message{Raw: encoded}).Context(ctx).Do()
	if err != nil {
		this.logger.Error("gmail send to self", "error", err)
	}

	return err
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

		return "", err
	}
	this.self = profile.EmailAddress

	return this.self, nil
}
```

- [ ] **Step 4: Create `pkg/gmail/authorize.go`**

```go
package gmail

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
)

// Authorize runs the one-time interactive consent flow and caches the token.
// It listens on a loopback port for the OAuth redirect, prints the consent
// URL for the user to open, and writes the token JSON to tokenPath (0600).
// The agent never calls this — a setup command does.
func Authorize(ctx context.Context, credentialsPath, tokenPath string) error {
	oauthConfig, err := oauthConfigFromFile(credentialsPath)
	if err != nil {
		return err
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	oauthConfig.RedirectURL = fmt.Sprintf("http://%s/", listener.Addr().String())

	codes := make(chan string, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		codes <- r.URL.Query().Get("code")
		fmt.Fprintln(w, "Authorized — you can close this tab.")
	})}
	go server.Serve(listener)
	defer server.Close()

	fmt.Printf("\nOpen this URL, sign in as the target account, and approve:\n\n  %s\n\n",
		oauthConfig.AuthCodeURL("state", oauth2AccessTypeOffline()...))

	var code string
	select {
	case code = <-codes:
	case <-ctx.Done():
		return ctx.Err()
	}

	token, err := oauthConfig.Exchange(ctx, code)
	if err != nil {
		return err
	}

	raw, err := json.Marshal(token)
	if err != nil {
		return err
	}

	return os.WriteFile(tokenPath, raw, 0o600)
}
```

And at the bottom of `pkg/gmail/service.go` add the tiny option helper
(keeps the vendored oauth2 import out of authorize.go's signature):

```go
func oauth2AccessTypeOffline() []oauth2.AuthCodeOption {
	return []oauth2.AuthCodeOption{oauth2.AccessTypeOffline}
}
```

- [ ] **Step 5: Run the full package, commit**

Run: `go test ./pkg/gmail/ -count=1` — expected PASS (all).
Run: `go build ./... && go vet ./... && go run honnef.co/go/tools/cmd/staticcheck@2026.1 ./...` — expected clean.

```bash
git add pkg/gmail && git commit -m "pkg/gmail: SendToSelf with cached self-address; interactive Authorize helper"
```

---

### Task 7: docs, CI, tag, consumer bump

**Files:**
- Create: `pkg/gmail/CLAUDE.md`
- Modify: `docs/BEST_PRACTICES.md`
- Then: tag + recruiter bump

- [ ] **Step 1: Write `pkg/gmail/CLAUDE.md`**

```markdown
# pkg/gmail — Gmail REST wrapper

Message-granular by design: Gmail labels are per-message (new messages in a
labeled thread do NOT inherit the label), so consumers must check
`Message.LabelIds` client-side; query-string `-label:` exclusion is only a
prefilter.

## Contracts

- `Search` pages internally (cap 10 pages) and returns message refs, not
  threads.
- `Message` extracts the first text/plain MIME part; HTML-only mail yields an
  empty body — headers still carry the signal.
- `SendToSelf` is the ONLY send: it addresses the authenticated account
  (cached from users.getProfile), so a third-party recipient is
  unrepresentable. Do not add a general Send.
- `EnsureLabel` is create-or-get by exact name. Use hyphenated names
  (`recruiter-processed`) — slash-nested names translate undocumentedly in
  search syntax.
- `Authorize` is setup-only (interactive consent, loopback redirect, writes
  the token 0600). The service constructor fails with instructions when the
  token cache is missing.

## Setup prerequisite

The OAuth consent screen MUST be published to "In production": Testing-status
refresh tokens expire every 7 days. Unverified-in-production is fine for a
single personal user. `invalid_grant` at runtime means the token is dead —
re-run Authorize.

## Tests

`service_test.go` runs against a fake Gmail HTTP server via the
`gmail_base_url` config seam — they lock in our request shapes and parsing,
not Google's behavior.
```

- [ ] **Step 2: Add to `docs/BEST_PRACTICES.md` §6 wrapper list**

After the `pkg/linear` bullet:

```markdown
- Gmail's REST API → `pkg/gmail` — message-granular search/read/labels and a
  send that can only address the authenticated user.
```

- [ ] **Step 3: Full CI locally, push, tag**

Run: `gofmt -l . ; go build ./... && go vet ./... && go run honnef.co/go/tools/cmd/staticcheck@2026.1 ./... && make check-api && go test ./... -count=1 -race`
Expected: all clean/PASS.

```bash
git add pkg/gmail docs/BEST_PRACTICES.md && git commit -m "pkg/gmail docs; wrapper list entry" && git push origin main
git tag v0.2.0 && git push origin v0.2.0
```

- [ ] **Step 4: Bump the consumer (the standing rule)**

```bash
cd ~/workspace/recruiter && GOFLAGS=-mod=mod go get github.com/aghchan/simplegoapp@v0.2.0 && go mod tidy && go test ./... -count=1 && git add go.mod go.sum && git commit -m "Bump simplegoapp to v0.2.0 (pkg/gmail, linear attachments/comments)" && git push origin main
```

Expected: recruiter tests PASS. Note: recruiter's `domain/applications`
fake of `linear.Service` must gain the three new methods to compile —
add to `domain/applications/service_test.go`:

```go
func (this *fakeLinear) Attachments(ctx context.Context, issueId string) ([]linear.Attachment, error) {
	return nil, nil
}

func (this *fakeLinear) AttachURL(ctx context.Context, issueId, url, title string) error {
	return nil
}

func (this *fakeLinear) Comments(ctx context.Context, issueId string) ([]linear.Comment, error) {
	return nil, nil
}
```

- [ ] **Step 5: Verify CI on both repos**

Run: `gh run list --workflow ci --limit 1` in each repo once runs complete.
Expected: `completed success` for both.

---

## Manual verification (after Task 7, requires Alan)

Alan creates the GCP OAuth client (consent screen → In production), saves the
credentials JSON to the gitignored path, runs the authorize command (built in
Part B's cmd/agent; interim: a 5-line scratch main calling
`gmail.Authorize`), then a scratch `Search(ctx, "newer_than:1d")` against the
real API — the first live proof of the request shapes.

## Self-review notes

- Spec coverage: pkg/gmail interface matches the spec's component section
  exactly (message granularity, SendToSelf, EnsureLabel/Add/RemoveLabel);
  spec's triage needs attachments + comment-marker reads → Tasks 1–2.
- The `unmatched → processed` label ordering, comment markers, and tier
  logic are recruiter domain logic — Part B, not here.
- Types used in later tasks match earlier definitions (`Label`, `MessageRef`,
  `Message`, `Attachment`, `Comment` all defined before first use).
```
