package app

import (
	"fmt"
	nethttp "net/http"
	"reflect"

	"github.com/aghchan/simplegoapp/pkg/http"
	"github.com/aghchan/simplegoapp/pkg/http/apierror"
	"github.com/aghchan/simplegoapp/pkg/logger"
	"github.com/gorilla/mux"
)

const (
	Socket string = "SOCKET"
)

type Router = mux.Router

type specRoute struct {
	controller interface{}
	mount      func(router *Router)
}

// Spec registers a generated-API controller: fields are injected, then mount
// attaches the generated routes.
func Spec(controller interface{}, mount func(router *Router)) interface{} {
	v := reflect.ValueOf(controller)
	if mount == nil || v.Kind() != reflect.Ptr || v.IsNil() {
		panic("app.Spec requires a non-nil controller pointer and mount")
	}
	return specRoute{controller: controller, mount: mount}
}

type HealthController struct {
	http.Controller
}

func (this HealthController) GET(w http.ResponseWriter, req *http.Request) {
}

func injectFields(log logger.Logger, singletons map[reflect.Type]reflect.Value, controller reflect.Value) {
	for i := 0; i < controller.NumField(); i++ {
		field := controller.Field(i)
		fieldName := controller.Type().Field(i).Name

		var param reflect.Value
		if field.Type() == reflect.TypeOf(new(logger.Logger)).Elem() {
			param = reflect.ValueOf(log)
		} else {
			singleton, ok := singletons[field.Type()]
			if !ok {
				panic(fmt.Sprintf(
					"no provider for field %s (%s) of controller %s",
					fieldName, field.Type(), controller.Type(),
				))
			}

			param = singleton
		}

		if !param.Type().AssignableTo(field.Type()) && param.Kind() == reflect.Ptr {
			param = param.Elem()
		}
		if !param.Type().AssignableTo(field.Type()) {
			panic(fmt.Sprintf(
				"provider %s is not assignable to field %s of controller %s",
				param.Type(), fieldName, controller.Type(),
			))
		}

		field.Set(param)
	}
}

func newRouter(
	log logger.Logger,
	singletons map[reflect.Type]reflect.Value,
	pathWithControllers []interface{},
) *mux.Router {
	pathWithControllers = append(pathWithControllers, "/health", &HealthController{})

	addImbeddedStructs(log, singletons)
	router := mux.NewRouter()
	router.NotFoundHandler = nethttp.HandlerFunc(func(w nethttp.ResponseWriter, r *nethttp.Request) {
		apierror.Write(w, r, apierror.NotFound("no such route"))
	})
	router.MethodNotAllowedHandler = nethttp.HandlerFunc(func(w nethttp.ResponseWriter, r *nethttp.Request) {
		apierror.Write(w, r, apierror.MethodNotAllowed())
	})

	for i := 0; i < len(pathWithControllers); {
		if spec, ok := pathWithControllers[i].(specRoute); ok {
			injectFields(log, singletons, reflect.ValueOf(spec.controller).Elem())
			spec.mount(router)
			i++
			continue
		}

		path, ok := pathWithControllers[i].(string)
		if !ok {
			panic(fmt.Sprintf(
				"route registration: expected path string at position %d, got %T",
				i, pathWithControllers[i],
			))
		}
		if i+1 >= len(pathWithControllers) {
			panic("route registration: path " + path + " has no controller")
		}
		ctrl := pathWithControllers[i+1]
		if ctrl == nil || reflect.ValueOf(ctrl).Kind() != reflect.Ptr {
			panic(fmt.Sprintf(
				"route registration: expected controller pointer after %s, got %T",
				path, ctrl,
			))
		}
		controller := reflect.ValueOf(ctrl).Elem()
		i += 2
		isController := false

		injectFields(log, singletons, controller)

		for m := 0; m < controller.NumMethod(); m++ {
			method := controller.Type().Method(m)
			name := method.Name
			isSocket := Socket == name

			if ok := http.Verbs[name]; !ok && !isSocket {
				continue
			}

			route := router.
				HandleFunc(
					path,
					controller.Method(m).Interface().(func(http.ResponseWriter, *http.Request)),
				)
			log.Info("route: ", "path", path, "method", name)

			if !isSocket {
				route.Methods(name)
			}

			isController = true
		}

		if !isController {
			panic("invalid controller, missing http verb handler")
		}
	}

	return router
}

func addImbeddedStructs(logger logger.Logger, singletonsByType map[reflect.Type]reflect.Value) {
	imbeddedStructs := []interface{}{
		&http.Controller{Logger: logger},
	}

	for _, imbeddedStruct := range imbeddedStructs {
		singletonsByType[reflect.TypeOf(imbeddedStruct).Elem()] = reflect.ValueOf(imbeddedStruct)
	}
}
