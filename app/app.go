package app

import (
	"net/http"
	"reflect"
	"strconv"
	"time"
)

type app interface {
	Run()
}

type App struct {
	port       int
	router     Router
	singletons map[string]interface{}
}

func NewApp(port int, router Router, services ...interface{}) app {
	singletonsByName := make(map[string]interface{})

	for _, service := range services {
		if t := reflect.TypeOf(service); t.Kind() == reflect.Ptr {
			singletonsByName[t.Elem().Name()] = service
		} else {
			singletonsByName[t.Name()] = service
		}
	}

	// get router and get controller names from service map
	// for path, controller := range router.controllerByPath {
	// 	http.HandleFunc(path, singletonsByName[controller])

	// }

	return &App{
		port:       port,
		singletons: singletonsByName,
		router:     router,
	}
}

func (this *App) Run() {
	rv := &http.Server{
		Handler: this.router.Router,
		Addr:    "127.0.0.1:" + strconv.Itoa(this.port),
		// Good practice: enforce timeouts for servers you create!
		WriteTimeout: 15 * time.Second,
		ReadTimeout:  15 * time.Second,
	}

	rv.ListenAndServe()
	//	http.ListenAndServe(strconv.Itoa(this.port), nil)
	//	select{} // TODO: need alternative blocking op
}
