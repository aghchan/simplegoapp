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
	fake.handle["/gmail/v1/users/me/messages"] = func(r *http.Request) (int, string) {
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

func TestMessageExtractsPlainTextFromNestedMultipart(t *testing.T) {
	fake := newFakeGmail(t)
	// "hello world" base64url; nested multipart/alternative inside mixed —
	// the shape real ATS mail arrives in.
	fake.handle["/gmail/v1/users/me/messages/m1"] = func(r *http.Request) (int, string) {
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

// Search must stop at its page cap and return what it has, not loop forever.
func TestSearchStopsAtPageCap(t *testing.T) {
	fake := newFakeGmail(t)
	pages := 0
	fake.handle["/gmail/v1/users/me/messages"] = func(r *http.Request) (int, string) {
		pages++
		return 200, `{"messages":[{"id":"m","threadId":"t"}],"nextPageToken":"more"}`
	}

	refs, err := newTestService(t, fake).Search(context.Background(), "q")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if pages != searchPageCap {
		t.Fatalf("made %d page calls, want exactly %d", pages, searchPageCap)
	}
	if len(refs) != searchPageCap {
		t.Fatalf("got %d refs, want %d", len(refs), searchPageCap)
	}
}
