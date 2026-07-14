package app

import (
	"fmt"
	nethttp "net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/aghchan/simplegoapp/pkg/http"
	"github.com/aghchan/simplegoapp/pkg/logger"
)

type routerAlphaController struct {
	http.Controller

	Log logger.Logger
	Svc alpha
}

func (this routerAlphaController) GET(w http.ResponseWriter, req *http.Request) {}

func TestNewRouterInjectsControllerFields(t *testing.T) {
	singletons := map[reflect.Type]reflect.Value{
		typeOf[alpha](): reflect.ValueOf(&alphaImpl{}),
	}

	ctrl := &routerAlphaController{}
	newRouter(
		logger.NewService(),
		singletons,
		[]interface{}{"/a", ctrl},
	)

	if ctrl.Svc == nil {
		t.Fatal("controller service field was not injected")
	}
	if ctrl.Logger == nil {
		t.Fatal("embedded http.Controller was not injected with the logger")
	}
	if ctrl.Log == nil {
		t.Fatal("direct logger field was not injected")
	}
}

func TestNewRouterMissingProviderNamesFieldAndController(t *testing.T) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("expected panic for missing provider, got none")
		}

		msg := fmt.Sprintf("%v", recovered)
		if !strings.Contains(msg, "Svc") || !strings.Contains(msg, "routerAlphaController") {
			t.Fatalf("panic should name the field and controller, got: %v", msg)
		}
	}()

	newRouter(
		logger.NewService(),
		map[reflect.Type]reflect.Value{},
		[]interface{}{"/a", &routerAlphaController{}},
	)
}

type specController struct {
	http.Controller

	Svc alpha
}

func (this *specController) handle(w nethttp.ResponseWriter, r *nethttp.Request) {
	if this.Svc == nil {
		w.WriteHeader(500)
		return
	}
	w.WriteHeader(204)
}

func TestSpecRouteInjectsAndMounts(t *testing.T) {
	singletons := map[reflect.Type]reflect.Value{
		typeOf[alpha](): reflect.ValueOf(&alphaImpl{}),
	}

	ctrl := &specController{}
	router := newRouter(
		logger.NewService(),
		singletons,
		[]interface{}{
			Spec(ctrl, func(r *Router) {
				r.HandleFunc("/v1/things", ctrl.handle).Methods("GET")
			}),
		},
	)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/v1/things", nil))
	if w.Code != 204 {
		t.Fatalf("expected injected controller to serve 204, got %d", w.Code)
	}
}

func TestRouterPanicsClearlyOnDanglingPath(t *testing.T) {
	defer func() {
		msg := fmt.Sprintf("%v", recover())
		if !strings.Contains(msg, "route registration") {
			t.Fatalf("expected named panic, got: %v", msg)
		}
	}()

	newRouter(logger.NewService(),
		map[reflect.Type]reflect.Value{
			typeOf[alpha](): reflect.ValueOf(&alphaImpl{}),
		},
		[]interface{}{"/a", &routerAlphaController{}, "/orphan"})
	t.Fatal("expected panic")
}

func TestSpecPanicsOnNilArguments(t *testing.T) {
	defer func() {
		msg := fmt.Sprintf("%v", recover())
		if !strings.Contains(msg, "app.Spec requires") {
			t.Fatalf("expected named panic, got: %v", msg)
		}
	}()

	Spec(nil, nil)
	t.Fatal("expected panic")
}

func TestSpecPanicsOnTypedNilController(t *testing.T) {
	defer func() {
		msg := fmt.Sprintf("%v", recover())
		if !strings.Contains(msg, "app.Spec requires") {
			t.Fatalf("expected named panic, got: %v", msg)
		}
	}()

	Spec((*specController)(nil), func(r *Router) {})
	t.Fatal("expected panic")
}

func TestRouterMissesReturnProblems(t *testing.T) {
	singletons := map[reflect.Type]reflect.Value{
		typeOf[alpha](): reflect.ValueOf(&alphaImpl{}),
	}
	router := newRouter(logger.NewService(), singletons,
		[]interface{}{"/a", &routerAlphaController{}})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/nope", nil))
	if w.Code != 404 || w.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("route miss: expected 404 problem, got %d %q", w.Code, w.Header().Get("Content-Type"))
	}

	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("DELETE", "/a", nil))
	if w.Code != 405 || w.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("wrong method: expected 405 problem, got %d %q", w.Code, w.Header().Get("Content-Type"))
	}
}
