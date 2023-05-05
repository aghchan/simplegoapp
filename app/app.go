package app

import (
	"io/ioutil"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	"gopkg.in/yaml.v3"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"github.com/aghchan/simplegoapp/pkg/postgres"
)

type app interface {
	Run()
}

type App struct {
	host     string
	port     int
	logger   logger.Logger
	postgres postgres.Service
	router   *mux.Router
}

// creates instance of app with singletons of services and initializes router
//
// sets value of config struct
func NewApp(
	host string,
	port int,
	routes, serviceFuncs []interface{},
	models []interface{},
	config ...interface{},
) app {
	log := logger.NewService()
	singletonsByName := make(map[string]reflect.Value)
	servicesToInit := make(map[int]interface{})

	for i, serviceFunc := range serviceFuncs {
		servicesToInit[i] = serviceFunc
	}

	configs := make(map[string]interface{})
	if len(config) > 0 {
		config := "config.yml"
		if os.Getenv("ENV") != "PRODUCTION" {
			config = "local.yml"
		}

		f, err := ioutil.ReadFile(config)
		if err != nil {
			panic("loading config file: " + err.Error())
		}

		err = yaml.Unmarshal(f, config[0])
		if err != nil {
			panic("unmarshaling config file: " + err.Error())
		}

		cfg := reflect.ValueOf(config[0]).Elem()
		for i := 0; i < cfg.NumField(); i++ {
			field := cfg.FieldByIndex([]int{i})
			for i := 0; i < field.Type().NumField(); i++ {
				innerField := field.Type().Field(i)
				value := field.Field(i)
				key := innerField.Tag.Get("config")
				env := innerField.Tag.Get("env")
				if env != "" {
					os.Setenv(env, value.Interface().(string))
				}

				configs[key] = value.Interface()
			}
		}
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
				switch field {
				case reflect.TypeOf(new(logger.Logger)).Elem():
					param = reflect.ValueOf(log)
				case reflect.TypeOf(configs):
					param = reflect.ValueOf(configs)
				default:
					if _, ok := singletonsByName[field.String()]; !ok {
						foundParams = false

						break
					}

					param = singletonsByName[field.String()]
				}

				params = append(params, param)
			}

			if !foundParams {
				continue
			}

			service := reflect.ValueOf(serviceFunc).Call(params)
			singletonsByName[service[0].Type().String()] = service[0].Elem()
			delete(servicesToInit, i)
		}

		attempts++
	}

	app := &App{
		logger:   log,
		host:     host,
		port:     port,
		postgres: singletonsByName[reflect.TypeOf(new(postgres.Service)).Elem().String()].Interface().(postgres.Service),
		router:   newRouter(log, singletonsByName, routes),
	}

	app.runMigrations(models)

	return app
}

func (this *App) runMigrations(models []interface{}) {
	this.postgres.RunMigrations(models)
}

func (this *App) Run() {
	server := &http.Server{
		Handler:      this.router,
		Addr:         this.host + ":" + strconv.Itoa(this.port),
		WriteTimeout: 15 * time.Second,
		ReadTimeout:  15 * time.Second,
	}

	this.logger.Info(
		"Started server",
		"host", this.host,
		"port", strconv.Itoa(this.port),
	)
	server.ListenAndServe()
}
