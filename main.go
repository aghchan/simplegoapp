package main

import (
	"fmt"
	"net/http"
	"simplegoapp/app"
)

func main() {
	helloService := NewHelloService()
	dependendentService := NewDependentService(helloService)

	routes := []interface{}{"/hello", &HelloController{helloService: helloService}}
	router, err := app.NewRouter(
		routes,
	)
	if err != nil {
		panic(err)
	}

	app := app.NewApp(8080, router, helloService, dependendentService)

	app.Run()
}

type HelloController struct {
	helloService HelloService
}

func (this *HelloController) GET(w http.ResponseWriter, req *http.Request) {
	this.helloService.Hello()
}

type HelloService interface {
	Hello()
}

type helloService struct {
}

func (this helloService) Hello() {
	fmt.Println("hello")
}

func NewHelloService() HelloService {
	return &helloService{}
}

func NewDependentService(helloService HelloService) DependentService {
	return &dependendentService{
		helloService: helloService,
	}
}

type DependentService interface {
	Yes()
}

type dependendentService struct {
	helloService HelloService
}

func (this dependendentService) Yes() {
	this.helloService.Hello()
}
