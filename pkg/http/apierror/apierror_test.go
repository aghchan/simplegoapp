package apierror

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConstructorsMapStatusAndCode(t *testing.T) {
	cases := []struct {
		err    *Error
		status int
		code   string
	}{
		{Invalid("x"), 400, "invalid"},
		{Unauthorized("x"), 401, "unauthorized"},
		{Forbidden("x"), 403, "forbidden"},
		{NotFound("x"), 404, "not_found"},
		{Conflict("x"), 409, "conflict"},
		{UnsupportedMedia("x"), 415, "unsupported_media_type"},
		{NotAcceptable("x"), 406, "not_acceptable"},
		{Timeout(), 504, "timeout"},
		{Internal("x"), 500, "internal"},
		{MethodNotAllowed(), 405, "method_not_allowed"},
	}
	for _, c := range cases {
		if c.err.Status != c.status || c.err.Code != c.code {
			t.Fatalf("got {%d %s}, want {%d %s}", c.err.Status, c.err.Code, c.status, c.code)
		}
	}
}

func TestWriteRendersProblem(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/v1/orders/42", nil)

	Write(w, r, NotFound("order not found"))

	if w.Code != 404 {
		t.Fatalf("status: got %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("content-type: got %q", ct)
	}

	var p map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	if p["title"] != "Not Found" || p["code"] != "not_found" ||
		p["detail"] != "order not found" || p["instance"] != "/v1/orders/42" ||
		p["status"] != float64(404) {
		t.Fatalf("problem fields wrong: %v", p)
	}
}

func TestWriteHidesUnknownErrors(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/x", nil)

	Write(w, r, errors.New("pq: password authentication failed"))

	if w.Code != 500 {
		t.Fatalf("status: got %d, want 500", w.Code)
	}
	if strings.Contains(w.Body.String(), "password") {
		t.Fatalf("internal detail leaked: %s", w.Body.String())
	}
}

func TestWriteUnwrapsWrappedErrors(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/x", nil)

	Write(w, r, fmt.Errorf("handler: %w", Conflict("duplicate name")))

	if w.Code != 409 {
		t.Fatalf("status: got %d, want 409", w.Code)
	}
}
