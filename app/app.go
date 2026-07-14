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

	pkghttp "github.com/aghchan/simplegoapp/pkg/http"
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

	configs := make(map[string]interface{})
	if len(config) > 0 {
		configFile := "config.yml"
		if os.Getenv("ENV") != "PRODUCTION" {
			configFile = "local.yml"
		}

		f, err := ioutil.ReadFile(configFile)
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

	builtins := map[reflect.Type]reflect.Value{
		reflect.TypeOf(new(logger.Logger)).Elem(): reflect.ValueOf(log),
		reflect.TypeOf(configs):                   reflect.ValueOf(configs),
	}

	singletons, err := resolve(serviceFuncs, builtins)
	if err != nil {
		panic("initializing services: " + err.Error())
	}

	postgresService, ok := singletons[reflect.TypeOf(new(postgres.Service)).Elem()]
	if !ok {
		panic("postgres.NewService must be included in the service list")
	}

	app := &App{
		logger:   log,
		host:     host,
		port:     port,
		postgres: postgresService.Interface().(postgres.Service),
		router:   newRouter(log, singletons, routes),
	}

	app.runMigrations(models)

	return app
}

func (this *App) runMigrations(models []interface{}) {
	this.postgres.RunMigrations(models)
}

func (this *App) Run() {
	server := &http.Server{
		Handler: pkghttp.Chain(
			this.router,
			pkghttp.RequestID,
			pkghttp.RequestLogger(this.logger),
			pkghttp.Recover(this.logger),
			pkghttp.CORS,
			pkghttp.TimeoutMW(10*time.Second),
			pkghttp.Auth(),
		),
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
