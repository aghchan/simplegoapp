package controller

import (
	"net/http"
	"simplegoapp/domain/example"
)

type ExampleController struct {
	ExampleService example.ExampleService
}

func (this ExampleController) GET(w http.ResponseWriter, req *http.Request) {
	this.ExampleService.Hello()
}

func (this ExampleController) POST(w http.ResponseWriter, req *http.Request) {
	this.ExampleService.Bye()
}
