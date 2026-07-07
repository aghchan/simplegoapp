package app

import (
	"fmt"
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
