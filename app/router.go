package app

import (
	"errors"
	"net/http"
	"reflect"

	"github.com/gorilla/mux"
)

type Router struct {
	// ("/sample", controller)
	*mux.Router

	//	controllerByPath map[string]string
}

type HttpVerb string

const (
	HttpVerb_Get    = "GET"
	HttpVerb_Post   = "POST"
	HttpVerb_Put    = "PUT"
	HttpVerb_Delete = "DELETE"
)

var httpVerbs = map[string]bool{
	HttpVerb_Get:    true,
	HttpVerb_Post:   true,
	HttpVerb_Put:    true,
	HttpVerb_Delete: true,
}

func NewRouter(pathWithControllers []interface{}) (Router, error) {
	if len(pathWithControllers)%2 != 0 {
		return Router{}, errors.New("Mismatching paths and controllers")
	}

	router := mux.NewRouter()
	//	endpointByPath := make(map[string]string)

	for i := 0; i < len(pathWithControllers); i += 2 {
		path := pathWithControllers[i].(string)
		controller := pathWithControllers[i+1]

		isController := false

		controllerType := reflect.TypeOf(controller)
		for i := 0; i < controllerType.NumMethod(); i++ {
			method := controllerType.Method(i)

			if ok := httpVerbs[method.Name]; !ok {
				continue
			}

			// "Index",
			// "GET",
			// "/",
			// Index, reflect.ValueOf(f).MethodByName(name).Call(nil)
			f := reflect.ValueOf(controller).MethodByName(method.Name)
			router.
				HandleFunc(path, f.Interface().(func(http.ResponseWriter, *http.Request))).
				//		HandleFunc(path, http.HandlerFunc(f.Call(nil))).
				Methods(method.Name)
			// Path(method.Name).
			// Name(path).
			//		Handl
			//	Handler(f.Interface().(func(http.ResponseWriter, *http.Request)))
			isController = true
		}

		if !isController {
			return Router{}, errors.New("Invalid controller, missing http verb handler")
		}

		// if t := reflect.TypeOf(controller); t.Kind() == reflect.Ptr {
		// 	endpointByPath[path] = t.Elem().Name()
		// } else {
		// 	endpointByPath[path] = t.Name()
		// }
	}

	return Router{
		Router: router,
		//	controllerByPath: endpointByPath,
	}, nil
}
