package linear

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type recordedCall struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables"`
}

// newTestService stands up a fake GraphQL endpoint. respond returns the body
// for each call; the recorded calls let tests assert what was sent.
func newTestService(t *testing.T, respond func(call recordedCall) string) (Service, *[]recordedCall) {
	t.Helper()

	calls := &[]recordedCall{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "lin_api_test" {
			t.Errorf("Authorization header %q, want the raw key with no prefix", got)
		}

		body, _ := io.ReadAll(r.Body)
		var call recordedCall
		json.Unmarshal(body, &call)
		*calls = append(*calls, call)

		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, respond(call))
	}))
	t.Cleanup(server.Close)

	service := NewService(
		map[string]interface{}{
			"linear_api_key":  "lin_api_test",
			"linear_team_id":  "team-1",
			"linear_base_url": server.URL,
		},
		logger.NewService(),
	)

	return service, calls
}

const statesPayload = `{"data":{"team":{"states":{"nodes":[
	{"id":"state-saved","name":"Saved"},
	{"id":"state-applied","name":"Applied"}
]}}}}`

func isStatesQuery(call recordedCall) bool {
	return strings.Contains(call.Query, "states {")
}

func TestCreateIssueResolvesStateByName(t *testing.T) {
	service, calls := newTestService(t, func(call recordedCall) string {
		if isStatesQuery(call) {
			return statesPayload
		}

		return `{"data":{"issueCreate":{"success":true,"issue":{
			"id":"issue-1","identifier":"JOB-1","title":"Acme — SRE","description":"",
			"dueDate":"2026-09-01","createdAt":"2026-08-14T00:00:00.000Z",
			"updatedAt":"2026-08-14T00:00:00.000Z","state":{"name":"Applied"},"project":null}}}}`
	})

	due := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	issue, err := service.CreateIssue(context.Background(), IssueInput{
		Title: "Acme — SRE", State: "applied", DueDate: &due,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if issue.Id != "issue-1" || issue.State != "Applied" {
		t.Fatalf("unexpected issue: %+v", issue)
	}
	if issue.DueDate == nil || !issue.DueDate.Equal(due) {
		t.Fatalf("due date %v, want %v", issue.DueDate, due)
	}

	create := (*calls)[len(*calls)-1]
	input := create.Variables["input"].(map[string]interface{})
	if input["stateId"] != "state-applied" {
		t.Fatalf("stateId %v, want the id looked up by name", input["stateId"])
	}
	// TimelessDate, not RFC3339
	if input["dueDate"] != "2026-09-01" {
		t.Fatalf("dueDate %v", input["dueDate"])
	}
	if input["teamId"] != "team-1" {
		t.Fatalf("teamId %v", input["teamId"])
	}
}

func TestUnknownStateIsASetupError(t *testing.T) {
	service, _ := newTestService(t, func(call recordedCall) string { return statesPayload })

	_, err := service.CreateIssue(context.Background(), IssueInput{Title: "x", State: "interview"})
	if !errors.Is(err, ErrUnorganized) {
		t.Fatalf("got %v, want ErrUnorganized", err)
	}
	if !strings.Contains(err.Error(), "interview") {
		t.Fatalf("error should name the missing state: %v", err)
	}
}

func TestStatesAreCachedAcrossCalls(t *testing.T) {
	var stateQueries int32
	service, _ := newTestService(t, func(call recordedCall) string {
		if isStatesQuery(call) {
			atomic.AddInt32(&stateQueries, 1)

			return statesPayload
		}

		return `{"data":{"issueCreate":{"success":true,"issue":{"id":"i","state":{"name":"Saved"}}}}}`
	})

	for range 3 {
		if _, err := service.CreateIssue(context.Background(), IssueInput{Title: "x", State: "saved"}); err != nil {
			t.Fatal(err)
		}
	}

	if got := atomic.LoadInt32(&stateQueries); got != 1 {
		t.Fatalf("workflow states fetched %d times, want 1", got)
	}
}

// setup relies on Teams working before a team id is configured
func TestTeamsWorksWithoutAConfiguredTeam(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"data":{"teams":{"nodes":[
			{"id":"team-1","key":"JOB","name":"Job search"}]}}}`)
	}))
	t.Cleanup(server.Close)

	service := NewService(map[string]interface{}{
		"linear_api_key": "k", "linear_team_id": "", "linear_base_url": server.URL,
	}, logger.NewService())

	teams, err := service.Teams(context.Background())
	if err != nil {
		t.Fatalf("teams: %v", err)
	}
	if len(teams) != 1 || teams[0].Id != "team-1" || teams[0].Key != "JOB" {
		t.Fatalf("unexpected teams: %+v", teams)
	}
}

func TestIssueNotFoundOnNullNode(t *testing.T) {
	service, _ := newTestService(t, func(call recordedCall) string {
		return `{"data":{"issue":null}}`
	})

	_, err := service.Issue(context.Background(), "missing")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

func TestIssueNotFoundOnEntityError(t *testing.T) {
	service, _ := newTestService(t, func(call recordedCall) string {
		return `{"errors":[{"message":"Entity not found"}]}`
	})

	_, err := service.Issue(context.Background(), "missing")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

func TestGraphqlErrorsSurfaceInsteadOfSilentSuccess(t *testing.T) {
	service, _ := newTestService(t, func(call recordedCall) string {
		return `{"errors":[{"message":"Access denied"}]}`
	})

	_, err := service.Issue(context.Background(), "x")
	if err == nil || !strings.Contains(err.Error(), "Access denied") {
		t.Fatalf("got %v, want the graphql error surfaced", err)
	}
}

func TestIssuesPaginationAndFilter(t *testing.T) {
	service, calls := newTestService(t, func(call recordedCall) string {
		return `{"data":{"team":{"issues":{
			"nodes":[{"id":"a","title":"Acme — SRE","state":{"name":"Applied"}}],
			"pageInfo":{"hasNextPage":true,"endCursor":"cursor-2"}}}}}`
	})

	page, err := service.Issues(context.Background(), IssueQuery{State: "applied", Limit: 5, Cursor: "cursor-1"})
	if err != nil {
		t.Fatalf("issues: %v", err)
	}
	if len(page.Issues) != 1 || page.NextCursor != "cursor-2" {
		t.Fatalf("unexpected page: %+v", page)
	}

	sent := (*calls)[0]
	if sent.Variables["after"] != "cursor-1" || sent.Variables["first"] != float64(5) {
		t.Fatalf("pagination not forwarded: %+v", sent.Variables)
	}
	filter := sent.Variables["filter"].(map[string]interface{})
	state := filter["state"].(map[string]interface{})["name"].(map[string]interface{})
	if state["eqIgnoreCase"] != "applied" {
		t.Fatalf("filter not forwarded: %+v", filter)
	}
}

// no next page must mean no cursor, or paging never terminates
func TestIssuesLastPageHasNoCursor(t *testing.T) {
	service, _ := newTestService(t, func(call recordedCall) string {
		return `{"data":{"team":{"issues":{"nodes":[],
			"pageInfo":{"hasNextPage":false,"endCursor":"ignored"}}}}}`
	})

	page, err := service.Issues(context.Background(), IssueQuery{Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor != "" {
		t.Fatalf("cursor %q on last page", page.NextCursor)
	}
}

func TestRateLimitIsTyped(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	t.Cleanup(server.Close)

	service := NewService(map[string]interface{}{
		"linear_api_key": "k", "linear_team_id": "t", "linear_base_url": server.URL,
	}, logger.NewService())

	_, err := service.Issue(context.Background(), "x")
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("got %v, want ErrRateLimited", err)
	}
}

func TestEmptyPatchSkipsTheMutation(t *testing.T) {
	service, calls := newTestService(t, func(call recordedCall) string {
		return `{"data":{"issue":{"id":"issue-1","state":{"name":"Saved"}}}}`
	})

	if _, err := service.UpdateIssue(context.Background(), "issue-1", IssuePatch{}); err != nil {
		t.Fatal(err)
	}

	for _, call := range *calls {
		if strings.Contains(call.Query, "issueUpdate") {
			t.Fatal("empty patch should not send an update mutation")
		}
	}
}

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

func TestAttachURLNotFoundOnEntityError(t *testing.T) {
	service, _ := newTestService(t, func(call recordedCall) string {
		return `{"errors":[{"message":"Entity not found"}]}`
	})

	err := service.AttachURL(context.Background(), "gone", "https://example.com", "t")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}
