package app

import (
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
	host   string
	port   int
	logger *zap.SugaredLogger
	router *mux.Router
}

func NewApp(host string, port int, routes []interface{}, serviceFuncs []interface{}) app {
	logger := newLogger()
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
		singletonsByName[service[0].Type().Name()] = service[0].Elem()
	}

	app := &App{
		logger: logger,
		host:   host,
		port:   port,
		router: newRouter(singletonsByName, routes),
	}

	return app
}

func (this *App) Run() {
	server := &http.Server{
		Handler:      this.router,
		Addr:         this.host + ":" + strconv.Itoa(this.port),
		WriteTimeout: 15 * time.Second,
		ReadTimeout:  15 * time.Second,
	}

	this.logger.Info("Started server: " + this.host + ":" + strconv.Itoa(this.port))
	server.ListenAndServe()
}

func newLogger() *zap.SugaredLogger {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	return logger.Sugar()
}
