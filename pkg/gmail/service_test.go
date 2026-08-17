package gmail

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/oauth2"

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

func TestEnsureLabelReturnsExistingByName(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/gmail/v1/users/me/labels"] = func(r *http.Request) (int, string) {
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
	fake.handle["/gmail/v1/users/me/labels"] = func(r *http.Request) (int, string) {
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

// Two concurrent instances may race create-if-absent during a deploy
// overlap; the loser must recover the winner's label, not error.
func TestEnsureLabelRecoversFromCreateConflict(t *testing.T) {
	fake := newFakeGmail(t)
	listCalls := 0
	fake.handle["/gmail/v1/users/me/labels"] = func(r *http.Request) (int, string) {
		if r.Method == http.MethodPost {
			return 409, `{"error":{"code":409,"message":"Label name exists or conflicts"}}`
		}
		listCalls++
		if listCalls == 1 {
			return 200, `{"labels":[]}`
		}
		return 200, `{"labels":[{"id":"Label_7","name":"recruiter-processed"}]}`
	}

	label, err := newTestService(t, fake).EnsureLabel(context.Background(), "recruiter-processed")
	if err != nil {
		t.Fatalf("ensure after conflict: %v", err)
	}
	if label.Id != "Label_7" {
		t.Fatalf("did not recover the winner: %+v", label)
	}
}

func TestAddLabelSendsModify(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/gmail/v1/users/me/messages/m1/modify"] = func(r *http.Request) (int, string) {
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

func TestSendToSelfAddressesTheAuthenticatedUserOnly(t *testing.T) {
	fake := newFakeGmail(t)
	profileCalls := 0
	fake.handle["/gmail/v1/users/me/profile"] = func(r *http.Request) (int, string) {
		profileCalls++
		return 200, `{"emailAddress":"alan@example.com"}`
	}
	fake.handle["/gmail/v1/users/me/messages/send"] = func(r *http.Request) (int, string) {
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
	if !strings.Contains(message, "Content-Type: text/plain; charset=utf-8\r\n") {
		t.Fatalf("wrong content type:\n%s", message)
	}
}

// A subject carrying CRLF must not become extra RFC822 headers — that would
// defeat the no-third-party guarantee SendToSelf exists to provide.
func TestSendToSelfNeutralizesHeaderInjection(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/gmail/v1/users/me/profile"] = func(r *http.Request) (int, string) {
		return 200, `{"emailAddress":"alan@example.com"}`
	}
	fake.handle["/gmail/v1/users/me/messages/send"] = func(r *http.Request) (int, string) {
		return 200, `{"id":"sent-1"}`
	}

	err := newTestService(t, fake).SendToSelf(context.Background(),
		"Re: offer\r\nBcc: attacker@evil.com", "body")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	last := fake.bodies[len(fake.bodies)-1]
	raw, _ := base64.URLEncoding.WithPadding(base64.NoPadding).DecodeString(last["raw"].(string))
	headers := strings.SplitN(string(raw), "\r\n\r\n", 2)[0]
	if strings.Contains(headers, "Bcc") {
		t.Fatalf("injected header survived:\n%s", headers)
	}
	if !strings.Contains(headers, "Subject: Re: offer Bcc: attacker@evil.com") &&
		!strings.Contains(headers, "Subject: Re: offer") {
		t.Fatalf("subject lost entirely:\n%s", headers)
	}
}

func TestSendHTMLToSelfSetsHTMLContentType(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/gmail/v1/users/me/profile"] = func(r *http.Request) (int, string) {
		return 200, `{"emailAddress":"alan@example.com"}`
	}
	fake.handle["/gmail/v1/users/me/messages/send"] = func(r *http.Request) (int, string) {
		return 200, `{"id":"sent-1"}`
	}

	err := newTestService(t, fake).SendHTMLToSelf(context.Background(),
		"Recruiter brief", "<div>hello</div>")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	last := fake.bodies[len(fake.bodies)-1]
	raw, _ := base64.URLEncoding.WithPadding(base64.NoPadding).DecodeString(last["raw"].(string))
	message := string(raw)
	if !strings.Contains(message, "Content-Type: text/html; charset=utf-8\r\n") {
		t.Fatalf("wrong content type:\n%s", message)
	}
	if !strings.Contains(message, "<div>hello</div>") {
		t.Fatalf("body lost:\n%s", message)
	}
}

// SendHTMLToSelf shares the send() helper with SendToSelf, so the header-
// injection guard applies here too — this test proves the shared path, not
// a separate implementation that could drift.
func TestSendHTMLToSelfNeutralizesHeaderInjection(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/gmail/v1/users/me/profile"] = func(r *http.Request) (int, string) {
		return 200, `{"emailAddress":"alan@example.com"}`
	}
	fake.handle["/gmail/v1/users/me/messages/send"] = func(r *http.Request) (int, string) {
		return 200, `{"id":"sent-1"}`
	}

	err := newTestService(t, fake).SendHTMLToSelf(context.Background(),
		"Brief\r\nBcc: attacker@evil.com", "<div>hi</div>")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	last := fake.bodies[len(fake.bodies)-1]
	raw, _ := base64.URLEncoding.WithPadding(base64.NoPadding).DecodeString(last["raw"].(string))
	headers := strings.SplitN(string(raw), "\r\n\r\n", 2)[0]
	if strings.Contains(headers, "Bcc") {
		t.Fatalf("injected header survived:\n%s", headers)
	}
}

// RemoveLabel must send removeLabelIds — a transposed copy of AddLabel would
// pass every other test in this file.
func TestRemoveLabelSendsModify(t *testing.T) {
	fake := newFakeGmail(t)
	fake.handle["/gmail/v1/users/me/messages/m1/modify"] = func(r *http.Request) (int, string) {
		return 200, `{"id":"m1"}`
	}

	if err := newTestService(t, fake).RemoveLabel(context.Background(), "m1", "Label_7"); err != nil {
		t.Fatalf("remove label: %v", err)
	}

	last := fake.bodies[len(fake.bodies)-1]
	removed, _ := last["removeLabelIds"].([]interface{})
	if len(removed) != 1 || removed[0] != "Label_7" {
		t.Fatalf("modify body wrong: %+v", last)
	}
	if _, present := last["addLabelIds"]; present {
		t.Fatalf("addLabelIds must not be present: %+v", last)
	}
}

func TestClassifyErrMapsInvalidGrant(t *testing.T) {
	retrieve := &oauth2.RetrieveError{ErrorCode: "invalid_grant"}
	wrapped := &url.Error{Op: "Get", URL: "https://gmail.googleapis.com", Err: retrieve}

	if err := classifyErr(wrapped); !errors.Is(err, ErrAuthExpired) {
		t.Fatalf("got %v, want ErrAuthExpired", err)
	}
	if err := classifyErr(errors.New("plain")); errors.Is(err, ErrAuthExpired) {
		t.Fatalf("plain errors must pass through unclassified")
	}
	if err := classifyErr(nil); err != nil {
		t.Fatalf("nil must stay nil, got %v", err)
	}
}
