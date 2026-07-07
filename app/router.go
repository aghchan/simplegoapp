package app

import (
	"fmt"
	"reflect"

	"github.com/aghchan/simplegoapp/pkg/http"
	"github.com/aghchan/simplegoapp/pkg/logger"
	"github.com/gorilla/mux"
)

const (
	Socket string = "SOCKET"
)

type HealthController struct {
	http.Controller
}

func (this HealthController) GET(w http.ResponseWriter, req *http.Request) {
}

func newRouter(
	log logger.Logger,
	singletons map[reflect.Type]reflect.Value,
	pathWithControllers []interface{},
) *mux.Router {
	if len(pathWithControllers)%2 != 0 {
		panic("mismatching paths and controllers")
	}

	pathWithControllers = append(pathWithControllers, "/health", &HealthController{})

	addImbeddedStructs(log, singletons)
	router := mux.NewRouter()

	for i := 0; i < len(pathWithControllers); i += 2 {
		path := pathWithControllers[i].(string)
		controller := reflect.ValueOf(pathWithControllers[i+1]).Elem()
		isController := false

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

		for i := 0; i < controller.NumMethod(); i++ {
			method := controller.Type().Method(i)
			name := method.Name
			isSocket := Socket == name

			if ok := http.Verbs[name]; !ok && !isSocket {
				continue
			}

			route := router.
				HandleFunc(
					path,
					controller.Method(i).Interface().(func(http.ResponseWriter, *http.Request)),
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
