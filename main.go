package main

import (
	"fmt"
	"net/http"
	"simplegoapp/app"
	"time"

	"go.uber.org/zap"
)

func main() {
	// helloService := NewHelloService()
	// dependendentService := NewDependentService(helloService)

	routes := []interface{}{
		"/hello", &HelloController{},
	}

	app := app.NewApp(
		8080,
		routes,
		NewHelloService,
		NewDependentService,
	)

	app.Run()
}

type HelloController struct {
	HelloService HelloService
}

func (this HelloController) GET(w http.ResponseWriter, req *http.Request) {
	this.HelloService.Hello()
}

type HelloService interface {
	Hello()
}

type helloService struct {
	logger *zap.SugaredLogger
}

func (this helloService) Hello() {
	fmt.Println("hello")
	time.Sleep(15 * time.Second)
}

func NewHelloService(
	logger *zap.SugaredLogger,
) HelloService {
	return &helloService{
		logger: logger,
	}
}

func NewDependentService(
	logger *zap.SugaredLogger,
	helloService HelloService,
) DependentService {
	return &dependendentService{
		logger:       logger,
		helloService: helloService,
	}
}

type DependentService interface {
	Yes()
}

type dependendentService struct {
	logger *zap.SugaredLogger

	helloService HelloService
}

func (this dependendentService) Yes() {
	this.helloService.Hello()
}
