package app

import (
	"net/http"
	"reflect"

	"github.com/gorilla/mux"
)

func newRouter(singletons map[string]reflect.Value, pathWithControllers []interface{}) *mux.Router {
	if len(pathWithControllers)%2 != 0 {
		panic("mismatching paths and controllers")
	}

	router := mux.NewRouter()
	httpVerbs := map[string]bool{
		http.MethodGet:    true,
		http.MethodPut:    true,
		http.MethodPost:   true,
		http.MethodDelete: true,
	}

	for i := 0; i < len(pathWithControllers); i += 2 {
		path := pathWithControllers[i].(string)
		controller := reflect.ValueOf(pathWithControllers[i+1]).Elem()
		isController := false

		for i := 0; i < controller.NumField(); i++ {
			field := controller.FieldByIndex([]int{i})
			field.Set(singletons[field.Type().Name()].Elem())
		}

		for i := 0; i < controller.NumMethod(); i++ {
			method := controller.Type().Method(i)
			name := method.Name
			if ok := httpVerbs[name]; !ok {
				continue
			}

			router.
				HandleFunc(
					path,
					controller.Method(i).Interface().(func(http.ResponseWriter, *http.Request)),
				).
				Methods(name)
			isController = true
		}

		if !isController {
			panic("invalid controller, missing http verb handler")
		}
	}

	return router
}
