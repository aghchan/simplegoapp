package http

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aghchan/simplegoapp/pkg/http/apierror"
	"github.com/aghchan/simplegoapp/pkg/logger"
)

type payload struct {
	Name string `json:"name"`
}

func testController() Controller {
	return Controller{Logger: logger.NewService()}
}

func TestBindDecodesJSON(t *testing.T) {
	c := testController()
	for _, contentType := range []string{"", "application/json", "application/json; charset=utf-8"} {
		r := httptest.NewRequest("POST", "/x", strings.NewReader(`{"name":"a"}`))
		if contentType != "" {
			r.Header.Set("Content-Type", contentType)
		}

		var p payload
		if err := c.Bind(r, &p); err != nil {
			t.Fatalf("content-type %q: %v", contentType, err)
		}
		if p.Name != "a" {
			t.Fatalf("content-type %q: got %+v", contentType, p)
		}
	}
}

func TestBindRejectsUnsupportedContentType(t *testing.T) {
	c := testController()
	r := httptest.NewRequest("POST", "/x", strings.NewReader("x"))
	r.Header.Set("Content-Type", "application/cbor")

	err := c.Bind(r, &payload{})
	e := &apierror.Error{}
	if !errors.As(err, &e) || e.Status != 415 {
		t.Fatalf("expected 415 apierror, got %v", err)
	}
}

func TestBindRejectsMalformedBody(t *testing.T) {
	c := testController()
	r := httptest.NewRequest("POST", "/x", strings.NewReader(`{"name":`))

	err := c.Bind(r, &payload{})
	e := &apierror.Error{}
	if !errors.As(err, &e) || e.Status != 400 {
		t.Fatalf("expected 400 apierror, got %v", err)
	}
}

func TestRespondNegotiatesAccept(t *testing.T) {
	c := testController()

	for _, accept := range []string{"", "*/*", "application/json", "application/*"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/x", nil)
		if accept != "" {
			r.Header.Set("Accept", accept)
		}

		c.Respond(w, r, 200, payload{Name: "a"})
		if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("accept %q: status %d content-type %q", accept, w.Code, w.Header().Get("Content-Type"))
		}
	}

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("Accept", "application/cbor")
	c.Respond(w, r, 200, payload{Name: "a"})
	if w.Code != 406 || w.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("expected 406 problem, got %d %q", w.Code, w.Header().Get("Content-Type"))
	}
}

func TestRespondNoBodyFor204(t *testing.T) {
	c := testController()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("DELETE", "/x", nil)

	c.Respond(w, r, 204, nil)
	if w.Code != 204 || w.Body.Len() != 0 {
		t.Fatalf("expected empty 204, got %d %q", w.Code, w.Body.String())
	}
}

func TestProblemDelegatesToApierror(t *testing.T) {
	c := testController()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/x", nil)

	c.Problem(w, r, apierror.NotFound("nope"))
	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}
