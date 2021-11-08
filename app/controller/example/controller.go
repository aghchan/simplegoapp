package controller

import (
	"net/http"

	"go.uber.org/zap"

	"github.com/aghchan/simplegoapp/app/controller/url"
	"github.com/aghchan/simplegoapp/domain/example"
)

type ExampleController struct {
	Logger         *zap.SugaredLogger
	ExampleService example.ExampleService
}

func (this ExampleController) GET(w http.ResponseWriter, req *http.Request) {
	testParams := struct {
		P1   int      "json:p1"
		List []string "json:list"
	}{}
	err := url.ParseParams(req, &testParams)
	if err != nil {
		this.Logger.Errorw(
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
		this.Logger.Errorw(
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
