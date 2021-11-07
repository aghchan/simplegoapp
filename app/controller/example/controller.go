package controller

import (
	"net/http"
	"simplegoapp/app/controller/url"
	"simplegoapp/domain/example"
)

type ExampleController struct {
	ExampleService example.ExampleService
}

func (this ExampleController) GET(w http.ResponseWriter, req *http.Request) {
	testParams := struct {
		P1   int      "json:p1"
		List []string "json:list"
	}{}
	url.ParseParams(req, &testParams)

	this.ExampleService.Hello()

	x := exampleStruct{
		Test: "dumb",
	}
	url.Respond(w, x)
}

func (this ExampleController) POST(w http.ResponseWriter, req *http.Request) {
	this.ExampleService.Bye()
}

type exampleStruct struct {
	Test string "json: test2"
}
