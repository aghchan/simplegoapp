package app

import (
	"io/ioutil"
	"net/http"
	"reflect"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	"go.uber.org/zap"
	"gopkg.in/yaml.v3"
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

// creates instance of app with singletons of services and initializes router
//
// sets value of config struct
func NewApp(host string, port int, config interface{}, routes, serviceFuncs []interface{}) app {
	logger := newLogger()
	singletonsByName := make(map[string]reflect.Value)
	servicesToInit := make(map[int]interface{})

	for i, serviceFunc := range serviceFuncs {
		servicesToInit[i] = serviceFunc
	}

	attempts := 0
	for {
		if len(servicesToInit) == 0 {
			break
		}
		if attempts >= len(serviceFuncs) {
			panic("failed to initialize singletons")
		}

		for i, serviceFunc := range servicesToInit {
			params := []reflect.Value{}
			serviceFuncType := reflect.TypeOf(serviceFunc)
			foundParams := true

			for i := 0; i < serviceFuncType.NumIn(); i++ {
				field := serviceFuncType.In(i)

				var param reflect.Value
				if field == reflect.TypeOf(logger) {
					param = reflect.ValueOf(logger)
				} else {
					if _, ok := singletonsByName[field.Name()]; !ok {
						foundParams = false

						break
					}

					param = singletonsByName[field.Name()]
				}

				params = append(params, param)
			}

			if !foundParams {
				continue
			}

			service := reflect.ValueOf(serviceFunc).Call(params)
			singletonsByName[service[0].Type().Name()] = service[0].Elem()
			delete(servicesToInit, i)
		}

		attempts++
	}

	f, err := ioutil.ReadFile("config.yml")
	if err != nil {
		panic("loading config file: " + err.Error())
	}

	err = yaml.Unmarshal(f, config)
	if err != nil {
		panic("unmarshaling config file: " + err.Error())
	}

	app := &App{
		logger: logger,
		host:   host,
		port:   port,
		router: newRouter(logger, singletonsByName, routes),
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
