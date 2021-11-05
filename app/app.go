package app

import (
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	"go.uber.org/zap"
)

type app interface {
	Run()
}

type App struct {
	port       int
	router     *mux.Router
	singletons map[string]reflect.Value
}

func Invoke(fn interface{}, args ...string) {
	v := reflect.ValueOf(fn)
	rargs := make([]reflect.Value, len(args))
	for i, a := range args {
		rargs[i] = reflect.ValueOf(a)
	}
	v.Call(rargs)
}

func NewApp(port int, routes []interface{}, serviceFuncs ...interface{}) app {
	logger := NewLogger()
	singletonsByName := make(map[string]reflect.Value)

	for _, serviceFunc := range serviceFuncs {
		params := []reflect.Value{}
		serviceFuncType := reflect.TypeOf(serviceFunc)

		for i := 0; i < serviceFuncType.NumIn(); i++ {
			field := serviceFuncType.In(i)

			var param reflect.Value
			if field == reflect.TypeOf(logger) {
				param = reflect.ValueOf(logger)
			} else {
				param = singletonsByName[field.Name()]
			}

			params = append(params, param)
		}

		service := reflect.ValueOf(serviceFunc).Call(params)
		ptr := service[0].Convert(service[0].Type()).Elem()

		singletonsByName[service[0].Type().Name()] = ptr
	}

	fmt.Println("I'm A LEGEND")

	app := &App{
		port:       port,
		singletons: singletonsByName,
	}

	router, err := app.newRouter(
		routes,
	)
	if err != nil {
		panic(err)
	}

	app.router = router.Router
	// get router and get controller names from service map
	// for path, controller := range router.controllerByPath {
	// 	http.HandleFunc(path, singletonsByName[controller])

	// }

	return app
}

func NewLogger() *zap.SugaredLogger {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	return logger.Sugar()
}

func (this *App) Run() {
	server := &http.Server{
		Handler:      this.router,
		Addr:         "127.0.0.1:" + strconv.Itoa(this.port),
		WriteTimeout: 15 * time.Second,
		ReadTimeout:  15 * time.Second,
	}

	server.ListenAndServe()
}

func (this *App) newRouter(pathWithControllers []interface{}) (Router, error) {
	if len(pathWithControllers)%2 != 0 {
		return Router{}, errors.New("Mismatching paths and controllers")
	}

	router := mux.NewRouter()
	//	endpointByPath := make(map[string]string)

	for i := 0; i < len(pathWithControllers); i += 2 {
		path := pathWithControllers[i].(string)
		c := pathWithControllers[i+1]
		controller := reflect.ValueOf(c).Elem()
		isController := false

		fmt.Println("controller: ", controller)

		for i := 0; i < controller.NumField(); i++ {
			field := controller.FieldByIndex([]int{i})
			fmt.Println("field: ", field, field.Type(), this.singletons[field.Type().Name()].Type())

			//	rf := reflect.New(field.Type)
			fmt.Println("what dis: ", this.singletons[field.Type().Name()].Kind())
			//	rf.Elem().Set(reflect.ValueOf(field))

			fmt.Println("can set: ", field.CanSet(), field.Type())
			field.Set(this.singletons[field.Type().Name()].Elem()) // .Elem().Set(reflect.New(field.Type))

			// fmt.Println("hat this: ", field.Name, reflect.ValueOf(field), reflect.ValueOf(this.singletons[field.Name]))
			// rf.Elem().Set(reflect.ValueOf(this.singletons[field.Name]))

			//	reflect.ValueOf(this.singletons[field.Name]).Elem().FieldByName("Field").Set(rf)
			//	reflect.ValueOf(field).Elem().Set(reflect.ValueOf(this.singletons[field.Name]))

			// reflect.ValueOf(controller).Set(reflect.ValueOf(this.singletons[field.Name]))
		}

		fmt.Println("controller after: ", controller, controller.Type(), controller.NumMethod())

		for i := 0; i < controller.NumMethod(); i++ {
			method := controller.Type().Method(i)
			name := method.Name

			// if ok := httpVerbs[name]; !ok {
			// 	continue
			// }

			// "Index",
			// "GET",
			// "/",
			// Index, reflect.ValueOf(f).MethodByName(name).Call(nil)
		//	f := reflect.ValueOf(controller).MethodByName(name)
			router.
				HandleFunc(path, method.Func.Interface().(func(http.ResponseWriter, *http.Request))).
				//		HandleFunc(path, http.HandlerFunc(f.Call(nil))).
				Methods(name)
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
