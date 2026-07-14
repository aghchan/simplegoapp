package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apiv1 "github.com/aghchan/simplegoapp/api/v1"
	"github.com/aghchan/simplegoapp/domain/orders"
	pkghttp "github.com/aghchan/simplegoapp/pkg/http"
	"github.com/aghchan/simplegoapp/pkg/logger"
	"github.com/gorilla/mux"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()

	log := logger.NewService()
	ctrl := &OrdersController{
		Controller: pkghttp.Controller{Logger: log},
		Orders:     orders.NewService(log),
	}

	router := mux.NewRouter()
	apiv1.HandlerWithOptions(ctrl, apiv1.GorillaServerOptions{
		BaseURL:          "/v1",
		BaseRouter:       router,
		ErrorHandlerFunc: pkghttp.SpecErrorHandler,
	})

	server := httptest.NewServer(pkghttp.Chain(
		router,
		pkghttp.RequestID,
		pkghttp.Recover(log),
	))
	t.Cleanup(server.Close)

	return server
}

func TestCreateAndGetOrder(t *testing.T) {
	server := newTestServer(t)

	resp, err := http.Post(server.URL+"/v1/orders", "application/json",
		strings.NewReader(`{"sku":"ABC-1","quantity":2}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 201 || resp.Header.Get("Location") == "" ||
		resp.Header.Get("X-Request-Id") == "" {
		t.Fatalf("create: status %d location %q", resp.StatusCode, resp.Header.Get("Location"))
	}

	get, err := http.Get(server.URL + resp.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	if get.StatusCode != 200 {
		t.Fatalf("get after create: %d", get.StatusCode)
	}
}

func TestGetMissingOrderIsProblem(t *testing.T) {
	server := newTestServer(t)

	resp, err := http.Get(server.URL + "/v1/orders/nope")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 ||
		resp.Header.Get("Content-Type") != "application/problem+json" {
		t.Fatalf("expected 404 problem, got %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

func TestInvalidBodyIsProblem(t *testing.T) {
	server := newTestServer(t)

	resp, err := http.Post(server.URL+"/v1/orders", "application/json",
		strings.NewReader(`{"sku":`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestMalformedQueryParamIsProblem(t *testing.T) {
	server := newTestServer(t)

	resp, err := http.Get(server.URL + "/v1/orders?limit=abc")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 ||
		resp.Header.Get("Content-Type") != "application/problem+json" {
		t.Fatalf("expected 400 problem, got %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

func TestListPaginatesAndClampsLimit(t *testing.T) {
	server := newTestServer(t)

	for i := 0; i < 3; i++ {
		resp, err := http.Post(server.URL+"/v1/orders", "application/json",
			strings.NewReader(`{"sku":"X","quantity":1}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}

	resp, err := http.Get(server.URL + "/v1/orders?limit=2")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := make([]byte, 4096)
	n, _ := resp.Body.Read(body)
	if resp.StatusCode != 200 || !strings.Contains(string(body[:n]), "next_cursor") {
		t.Fatalf("expected paginated list, got %d %s", resp.StatusCode, body[:n])
	}

	neg, err := http.Get(server.URL + "/v1/orders?limit=-5")
	if err != nil {
		t.Fatal(err)
	}
	defer neg.Body.Close()
	if neg.StatusCode != 200 {
		t.Fatalf("negative limit should clamp, not fail: %d", neg.StatusCode)
	}
}

func TestListCursorRoundTrip(t *testing.T) {
	server := newTestServer(t)

	for _, sku := range []string{"A", "B", "C"} {
		resp, err := http.Post(server.URL+"/v1/orders", "application/json",
			strings.NewReader(`{"sku":"`+sku+`","quantity":1}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}

	var page1 apiv1.OrderList
	resp, err := http.Get(server.URL + "/v1/orders?limit=2")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(resp.Body).Decode(&page1); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(page1.Items) != 2 || page1.NextCursor == "" {
		t.Fatalf("page 1: got %d items, cursor %q", len(page1.Items), page1.NextCursor)
	}

	var page2 apiv1.OrderList
	resp, err = http.Get(server.URL + "/v1/orders?limit=2&cursor=" + page1.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(resp.Body).Decode(&page2); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(page2.Items) != 1 || page2.NextCursor != "" {
		t.Fatalf("page 2: got %d items, cursor %q", len(page2.Items), page2.NextCursor)
	}
	if page2.Items[0].Id == page1.Items[0].Id || page2.Items[0].Id == page1.Items[1].Id {
		t.Fatal("pages overlap")
	}
}

func TestUnsupportedAcceptIs406(t *testing.T) {
	server := newTestServer(t)

	req, _ := http.NewRequest("GET", server.URL+"/v1/orders", nil)
	req.Header.Set("Accept", "application/cbor")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 406 {
		t.Fatalf("expected 406, got %d", resp.StatusCode)
	}
}
