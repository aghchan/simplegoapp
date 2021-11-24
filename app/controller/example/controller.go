package controller

import (
	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/pkg/http"
)

type ExampleController struct {
	http.Controller

	ExampleService example.Service
}

func (this ExampleController) GET(w http.ResponseWriter, req *http.Request) {
	testParams := struct {
		P1   int      `json:"p1"`
		List []string `json:"list"`
	}{}

	err := this.ParseParams(req, &testParams)
	if err != nil {
		this.InternalError(w, err)
	}

	this.ExampleService.Hello()

	resp := exampleStruct{
		Test: "dumb",
	}
	this.Respond(w, resp)
}

type exampleStruct struct {
	Test string `json:"test2"`
}

func (this ExampleController) POST(w http.ResponseWriter, req *http.Request) {
	sampleBody := struct {
		Field1 string `json:"field1"`
		Field2 []int  `json:"field2"`
	}{}

	err := this.ParseBody(req, &sampleBody)
	if err != nil {
		this.InternalError(w, err)
	}

	this.ExampleService.Bye()
}

type SocketController struct {
	http.Controller
}

func (this SocketController) SOCKET(w http.ResponseWriter, req *http.Request) {
	conn, out, err := this.Upgrade(w, req)
	if err != nil {
		return
	}
	defer conn.Close()
	defer close(out)

	for {
		_, err := this.ReadSocket(conn)
		if err != nil {
			break
		}

		this.SendMessage(out, struct {
			Field1 string `json:"testingSample"`
		}{Field1: "wooo"})
	}
}
