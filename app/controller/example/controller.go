package controller

import (
	"net/http"

	"github.com/aghchan/simplegoapp/app/controller/url"
	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/pkg/logger"
)

type ExampleController struct {
	Logger         logger.Logger
	ExampleService example.Service
}

func (this ExampleController) GET(w http.ResponseWriter, req *http.Request) {
	testParams := struct {
		P1   int      "json:p1"
		List []string "json:list"
	}{}
	err := url.ParseParams(req, &testParams)
	if err != nil {
		this.Logger.Error(
			"Parsing params",
			"err", err,
		)

		url.InternalError(this.Logger, w, err)
	}

	this.ExampleService.Hello()

	resp := exampleStruct{
		Test: "dumb",
	}
	url.Respond(this.Logger, w, resp)
}

func (this ExampleController) POST(w http.ResponseWriter, req *http.Request) {
	sampleBody := struct {
		Field1 string "json: field1"
		Field2 []int  "json: field2"
	}{}

	err := url.ParseBody(req, &sampleBody)
	if err != nil {
		this.Logger.Error(
			"Parsing payload",
			"err", err,
		)

		url.InternalError(this.Logger, w, err)
	}

	this.ExampleService.Bye()
}

type exampleStruct struct {
	Test string "json: test2"
}
