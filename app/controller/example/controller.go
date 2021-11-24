package controller

import (
	"errors"

	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/pkg/http"
)

type ExampleController struct {
	http.Controller

	ExampleService example.Service
}

func (this ExampleController) GET(w http.ResponseWriter, req *http.Request) {
	testParams := struct {
		P1   int      "json:p1"
		List []string "json:list"
	}{}
	err := http.ParseParams(req, &testParams)
	if err != nil {
		this.Logger.Error(
			"Parsing params",
			"err", err,
		)

		http.InternalError(this.Logger, w, err)
	}

	this.ExampleService.Hello()

	resp := exampleStruct{
		Test: "dumb",
	}
	http.Respond(this.Logger, w, resp)
}

type exampleStruct struct {
	Test string "json: test2"
}

func (this ExampleController) POST(w http.ResponseWriter, req *http.Request) {
	sampleBody := struct {
		Field1 string "json: field1"
		Field2 []int  "json: field2"
	}{}

	err := http.ParseBody(req, &sampleBody)
	if err != nil {
		this.Logger.Error(
			"Parsing payload",
			"err", err,
		)

		http.InternalError(this.Logger, w, err)
	}

	this.ExampleService.Bye()
}

type SocketController struct {
	http.Controller
}

func (this SocketController) SOCKET(w http.ResponseWriter, req *http.Request) {
	conn, out, err := http.Upgrade(w, req)
	if err != nil {
		this.Logger.Error(
			"Upgrading to socket",
			"error", err,
		)

		return
	}
	defer conn.Close()
	defer close(out)

	for {
		message, err := http.ReadSocket(conn)
		if err != nil {
			if errors.Is(err, http.ErrUnexpectedSocketClose) {
				this.Logger.Error(
					"Reading from socket",
					"err", err.Error(),
				)
			}

			break
		}

		out <- message
	}
}
